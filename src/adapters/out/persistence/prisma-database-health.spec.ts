import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../../../generated/prisma/client.js';
import { PrismaDatabaseHealth } from './prisma-database-health.js';

/** Un cliente de Prisma de mentira: solo sabe contestar `$queryRaw`, que es lo unico que la comprobacion usa. */
const clientThat = (queryRaw: () => Promise<unknown>): PrismaClient =>
  ({ $queryRaw: queryRaw }) as unknown as PrismaClient;

describe('PrismaDatabaseHealth', () => {
  it('says up when the query is answered', async () => {
    const health = new PrismaDatabaseHealth(clientThat(() => Promise.resolve([{ '?column?': 1 }])));

    expect(await health.check()).toBe('up');
  });

  it('says down when the query fails, without throwing', async () => {
    const health = new PrismaDatabaseHealth(clientThat(() => Promise.reject(new Error('refused'))));

    expect(await health.check()).toBe('down');
  });

  it('says down when the query never answers, as soon as the time limit passes', async () => {
    const hanging = new PrismaDatabaseHealth(
      clientThat(() => new Promise(() => undefined)),
      50,
    );

    const started = Date.now();
    const status = await hanging.check();

    expect(status).toBe('down');
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('does not wait for the time limit when the query answers first', async () => {
    const quick = new PrismaDatabaseHealth(
      clientThat(() => Promise.resolve([])),
      10_000,
    );

    const started = Date.now();
    await quick.check();

    expect(Date.now() - started).toBeLessThan(1000);
  });
});
