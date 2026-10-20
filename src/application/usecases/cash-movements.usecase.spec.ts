import { describe, expect, it } from 'vitest';
import { ForbiddenError, NoMembershipError } from '../../domain/model/people-errors.js';
import { OperationIdReusedError } from '../../domain/model/purchase-errors.js';
import { ShiftClosedError } from '../../domain/model/shift-errors.js';
import { ValidationFailedError } from '../../domain/model/validation.js';
import { UserInactiveError } from '../../domain/ports/in/authenticate.js';
import { FakeCash } from '../../../test/support/fake-cash.js';
import { FakePeople, fakeUnitOfWork } from '../../../test/support/fake-people.js';
import { FakePurchasing } from '../../../test/support/fake-purchasing.js';
import {
  ACTOR_ID,
  BUSINESS_ID,
  loneSession,
  memberSession,
} from '../../../test/support/sessions.js';
import { CashMovementsUseCase } from './cash-movements.usecase.js';

const SHIFT = '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e';
const DEVICE = '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f';
const OP = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const OP_2 = '5f6a7b8c-9d0e-4f1a-8b2c-4d5e6f7a8b9c';
const UNKNOWN = '99999999-9999-4999-8999-999999999999';

const setup = async ({ closed = false } = {}) => {
  const cash = new FakeCash();
  await cash.shifts.open({
    id: SHIFT,
    deviceId: DEVICE,
    userId: ACTOR_ID,
    openedAt: new Date('2026-10-18T10:00:00.000Z'),
    openingAmount: 50_000,
  });
  if (closed) {
    await cash.shifts.close(SHIFT, {
      closedAt: new Date('2026-10-18T14:00:00.000Z'),
      closedByUserId: ACTOR_ID,
      countedAmount: 50_000,
    });
  }
  const purchasing = new FakePurchasing();
  const work = fakeUnitOfWork(new FakePeople(), 'Tienda', undefined, purchasing, undefined, cash);
  return { cash, purchasing, work, useCase: new CashMovementsUseCase(work) };
};

const movement = (change: Record<string, unknown> = {}) => ({
  operationId: OP,
  shiftId: SHIFT,
  direction: 'out',
  amount: 20_000,
  reason: 'Pago al proveedor de bebidas',
  ...change,
});

const codes = (failure: unknown) =>
  (failure as ValidationFailedError).errors.map((e) => `${e.pointer}:${e.code}`);

describe('CashMovementsUseCase', () => {
  it('moves cash in or out of an open shift, with its reason', async () => {
    const { cash, useCase } = await setup();

    const out = await useCase.create(memberSession('admin'), movement());
    const into = await useCase.create(
      memberSession('owner'),
      movement({ operationId: OP_2, direction: 'in', amount: 5_000, reason: 'Cambio' }),
    );

    expect(out.replayed).toBe(false);
    expect(out.movement).toMatchObject({
      operationId: OP,
      shiftId: SHIFT,
      direction: 'out',
      amount: 20_000,
      reason: 'Pago al proveedor de bebidas',
    });
    expect(into.movement.direction).toBe('in');
    expect(cash.movements.records).toHaveLength(2);
  });

  it('works inside the business of the person and records the operation as a cash movement', async () => {
    const { purchasing, work, useCase } = await setup();

    await useCase.create(memberSession('admin'), movement());

    expect(work.openedFor).toEqual([BUSINESS_ID]);
    expect(purchasing.operations.claims.get(OP)?.request).toMatchObject({
      kind: 'cash_movement',
      userId: ACTOR_ID,
    });
  });

  it('is for the management: a cashier can not move cash outside a sale', async () => {
    const { cash, useCase } = await setup();

    await expect(useCase.create(memberSession('cashier'), movement())).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(cash.movements.records).toEqual([]);
  });

  it('refuses a cashier before looking at what they sent', async () => {
    const { useCase } = await setup();

    await expect(useCase.create(memberSession('cashier'), { basura: 1 })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('answers a repeated movement with the same one and moves nothing twice', async () => {
    const { cash, useCase } = await setup();
    const first = await useCase.create(memberSession('admin'), movement());

    const again = await useCase.create(memberSession('admin'), movement());

    expect(again.replayed).toBe(true);
    expect(again.movement).toEqual(first.movement);
    expect(cash.movements.records).toHaveLength(1);
  });

  it('refuses the same operation id with another body', async () => {
    const { cash, useCase } = await setup();
    await useCase.create(memberSession('admin'), movement());

    await expect(
      useCase.create(memberSession('admin'), movement({ amount: 1 })),
    ).rejects.toBeInstanceOf(OperationIdReusedError);
    expect(cash.movements.records[0]?.amount).toBe(20_000);
  });

  it('does not touch the cash of a shift that is already closed: its count was made', async () => {
    const { cash, useCase } = await setup({ closed: true });

    await expect(useCase.create(memberSession('admin'), movement())).rejects.toBeInstanceOf(
      ShiftClosedError,
    );
    expect(cash.movements.records).toEqual([]);
  });

  it('says the shift does not exist, with the field, when it is not one of this business', async () => {
    const { cash, useCase } = await setup();

    const failure = await useCase
      .create(memberSession('admin'), movement({ shiftId: UNKNOWN }))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ValidationFailedError);
    expect(codes(failure)).toEqual(['/shiftId:unknown-shift']);
    expect(cash.movements.records).toEqual([]);
  });

  it('reports every problem and moves nothing', async () => {
    const { cash, useCase } = await setup();

    const failure = await useCase
      .create(memberSession('admin'), { direction: 'sale', amount: 0, extra: 1 })
      .catch((error: unknown) => error);

    expect(codes(failure)).toEqual([
      '/extra:unknown-field',
      '/operationId:required',
      '/shiftId:required',
      '/direction:invalid-value',
      '/amount:out-of-range',
      '/reason:required',
    ]);
    expect(cash.movements.records).toEqual([]);
  });

  it('refuses a person with no business and a person who was let go', async () => {
    const { useCase } = await setup();

    await expect(useCase.create(loneSession(), movement())).rejects.toBeInstanceOf(
      NoMembershipError,
    );
    await expect(
      useCase.create(memberSession('owner', { active: false }), movement()),
    ).rejects.toBeInstanceOf(UserInactiveError);
  });
});
