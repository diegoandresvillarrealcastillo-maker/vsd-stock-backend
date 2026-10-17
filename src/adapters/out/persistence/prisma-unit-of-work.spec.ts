import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../../../generated/prisma/client.js';
import { PrismaUnitOfWork } from './prisma-unit-of-work.js';

const BUSINESS = '22222222-2222-4222-8222-222222222222';

/** Un cliente de Prisma de mentira: cada transaccion corre el trabajo contra un `tx` que solo sabe fijar el negocio. */
function fakeClient(failures: Error[]): { client: PrismaClient; transactions: number } {
  const state = { transactions: 0 };
  const tx = { $queryRaw: () => Promise.resolve([]) };
  const client = {
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => {
      state.transactions += 1;
      const failure = failures.shift();
      // El conflicto se descubre al final (al confirmar): el trabajo ya corrio y la base lo deshace.
      const result = await work(tx);
      if (failure !== undefined) throw failure;
      return result;
    },
  } as unknown as PrismaClient;
  return {
    client,
    get transactions() {
      return state.transactions;
    },
  };
}

const conflict = () => Object.assign(new Error('conflicto'), { code: 'P2034' });

describe('the unit of work against Prisma', () => {
  it('runs the work in one transaction when nothing conflicts', async () => {
    const fake = fakeClient([]);
    const unitOfWork = new PrismaUnitOfWork(fake.client);

    const result = await unitOfWork.transaction(BUSINESS, () => Promise.resolve('listo'));

    expect(result).toBe('listo');
    expect(fake.transactions).toBe(1);
  });

  it('runs the whole transaction again when it loses against another one, so nothing is half done', async () => {
    const fake = fakeClient([conflict(), conflict()]);
    const unitOfWork = new PrismaUnitOfWork(fake.client);
    let runs = 0;

    const result = await unitOfWork.transaction(BUSINESS, () => {
      runs += 1;
      return Promise.resolve(`intento ${runs}`);
    });

    expect(fake.transactions).toBe(3);
    expect(runs).toBe(3);
    expect(result).toBe('intento 3');
  });

  it('gives up with the conflict after three transactions', async () => {
    const fake = fakeClient([conflict(), conflict(), conflict(), conflict()]);
    const unitOfWork = new PrismaUnitOfWork(fake.client);

    const failure = await unitOfWork
      .transaction(BUSINESS, () => Promise.resolve('nunca'))
      .catch((error: unknown) => error);

    expect(fake.transactions).toBe(3);
    expect(failure).toMatchObject({ code: 'P2034' });
  });

  it('does not retry an error that is not a conflict', async () => {
    const fake = fakeClient([new Error('boom')]);
    const unitOfWork = new PrismaUnitOfWork(fake.client);

    const failure = await unitOfWork
      .transaction(BUSINESS, () => Promise.resolve('nunca'))
      .catch((error: unknown) => error);

    expect(fake.transactions).toBe(1);
    expect(failure).toMatchObject({ message: 'boom' });
  });

  it('does not ask the database anything for an identifier that is not a business', async () => {
    const fake = fakeClient([]);
    const unitOfWork = new PrismaUnitOfWork(fake.client);

    await expect(
      unitOfWork.transaction('no-es-uuid', () => Promise.resolve('nunca')),
    ).rejects.toBeInstanceOf(RangeError);
    expect(fake.transactions).toBe(0);
  });
});
