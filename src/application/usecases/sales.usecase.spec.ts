import { describe, expect, it } from 'vitest';
import { NoMembershipError } from '../../domain/model/people-errors.js';
import { OperationIdReusedError } from '../../domain/model/purchase-errors.js';
import { ValidationFailedError } from '../../domain/model/validation.js';
import { UserInactiveError } from '../../domain/ports/in/authenticate.js';
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

const NOW = new Date('2026-10-18T15:00:00.000Z');
const clock: Clock = { now: () => NOW };

const DEVICE = '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f';
const SHIFT = '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e';
const OP = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const OP_2 = '5f6a7b8c-9d0e-4f1a-8b2c-4d5e6f7a8b9c';
const OTHER_USER = '77777777-7777-4777-8777-777777777777';
const UNKNOWN = '99999999-9999-4999-8999-999999999999';
const OTHER_SHIFT = '88888888-8888-4888-8888-888888888888';
const SHIFT_OF_OTHER = '66666666-6666-4666-8666-666666666666';

const COLA = 'f0000000-0000-4000-8000-0000000000a1'; // 3.500 con IVA general, por unidad
const BREAD = 'f0000000-0000-4000-8000-0000000000a2'; // 4.000 sin IVA, por kilo
const OLD = 'f0000000-0000-4000-8000-0000000000a3'; // archivado

const product = (id: string, overrides: Partial<ProductRecord>): ProductRecord => ({
  id,
  name: 'Producto',
  sku: id.slice(-2),
  barcode: null,
  unit: 'unit',
  unitPrice: 1000,
  taxRateBp: 0,
  active: true,
  categoryId: null,
  minStockMilli: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...overrides,
});

const setup = async ({ closedAt, revokedAt }: { closedAt?: Date; revokedAt?: Date } = {}) => {
  const catalog = new FakeCatalog();
  catalog.products.push(
    product(COLA, { name: 'Gaseosa', unitPrice: 3500, taxRateBp: 1900 }),
    product(BREAD, { name: 'Pan', unit: 'kilogram', unitPrice: 4000, taxRateBp: 0 }),
    product(OLD, { name: 'Viejo', active: false, unitPrice: 1000 }),
  );
  const devices = new FakeDevices();
  await devices.register({ id: DEVICE, name: null }, ACTOR_ID); // recibe el codigo AA
  if (revokedAt !== undefined) await devices.revoke(DEVICE, revokedAt);
  const cash = new FakeCash();
  await cash.shifts.open({
    id: SHIFT,
    deviceId: DEVICE,
    userId: ACTOR_ID,
    openedAt: new Date('2026-10-18T10:00:00.000Z'),
    openingAmount: 50_000,
  });
  if (closedAt !== undefined) {
    await cash.shifts.close(SHIFT, { closedAt, closedByUserId: ACTOR_ID, countedAmount: 50_000 });
  }
  const purchasing = new FakePurchasing();
  // Hay de sobra de todo: la prueba que quiere quedarse sin existencia la fija a mano.
  purchasing.stock.balances.set(COLA, 100_000);
  purchasing.stock.balances.set(BREAD, 100_000);
  purchasing.stock.balances.set(OLD, 100_000);
  const work = fakeUnitOfWork(new FakePeople(), 'Tienda', catalog, purchasing, devices, cash);
  return { catalog, devices, cash, purchasing, work, useCase: new SalesUseCase(work, clock) };
};

/** 2 gaseosas (7.000) y 1,5 kg de pan (6.000): 13.000, pagados con 10.000 en efectivo y 3.000 con tarjeta. */
const body = (change: Record<string, unknown> = {}) => ({
  operationId: OP,
  shiftId: SHIFT,
  folio: 'AA-000142',
  total: 13_000,
  lines: [
    { productId: COLA, quantityMilli: 2_000, unitPrice: 3_500, discount: 0, taxRateBp: 1900 },
    { productId: BREAD, quantityMilli: 1_500, unitPrice: 4_000, discount: 0, taxRateBp: 0 },
  ],
  payments: [
    { method: 'cash', amount: 10_000 },
    { method: 'card', amount: 3_000, reference: 'aprobacion 77123' },
  ],
  deviceTime: '2026-10-18T14:59:50.000Z',
  clockOffsetMs: 4_000,
  ...change,
});

const codes = (failure: unknown) =>
  (failure as ValidationFailedError).errors.map((e) => `${e.pointer}:${e.code}`);

const failureOf = async (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );

describe('SalesUseCase', () => {
  describe('registering a sale', () => {
    it('keeps who sold what, how it was paid and the total, which the server calculates again', async () => {
      const { useCase } = await setup();

      const { sale, replayed } = await useCase.create(memberSession('cashier'), body());

      expect(replayed).toBe(false);
      expect(sale).toMatchObject({
        operationId: OP,
        shiftId: SHIFT,
        deviceId: DEVICE,
        userId: ACTOR_ID,
        folio: 'AA-000142',
        folioReported: 'AA-000142',
        folioConflict: false,
        total: 13_000,
        needsAdjustment: false,
        flags: [],
        lines: [
          { productId: COLA, quantityMilli: 2_000, unitPrice: 3_500, discount: 0, taxRateBp: 1900 },
          { productId: BREAD, quantityMilli: 1_500, unitPrice: 4_000, discount: 0, taxRateBp: 0 },
        ],
        payments: [
          { method: 'cash', amount: 10_000, reference: null },
          { method: 'card', amount: 3_000, reference: 'aprobacion 77123' },
        ],
      });
      expect(sale.summary).toEqual({
        total: 13_000,
        base: 11_882,
        tax: 1_118,
        byRate: [
          { rateBp: 0, total: 6_000, base: 6_000, tax: 0 },
          { rateBp: 1900, total: 7_000, base: 5_882, tax: 1_118 },
        ],
      });
    });

    it('can be done by anyone in the business, because selling is what a cashier is for', async () => {
      for (const role of ['cashier', 'admin', 'owner'] as const) {
        const { useCase } = await setup();
        const { sale } = await useCase.create(memberSession(role), body());
        expect(sale.userId).toBe(ACTOR_ID);
      }
    });

    it('works inside the business of the person and records the operation as a sale of the device of the shift', async () => {
      const { purchasing, work, useCase } = await setup();

      await useCase.create(memberSession('cashier'), body());

      expect(work.openedFor).toEqual([BUSINESS_ID]);
      expect(purchasing.operations.claims.get(OP)?.request).toMatchObject({
        kind: 'sale',
        userId: ACTOR_ID,
        deviceId: DEVICE,
      });
    });

    it('stores the time of the clock of the device, corrected with the measure it brought (ADR 0016)', async () => {
      const { useCase } = await setup();

      const { sale } = await useCase.create(memberSession('cashier'), body());

      // 14:59:50 en el reloj del dispositivo, que atrasa 4 s: 14:59:54 de verdad.
      expect(sale.occurredAt).toEqual(new Date('2026-10-18T14:59:54.000Z'));
      expect(sale.receivedAt).toEqual(NOW);
      expect(sale.timeFlags).toEqual([]);
    });

    it('does not reject a sale whose clock makes no sense: it keeps it and the time is flagged', async () => {
      const { useCase } = await setup();

      const { sale } = await useCase.create(
        memberSession('cashier'),
        body({ deviceTime: 'ayer por la tarde', clockOffsetMs: null }),
      );

      expect(sale.occurredAt).toEqual(NOW);
      expect(sale.timeFlags).toContain('unreadable');
    });

    it('respects the price and the tax rate that the customer saw, and says so when they are not the ones of the catalog', async () => {
      const { useCase } = await setup();
      const cheaper = {
        productId: COLA,
        quantityMilli: 2_000,
        unitPrice: 3_000,
        discount: 0,
        taxRateBp: 1900,
      };

      const { sale } = await useCase.create(
        memberSession('cashier'),
        body({
          total: 12_000,
          lines: [cheaper, body().lines[1]],
          payments: [{ method: 'cash', amount: 12_000 }],
        }),
      );

      expect(sale.lines[0]).toMatchObject({ unitPrice: 3_000 });
      expect(sale.total).toBe(12_000);
      expect(sale.flags).toEqual(['price-differs']);
    });

    it('says a different tax rate is not the one of the catalog either', async () => {
      const { useCase } = await setup();
      const line = { ...body().lines[0], taxRateBp: 500 };

      const { sale } = await useCase.create(
        memberSession('cashier'),
        body({ lines: [line, body().lines[1]] }),
      );

      expect(sale.flags).toEqual(['price-differs']);
      expect(sale.lines[0]?.taxRateBp).toBe(500);
    });

    it('keeps the total it calculated when the device charged another, and says so', async () => {
      const { useCase } = await setup();

      const { sale } = await useCase.create(memberSession('cashier'), body({ total: 12_990 }));

      expect(sale.total).toBe(13_000);
      expect(sale.flags).toEqual(['total-differs']);
    });

    it('keeps the payments as they came when they do not add up to the total, and says so', async () => {
      const { useCase } = await setup();

      const { sale } = await useCase.create(
        memberSession('cashier'),
        body({ payments: [{ method: 'cash', amount: 12_000 }] }),
      );

      expect(sale.payments).toEqual([{ method: 'cash', amount: 12_000, reference: null }]);
      expect(sale.flags).toEqual(['payment-mismatch']);
    });

    it('splits the tax of what was really charged: the discount of a line is taken into account', async () => {
      const { useCase } = await setup();
      const discounted = { ...body().lines[0], discount: 700 };

      const { sale } = await useCase.create(
        memberSession('cashier'),
        body({
          total: 12_300,
          lines: [discounted, body().lines[1]],
          payments: [{ method: 'cash', amount: 12_300 }],
        }),
      );

      expect(sale.total).toBe(12_300);
      expect(sale.summary).toEqual({
        total: 12_300,
        base: 11_294,
        tax: 1_006,
        byRate: [
          { rateBp: 0, total: 6_000, base: 6_000, tax: 0 },
          { rateBp: 1900, total: 6_300, base: 5_294, tax: 1_006 },
        ],
      });
    });

    it('accepts a product that was archived after the device sold it', async () => {
      const { useCase } = await setup();
      const line = {
        productId: OLD,
        quantityMilli: 1_000,
        unitPrice: 1_000,
        discount: 0,
        taxRateBp: 0,
      };

      const { sale } = await useCase.create(
        memberSession('cashier'),
        body({ total: 1_000, lines: [line], payments: [{ method: 'cash', amount: 1_000 }] }),
      );

      expect(sale.lines).toHaveLength(1);
      expect(sale.flags).toEqual([]);
    });

    it('accepts a sale that arrives after its shift was closed, and says it is late', async () => {
      const { useCase } = await setup({ closedAt: new Date('2026-10-18T14:00:00.000Z') });

      const { sale } = await useCase.create(memberSession('cashier'), body());

      expect(sale.flags).toEqual(['late-shift']);
    });

    it('does not call late a sale that happened before the shift was closed, however late it arrives', async () => {
      const { useCase } = await setup({ closedAt: new Date('2026-10-18T14:59:59.000Z') });

      const { sale } = await useCase.create(memberSession('cashier'), body());

      expect(sale.flags).toEqual([]);
    });

    it('accepts a sale made by a device after it was revoked, and says so', async () => {
      const { useCase } = await setup({ revokedAt: new Date('2026-10-18T12:00:00.000Z') });

      const { sale } = await useCase.create(memberSession('cashier'), body());

      expect(sale.flags).toEqual(['revoked-device']);
    });

    it('does not mind a device that was revoked after the sale', async () => {
      const { useCase } = await setup({ revokedAt: new Date('2026-10-18T14:59:55.000Z') });

      const { sale } = await useCase.create(memberSession('cashier'), body());

      expect(sale.flags).toEqual([]);
    });

    it('accepts a folio of another device and says so', async () => {
      const { useCase } = await setup();

      const { sale } = await useCase.create(memberSession('cashier'), body({ folio: 'AB-000142' }));

      expect(sale.flags).toEqual(['folio-device']);
      expect(sale.folio).toBe('AB-000142');
    });

    it('lists every flag it finds, in the same order', async () => {
      const { useCase } = await setup({
        closedAt: new Date('2026-10-18T14:00:00.000Z'),
        revokedAt: new Date('2026-10-18T12:00:00.000Z'),
      });
      const cheaper = { ...body().lines[0], unitPrice: 3_000 };

      const { sale } = await useCase.create(
        memberSession('cashier'),
        body({ folio: 'AB-000142', total: 1, lines: [cheaper, body().lines[1]] }),
      );

      expect(sale.flags).toEqual([
        'price-differs',
        'total-differs',
        'payment-mismatch',
        'late-shift',
        'revoked-device',
        'folio-device',
      ]);
    });

    it('accepts a folio that is already another sale: it keeps the sale under another folio and marks the conflict', async () => {
      const { useCase } = await setup();
      const first = await useCase.create(memberSession('cashier'), body());

      const second = await useCase.create(memberSession('cashier'), body({ operationId: OP_2 }));

      expect(first.sale.folioConflict).toBe(false);
      expect(second.sale).toMatchObject({
        folio: 'AA-000142~5f6a7b8c',
        folioReported: 'AA-000142',
        folioConflict: true,
      });
    });

    it('accepts a sale of nothing paid with nothing', async () => {
      const { useCase } = await setup();
      const gift = { ...body().lines[0], discount: 7_000 };

      const { sale } = await useCase.create(
        memberSession('cashier'),
        body({ total: 0, lines: [gift], payments: [] }),
      );

      expect(sale.total).toBe(0);
      expect(sale.flags).toEqual([]);
    });
  });

  describe('the stock', () => {
    it('takes out what was sold, one movement per product, in the order of the products, as a sale', async () => {
      const { purchasing, useCase } = await setup();

      await useCase.create(memberSession('cashier'), body());

      expect(purchasing.stock.applied).toEqual([
        {
          operationId: OP,
          changes: [
            { productId: COLA, delta: -2_000, reason: 'sale', note: null },
            { productId: BREAD, delta: -1_500, reason: 'sale', note: null },
          ],
        },
      ]);
    });

    it('adds up the lines of the same product into one movement', async () => {
      const { purchasing, useCase } = await setup();
      const cola = body().lines[0];

      await useCase.create(
        memberSession('cashier'),
        body({
          total: 14_000,
          lines: [cola, cola],
          payments: [{ method: 'cash', amount: 14_000 }],
        }),
      );

      expect(purchasing.stock.applied[0]?.changes).toEqual([
        { productId: COLA, delta: -4_000, reason: 'sale', note: null },
      ]);
    });

    it('does not ask for adjustment while there is enough, nor when it runs out exactly', async () => {
      const { purchasing, useCase } = await setup();
      purchasing.stock.balances.set(COLA, 2_000);
      purchasing.stock.balances.set(BREAD, 5_000);

      const { sale } = await useCase.create(memberSession('cashier'), body());

      expect(purchasing.stock.balances.get(COLA)).toBe(0);
      expect(sale.needsAdjustment).toBe(false);
    });

    it('accepts a sale of what the system believed it did not have, and marks it as needing adjustment', async () => {
      const { purchasing, useCase } = await setup();
      purchasing.stock.balances.set(COLA, 1_000);
      purchasing.stock.balances.set(BREAD, 5_000);

      const { sale } = await useCase.create(memberSession('cashier'), body());

      expect(sale.needsAdjustment).toBe(true);
      expect(purchasing.stock.balances.get(COLA)).toBe(-1_000);
    });

    it('asks for adjustment for a product that was already below zero, even if the rest is fine', async () => {
      const { purchasing, useCase } = await setup();
      purchasing.stock.balances.set(COLA, 5_000);
      purchasing.stock.balances.set(BREAD, 500);

      const { sale } = await useCase.create(memberSession('cashier'), body());

      expect(sale.needsAdjustment).toBe(true);
    });
  });

  describe('the shift', () => {
    it('is locked in shared mode once, after the stock was taken out, so closing it waits for the sale', async () => {
      const { cash, purchasing, useCase } = await setup();
      const stockWhenLocked: number[] = [];
      const lock = cash.shifts.lockShared.bind(cash.shifts);
      cash.shifts.lockShared = (id) => {
        stockWhenLocked.push(purchasing.stock.applied.length);
        return lock(id);
      };

      await useCase.create(memberSession('cashier'), body());

      expect(cash.shifts.locked).toEqual([SHIFT]);
      expect(stockWhenLocked).toEqual([1]);
    });

    it('is read again once it is locked, because it may have been closed while the sale was being written', async () => {
      const { cash, useCase } = await setup();
      const lock = cash.shifts.lockShared.bind(cash.shifts);
      // La peticion de cierre confirmo justo despues de que se leyo el turno y antes de que se bloqueara.
      cash.shifts.lockShared = async (id) => {
        const open = await lock(id);
        return open === null ? null : { ...open, closedAt: new Date('2026-10-18T14:00:00.000Z') };
      };

      const { sale } = await useCase.create(memberSession('cashier'), body());

      expect(sale.flags).toEqual(['late-shift']);
    });

    it('has to exist and be the shift of the person who sells', async () => {
      const { purchasing, cash, useCase } = await setup();
      await cash.shifts.open({
        id: SHIFT_OF_OTHER,
        deviceId: DEVICE,
        userId: OTHER_USER,
        openedAt: new Date('2026-10-18T10:00:00.000Z'),
        openingAmount: 0,
      });

      for (const shiftId of [OTHER_SHIFT, SHIFT_OF_OTHER]) {
        const failure = await failureOf(
          useCase.create(memberSession('cashier'), body({ shiftId })),
        );
        expect(failure).toBeInstanceOf(ValidationFailedError);
        expect(codes(failure)).toEqual(['/shiftId:unknown-shift']);
      }
      expect(purchasing.operations.claims.size).toBe(0);
      expect(purchasing.stock.applied).toEqual([]);
    });
  });

  describe('the products', () => {
    it('have to exist in the business, and every one that does not is named', async () => {
      const { purchasing, useCase } = await setup();
      const stranger = { ...body().lines[0], productId: UNKNOWN };

      const failure = await failureOf(
        useCase.create(
          memberSession('cashier'),
          body({ lines: [stranger, body().lines[1], stranger] }),
        ),
      );

      expect(codes(failure)).toEqual([
        '/lines/0/productId:unknown-product',
        '/lines/2/productId:unknown-product',
      ]);
      expect(purchasing.operations.claims.size).toBe(0);
      expect(purchasing.stock.applied).toEqual([]);
    });

    it('cannot be sold in fractions when their unit is counted whole', async () => {
      const { useCase } = await setup();
      const half = { ...body().lines[0], quantityMilli: 1_500 };

      const failure = await failureOf(
        useCase.create(memberSession('cashier'), body({ lines: [half, body().lines[1]] })),
      );

      expect(codes(failure)).toEqual(['/lines/0/quantityMilli:not-whole']);
    });

    it('can be sold in fractions when their unit allows it', async () => {
      const { useCase } = await setup();

      const { sale } = await useCase.create(memberSession('cashier'), body());

      expect(sale.lines[1]?.quantityMilli).toBe(1_500);
    });
  });

  describe('repeating the same operation', () => {
    it('answers with the sale that was made, writes nothing else and marks it as repeated', async () => {
      const { cash, purchasing, useCase } = await setup();
      const first = await useCase.create(memberSession('cashier'), body());

      const again = await useCase.create(memberSession('cashier'), body());

      expect(again.replayed).toBe(true);
      expect(again.sale).toEqual(first.sale);
      expect(purchasing.stock.applied).toHaveLength(1);
      expect(cash.shifts.locked).toHaveLength(1);
    });

    it('is still the same sale when the device measured its clock again', async () => {
      const { useCase } = await setup();
      await useCase.create(memberSession('cashier'), body());

      const again = await useCase.create(memberSession('cashier'), body({ clockOffsetMs: 4_100 }));

      expect(again.replayed).toBe(true);
    });

    it('refuses the same operation with another sale', async () => {
      const { purchasing, useCase } = await setup();
      await useCase.create(memberSession('cashier'), body());

      const failure = await failureOf(useCase.create(memberSession('cashier'), body({ total: 1 })));

      expect(failure).toBeInstanceOf(OperationIdReusedError);
      expect(purchasing.stock.applied).toHaveLength(1);
    });

    it('refuses an operation that another kind of operation already used', async () => {
      const { purchasing, useCase } = await setup();
      purchasing.operations.claims.set(OP, {
        kind: 'purchase',
        fingerprint: '{}',
        userId: ACTOR_ID,
        request: { operationId: OP, kind: 'purchase', userId: ACTOR_ID, fingerprint: '{}' },
      });

      const failure = await failureOf(useCase.create(memberSession('cashier'), body()));

      expect(failure).toBeInstanceOf(OperationIdReusedError);
    });
  });

  describe('who can sell', () => {
    it('is not someone without a business, nor someone who was let go', async () => {
      const { useCase } = await setup();

      expect(await failureOf(useCase.create(loneSession(), body()))).toBeInstanceOf(
        NoMembershipError,
      );
      expect(
        await failureOf(useCase.create(memberSession('cashier', { active: false }), body())),
      ).toBeInstanceOf(UserInactiveError);
    });

    it('does not open the database for a body that is not a sale', async () => {
      const { work, useCase } = await setup();

      const failure = await failureOf(
        useCase.create(memberSession('cashier'), { operationId: OP, lines: [] }),
      );

      expect(failure).toBeInstanceOf(ValidationFailedError);
      expect(work.openedFor).toEqual([]);
    });
  });
});
