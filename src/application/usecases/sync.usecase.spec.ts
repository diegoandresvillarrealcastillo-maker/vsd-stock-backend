import { describe, expect, it } from 'vitest';
import { ForbiddenError, NoMembershipError } from '../../domain/model/people-errors.js';
import { OperationIdReusedError } from '../../domain/model/purchase-errors.js';
import type { Role } from '../../domain/model/role.js';
import { ShiftAlreadyOpenError } from '../../domain/model/shift-errors.js';
import { ValidationFailedError } from '../../domain/model/validation.js';
import { UserInactiveError, type Session } from '../../domain/ports/in/authenticate.js';
import type { Sales } from '../../domain/ports/in/sales.js';
import type { ProductRecord } from '../../domain/ports/out/catalog.js';
import type { Clock } from '../../domain/ports/out/clock.js';
import { FakeCash } from '../../../test/support/fake-cash.js';
import { FakeCatalog } from '../../../test/support/fake-catalog.js';
import { FakeDevices } from '../../../test/support/fake-devices.js';
import { FakePeople, fakeUnitOfWork } from '../../../test/support/fake-people.js';
import { FakePurchasing } from '../../../test/support/fake-purchasing.js';
import {
  ACTOR_ID,
  BUSINESS_ID,
  loneSession,
  memberSession,
} from '../../../test/support/sessions.js';
import { SalesUseCase } from './sales.usecase.js';
import { ShiftsUseCase } from './shifts.usecase.js';
import { SyncUseCase } from './sync.usecase.js';

const NOW = new Date('2026-10-18T15:00:00.000Z');
const clock: Clock = { now: () => NOW };

const DEVICE = '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f';
const SHIFT = '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e';
const COLA = 'f0000000-0000-4000-8000-0000000000a1';
const LUIS = '77777777-7777-4777-8777-777777777777';
const SHIFT_OF_LUIS = '3d4e5f6a-7b8c-4d9e-8f0a-2b3c4d5e6f7a';

const product: ProductRecord = {
  id: COLA,
  name: 'Gaseosa',
  sku: 'a1',
  barcode: null,
  unit: 'unit',
  unitPrice: 3500,
  taxRateBp: 1900,
  active: true,
  categoryId: null,
  minStockMilli: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const asPerson = (role: Role, userId: string): Session => {
  const base = memberSession(role);
  return { ...base, membership: { ...base.membership!, userId } };
};
const ana = memberSession('cashier');

const setup = async (sales?: (real: Sales) => Sales) => {
  const catalog = new FakeCatalog();
  catalog.products.push(product);
  const devices = new FakeDevices();
  await devices.register({ id: DEVICE, name: null }, ACTOR_ID);
  const purchasing = new FakePurchasing();
  purchasing.stock.balances.set(COLA, 100_000);
  const cash = new FakeCash();
  const work = fakeUnitOfWork(new FakePeople(), 'Tienda', catalog, purchasing, devices, cash);
  const realSales = new SalesUseCase(work, clock);
  const useCase = new SyncUseCase(
    new ShiftsUseCase(work, clock),
    sales === undefined ? realSales : sales(realSales),
    clock,
  );
  return { useCase, work, purchasing, cash };
};

let counter = 0;
const nextOperation = () => `0a1b2c3d-4e5f-4a6b-8c7d-${String(++counter).padStart(12, '0')}`;

const open = (change: Record<string, unknown> = {}) => ({
  kind: 'shift-open',
  body: {
    operationId: nextOperation(),
    shiftId: SHIFT,
    deviceId: DEVICE,
    openingAmount: 50_000,
    deviceTime: '2026-10-18T14:00:00.000Z',
    clockOffsetMs: 0,
    ...change,
  },
});
const sale = (change: Record<string, unknown> = {}) => ({
  kind: 'sale',
  body: {
    operationId: nextOperation(),
    shiftId: SHIFT,
    folio: `AA-${String(counter + 1).padStart(6, '0')}`,
    total: 7_000,
    lines: [
      { productId: COLA, quantityMilli: 2_000, unitPrice: 3_500, discount: 0, taxRateBp: 1900 },
    ],
    payments: [{ method: 'cash', amount: 7_000 }],
    deviceTime: '2026-10-18T14:30:00.000Z',
    clockOffsetMs: 0,
    ...change,
  },
});
const close = (shiftId = SHIFT, change: Record<string, unknown> = {}) => ({
  kind: 'shift-close',
  shiftId,
  body: {
    operationId: nextOperation(),
    countedAmount: 57_000,
    deviceTime: '2026-10-18T14:55:00.000Z',
    clockOffsetMs: 0,
    ...change,
  },
});

const failureOf = (outcome: { type: string; error?: unknown }): unknown =>
  outcome.type === 'failed' ? outcome.error : undefined;

describe('SyncUseCase', () => {
  describe('a batch', () => {
    it('applies each operation, in order: a shift that is opened, a sale in it and the closing', async () => {
      const { useCase, cash, purchasing } = await setup();

      const { results, serverTime } = await useCase.apply(ana, {
        operations: [open(), sale(), close()],
      });

      expect(serverTime).toEqual(NOW);
      expect(results.map((result) => [result.kind, result.outcome.type])).toEqual([
        ['shift-open', 'applied'],
        ['sale', 'applied'],
        ['shift-close', 'applied'],
      ]);
      expect(
        results.map((result) =>
          result.outcome.type === 'applied' ? result.outcome.replayed : null,
        ),
      ).toEqual([false, false, false]);
      expect(cash.shifts.records).toHaveLength(1);
      expect(cash.shifts.records[0]?.closedAt).not.toBeNull();
      expect(purchasing.stock.balances.get(COLA)).toBe(98_000);
    });

    it('gives back, for each one, what the single route would have given: the shift, the sale', async () => {
      const { useCase } = await setup();

      const { results } = await useCase.apply(ana, { operations: [open(), sale(), close()] });

      const values = results.map((result) =>
        result.outcome.type === 'applied' ? (result.outcome.value as Record<string, unknown>) : {},
      );
      expect(values[0]).toMatchObject({ id: SHIFT, openingAmount: 50_000 });
      expect(values[1]).toMatchObject({ total: 7_000, shiftId: SHIFT });
      expect(values[2]).toMatchObject({ id: SHIFT, countedAmount: 57_000 });
    });

    it('repeats safely: sending it again answers that everything was already applied, and writes nothing twice', async () => {
      const { useCase, purchasing, cash } = await setup();
      const batch = { operations: [open(), sale(), close()] };
      await useCase.apply(ana, batch);

      const again = await useCase.apply(ana, batch);

      expect(
        again.results.map((result) =>
          result.outcome.type === 'applied' ? result.outcome.replayed : null,
        ),
      ).toEqual([true, true, true]);
      expect(purchasing.stock.balances.get(COLA)).toBe(98_000);
      expect(cash.shifts.records).toHaveLength(1);
    });

    it('does not let the operation that fails spoil the others: each one stands on its own', async () => {
      const { useCase, purchasing } = await setup();
      const stranger = sale({
        lines: [
          {
            productId: '99999999-9999-4999-8999-999999999999',
            quantityMilli: 1_000,
            unitPrice: 1_000,
            discount: 0,
            taxRateBp: 0,
          },
        ],
      });

      const { results } = await useCase.apply(ana, {
        operations: [open(), stranger, sale(), close()],
      });

      expect(results.map((result) => result.outcome.type)).toEqual([
        'applied',
        'failed',
        'applied',
        'applied',
      ]);
      const error = failureOf(results[1]!.outcome);
      expect(error).toBeInstanceOf(ValidationFailedError);
      expect((error as ValidationFailedError).errors.map((e) => `${e.pointer}:${e.code}`)).toEqual([
        '/lines/0/productId:unknown-product',
      ]);
      // Solo se vendio la que sirvio.
      expect(purchasing.stock.balances.get(COLA)).toBe(98_000);
    });

    it('says which operation each result is for, also for the one that failed', async () => {
      const { useCase } = await setup();
      const first = open();
      const second = sale({ total: 'mucho' });

      const { results } = await useCase.apply(ana, { operations: [first, second] });

      expect(results.map((result) => result.operationId)).toEqual([
        first.body.operationId,
        second.body.operationId,
      ]);
    });

    it('says which kind of operation each result is for, also for the one that failed', async () => {
      const { useCase } = await setup();

      const { results } = await useCase.apply(ana, {
        operations: [open(), sale({ total: 'mucho' }), close()],
      });

      expect(results.map((result) => result.outcome.type)).toEqual([
        'applied',
        'failed',
        'applied',
      ]);
      expect(results.map((result) => result.kind)).toEqual(['shift-open', 'sale', 'shift-close']);
    });

    it('refuses the operation whose shift was refused, because the sale then has no shift', async () => {
      const { useCase } = await setup();
      await useCase.apply(ana, { operations: [open()] });

      const { results } = await useCase.apply(ana, {
        operations: [open({ shiftId: SHIFT_OF_LUIS }), sale({ shiftId: SHIFT_OF_LUIS })],
      });

      expect(failureOf(results[0]!.outcome)).toBeInstanceOf(ShiftAlreadyOpenError);
      const error = failureOf(results[1]!.outcome);
      expect((error as ValidationFailedError).errors.map((e) => `${e.pointer}:${e.code}`)).toEqual([
        '/shiftId:unknown-shift',
      ]);
    });

    it('refuses an operation id that was already used for something else', async () => {
      const { useCase } = await setup();
      const first = open();
      await useCase.apply(ana, { operations: [first] });

      const { results } = await useCase.apply(ana, {
        operations: [close(SHIFT, { operationId: first.body.operationId })],
      });

      expect(failureOf(results[0]!.outcome)).toBeInstanceOf(OperationIdReusedError);
    });

    it('answers for an operation that is not right, without taking the others down', async () => {
      const { useCase } = await setup();
      const unknown = nextOperation();
      const { results } = await useCase.apply(ana, {
        operations: [open(), { kind: 'void', body: { operationId: unknown } }, sale()],
      });

      expect(results.map((result) => result.outcome.type)).toEqual([
        'applied',
        'failed',
        'applied',
      ]);
      expect(results[1]?.kind).toBeNull();
      expect(results[1]?.operationId).toBe(unknown);
      const error = failureOf(results[1]!.outcome);
      expect((error as ValidationFailedError).errors.map((e) => `${e.pointer}:${e.code}`)).toEqual([
        '/kind:invalid-value',
      ]);
    });

    it('lets each operation answer to the rules of its own route: a cashier can not close the shift of somebody else', async () => {
      const { useCase } = await setup();
      const owner = asPerson('owner', LUIS);
      await useCase.apply(owner, { operations: [open({ shiftId: SHIFT_OF_LUIS })] });

      const { results } = await useCase.apply(ana, {
        operations: [close(SHIFT_OF_LUIS), open()],
      });

      expect(failureOf(results[0]!.outcome)).toBeInstanceOf(ForbiddenError);
      expect(results[1]?.outcome.type).toBe('applied');
    });

    it('hands over an error nobody expected as it is, so the API can say 500 for that operation alone', async () => {
      const { useCase } = await setup((real) => ({
        ...real,
        create: () => Promise.reject(new Error('se cayó la base')),
        list: real.list.bind(real),
        get: real.get.bind(real),
        review: real.review.bind(real),
        voidSale: real.voidSale.bind(real),
      }));

      const { results } = await useCase.apply(ana, { operations: [sale(), open()] });

      expect(failureOf(results[0]!.outcome)).toEqual(new Error('se cayó la base'));
      expect(results[1]?.outcome.type).toBe('applied');
    });
  });

  describe('the whole request', () => {
    it('wants a list of one to fifty operations, and applies nothing otherwise', async () => {
      const { useCase, cash } = await setup();

      const empty = await useCase.apply(ana, { operations: [] }).catch((error: unknown) => error);
      const tooMany = await useCase
        .apply(ana, { operations: Array.from({ length: 51 }, () => open()) })
        .catch((error: unknown) => error);
      const extra = await useCase
        .apply(ana, { operations: [open()], otra: 1 })
        .catch((error: unknown) => error);

      for (const failure of [empty, tooMany, extra]) {
        expect(failure).toBeInstanceOf(ValidationFailedError);
      }
      expect((empty as ValidationFailedError).errors.map((e) => `${e.pointer}:${e.code}`)).toEqual([
        '/operations:too-few',
      ]);
      expect(cash.shifts.records).toEqual([]);
    });

    it('is not for someone without a business nor for someone who was let go', async () => {
      const { useCase, cash } = await setup();
      const letGo = memberSession('owner');

      const lone = await useCase
        .apply(loneSession(), { operations: [open()] })
        .catch((error: unknown) => error);
      const inactive = await useCase
        .apply(
          { ...letGo, membership: { ...letGo.membership!, active: false } },
          { operations: [open()] },
        )
        .catch((error: unknown) => error);

      expect(lone).toBeInstanceOf(NoMembershipError);
      expect(inactive).toBeInstanceOf(UserInactiveError);
      expect(cash.shifts.records).toEqual([]);
    });

    it('works inside the business of the person', async () => {
      const { useCase, work } = await setup();

      await useCase.apply(ana, { operations: [open(), sale()] });

      expect(new Set(work.openedFor)).toEqual(new Set([BUSINESS_ID]));
    });
  });
});
