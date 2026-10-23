import { describe, expect, it } from 'vitest';
import { ForbiddenError, NoMembershipError } from '../../domain/model/people-errors.js';
import { OperationIdReusedError } from '../../domain/model/purchase-errors.js';
import type { Role } from '../../domain/model/role.js';
import { SaleNotFoundError, SaleVoidedError } from '../../domain/model/sale-errors.js';
import { ShiftRequiredError } from '../../domain/model/shift-errors.js';
import { ValidationFailedError } from '../../domain/model/validation.js';
import { UserInactiveError, type Session } from '../../domain/ports/in/authenticate.js';
import type { ProductRecord } from '../../domain/ports/out/catalog.js';
import type { Clock } from '../../domain/ports/out/clock.js';
import { FakeCash } from '../../../test/support/fake-cash.js';
import { FakeCatalog } from '../../../test/support/fake-catalog.js';
import { FakeDevices } from '../../../test/support/fake-devices.js';
import { FakePeople, fakeUnitOfWork } from '../../../test/support/fake-people.js';
import { FakePurchasing } from '../../../test/support/fake-purchasing.js';
import { FakeSales } from '../../../test/support/fake-sales.js';
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
const SHIFT_OF_LUIS = '3d4e5f6a-7b8c-4d9e-8f0a-2b3c4d5e6f7a';
const LUIS = '77777777-7777-4777-8777-777777777777';
const COLA = 'f0000000-0000-4000-8000-0000000000a1';
const BREAD = 'f0000000-0000-4000-8000-0000000000b2';
const UNKNOWN = '99999999-9999-4999-8999-999999999999';

const productOf = (id: string, sku: string, unit: ProductRecord['unit']): ProductRecord => ({
  id,
  name: sku,
  sku,
  barcode: null,
  unit,
  unitPrice: 3500,
  taxRateBp: 1900,
  taxKind: 'taxed',
  active: true,
  categoryId: null,
  minStockMilli: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

/** La misma sesion de un negocio, pero de otra persona. */
const asPerson = (role: Role, userId: string): Session => {
  const base = memberSession(role);
  return { ...base, membership: { ...base.membership!, userId } };
};
const ana = memberSession('cashier');
const luisAdmin = asPerson('admin', LUIS);
const owner = memberSession('owner');

const setup = async () => {
  const catalog = new FakeCatalog();
  catalog.products.push(productOf(COLA, 'COLA', 'unit'), productOf(BREAD, 'PAN', 'kilogram'));
  const devices = new FakeDevices();
  await devices.register({ id: DEVICE, name: null }, ACTOR_ID);
  const cash = new FakeCash();
  for (const [id, userId] of [
    [SHIFT, ACTOR_ID],
    [SHIFT_OF_LUIS, LUIS],
  ] as const) {
    await cash.shifts.open({
      id,
      deviceId: DEVICE,
      userId,
      openedAt: new Date('2026-10-18T10:00:00.000Z'),
      openingAmount: 0,
    });
  }
  const purchasing = new FakePurchasing();
  purchasing.stock.balances.set(COLA, 10_000);
  purchasing.stock.balances.set(BREAD, 10_000);
  const fakeSales = new FakeSales(purchasing.operations, cash.shifts);
  const work = fakeUnitOfWork(
    new FakePeople(),
    'Tienda',
    catalog,
    purchasing,
    devices,
    cash,
    fakeSales,
  );
  const useCase = new SalesUseCase(work, clock);
  return { useCase, work, purchasing, fakeSales, cash };
};
type Setup = Awaited<ReturnType<typeof setup>>;

let counter = 0;
const nextId = (prefix: string) =>
  `${prefix}-4e5f-4a6b-8c7d-${String(++counter).padStart(12, '0')}`;

/** Una venta de 2 gaseosas (en dos lineas) y 1,5 kg de pan: 13.000, 10.000 en efectivo y el resto con tarjeta. */
const sell = async (
  { useCase }: Setup,
  change: Record<string, unknown> = {},
  session: Session = ana,
  shiftId = SHIFT,
) => {
  const { sale } = await useCase.create(session, {
    operationId: nextId('0a1b2c3d'),
    shiftId,
    folio: `AA-${String(counter).padStart(6, '0')}`,
    total: 13_000,
    lines: [
      {
        productId: COLA,
        quantityMilli: 1_000,
        unitPrice: 3_500,
        discount: 0,
        taxRateBp: 1900,
        taxKind: 'taxed',
      },
      {
        productId: BREAD,
        quantityMilli: 1_500,
        unitPrice: 4_000,
        discount: 0,
        taxRateBp: 0,
        taxKind: 'exempt',
      },
      {
        productId: COLA,
        quantityMilli: 1_000,
        unitPrice: 3_500,
        discount: 0,
        taxRateBp: 1900,
        taxKind: 'taxed',
      },
    ],
    payments: [
      { method: 'cash', amount: 10_000 },
      { method: 'card', amount: 3_000, reference: 'aprobacion 1' },
    ],
    deviceTime: '2026-10-18T14:00:00.000Z',
    clockOffsetMs: 0,
    ...change,
  });
  return sale;
};

const voidBody = (change: Record<string, unknown> = {}) => ({
  operationId: nextId('5e6f7a8b'),
  shiftId: SHIFT_OF_LUIS,
  reason: 'Se equivocó de producto',
  ...change,
});

const failureOf = async (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );

describe('SalesUseCase: voiding a sale', () => {
  describe('what a void does', () => {
    it('adds the movements that compensate, deletes nothing, and says who voided it, when and why', async () => {
      const env = await setup();
      const made = await sell(env);
      const body = voidBody();

      const { sale, replayed } = await env.useCase.voidSale(luisAdmin, made.id, body);

      expect(replayed).toBe(false);
      expect(sale).toMatchObject({
        id: made.id,
        total: 13_000,
        lines: made.lines,
        payments: made.payments,
        voided: {
          voidedAt: env.fakeSales.voidedAt,
          voidedByUserId: LUIS,
          operationId: body.operationId,
          reason: 'Se equivocó de producto',
        },
      });
      expect(env.fakeSales.records).toHaveLength(1);
    });

    it('claims the operation as a void, not as a sale', async () => {
      const env = await setup();
      const made = await sell(env);
      const body = voidBody();

      await env.useCase.voidSale(luisAdmin, made.id, body);

      expect(env.purchasing.operations.claims.get(body.operationId)).toMatchObject({
        kind: 'sale_void',
        userId: LUIS,
      });
    });

    it('gives the stock back with one movement per product, in the fixed order, however many lines it had', async () => {
      const env = await setup();
      const made = await sell(env);
      const body = voidBody();
      const balancesAfterSale = new Map(env.purchasing.stock.balances);

      await env.useCase.voidSale(luisAdmin, made.id, body);

      const applied = env.purchasing.stock.applied.at(-1);
      expect(applied?.operationId).toBe(body.operationId);
      expect(applied?.changes).toEqual([
        { productId: COLA, delta: 2_000, reason: 'void', note: null },
        { productId: BREAD, delta: 1_500, reason: 'void', note: null },
      ]);
      expect(balancesAfterSale.get(COLA)).toBe(8_000);
      expect(env.purchasing.stock.balances.get(COLA)).toBe(10_000);
      expect(env.purchasing.stock.balances.get(BREAD)).toBe(10_000);
    });

    it('gives the cash back as an outflow of the open shift of whoever voids, not of the shift of the sale', async () => {
      const env = await setup();
      const made = await sell(env);
      const body = voidBody();

      await env.useCase.voidSale(luisAdmin, made.id, body);

      expect(env.cash.movements.records).toEqual([
        expect.objectContaining({
          operationId: body.operationId,
          shiftId: SHIFT_OF_LUIS,
          direction: 'out',
          amount: 10_000,
          reason: `Anulación de ${made.folio}`,
        }),
      ]);
    });

    it('gives back only the cash: what was paid by card or transfer is not in the drawer', async () => {
      const env = await setup();
      const made = await sell(env, {
        total: 13_000,
        payments: [
          { method: 'cash', amount: 2_000 },
          { method: 'transfer', amount: 5_000, reference: 'r1' },
          { method: 'cash', amount: 1_000 },
          { method: 'card', amount: 5_000, reference: 'r2' },
        ],
      });

      await env.useCase.voidSale(luisAdmin, made.id, voidBody());

      expect(env.cash.movements.records.map((movement) => movement.amount)).toEqual([3_000]);
    });

    it('needs no shift for a sale that had no cash: nothing goes back to a drawer', async () => {
      const env = await setup();
      const made = await sell(env, {
        payments: [{ method: 'card', amount: 13_000, reference: 'r' }],
      });
      const { shiftId: _shiftId, ...withoutShift } = voidBody();

      const { sale } = await env.useCase.voidSale(luisAdmin, made.id, withoutShift);

      expect(sale.voided).not.toBeNull();
      expect(env.cash.movements.records).toEqual([]);
      expect(env.cash.shifts.locked).toEqual([SHIFT]);
    });

    it('locks the shift that receives the cash, so it can not be closed in the middle', async () => {
      const env = await setup();
      const made = await sell(env);
      env.cash.shifts.locked.length = 0;

      await env.useCase.voidSale(luisAdmin, made.id, voidBody());

      expect(env.cash.shifts.locked).toEqual([SHIFT_OF_LUIS]);
    });

    it('also lets the person who made the sale void it from their own shift, if they are of the management', async () => {
      const env = await setup();
      const made = await sell(env, {}, owner);

      const { sale } = await env.useCase.voidSale(owner, made.id, voidBody({ shiftId: SHIFT }));

      expect(sale.voided?.voidedByUserId).toBe(ACTOR_ID);
      expect(env.cash.movements.records[0]?.shiftId).toBe(SHIFT);
    });

    it('shows the void when the sale is looked at again, in the list and one by one', async () => {
      const env = await setup();
      const made = await sell(env);
      const { sale } = await env.useCase.voidSale(luisAdmin, made.id, voidBody());

      const one = await env.useCase.get(owner, made.id);
      const listed = (await env.useCase.list(owner, {})).items[0];

      expect(one.voided).toEqual(sale.voided);
      expect(listed?.voided).toEqual(sale.voided);
    });

    it('leaves the flags and the tray as they were: voiding is not reviewing', async () => {
      const env = await setup();
      const made = await sell(env, { total: 1 });

      const { sale } = await env.useCase.voidSale(luisAdmin, made.id, voidBody());

      expect(sale.flags).toEqual(made.flags);
      expect(sale.attention).toBe(true);
      expect(sale.review).toBeNull();
    });
  });

  describe('a sale is voided once', () => {
    it('answers a repeated request with the same sale, and writes nothing again', async () => {
      const env = await setup();
      const made = await sell(env);
      const body = voidBody();
      const first = await env.useCase.voidSale(luisAdmin, made.id, body);
      const movements = env.purchasing.stock.book.length;

      const again = await env.useCase.voidSale(luisAdmin, made.id, body);

      expect(again.replayed).toBe(true);
      expect(again.sale).toEqual(first.sale);
      expect(env.purchasing.stock.book).toHaveLength(movements);
      expect(env.cash.movements.records).toHaveLength(1);
    });

    it('refuses to void it again with another operation, saying it is already voided', async () => {
      const env = await setup();
      const made = await sell(env);
      await env.useCase.voidSale(luisAdmin, made.id, voidBody());
      const movements = env.purchasing.stock.book.length;

      const failure = await failureOf(
        env.useCase.voidSale(owner, made.id, voidBody({ shiftId: SHIFT })),
      );

      expect(failure).toBeInstanceOf(SaleVoidedError);
      expect(env.purchasing.stock.book).toHaveLength(movements);
      expect(env.cash.movements.records).toHaveLength(1);
    });

    it('refuses an operation that was used for another request', async () => {
      const env = await setup();
      const made = await sell(env);
      const other = await sell(env);
      const body = voidBody();
      await env.useCase.voidSale(luisAdmin, made.id, body);

      const failure = await failureOf(env.useCase.voidSale(luisAdmin, other.id, body));
      const sameSaleOtherReason = await failureOf(
        env.useCase.voidSale(luisAdmin, made.id, { ...body, reason: 'Otro motivo' }),
      );

      expect(failure).toBeInstanceOf(OperationIdReusedError);
      expect(sameSaleOtherReason).toBeInstanceOf(OperationIdReusedError);
    });
  });

  describe('the cash that goes back', () => {
    it.each([
      ['no shift at all', { shiftId: null }],
      ['a shift that does not exist', { shiftId: UNKNOWN }],
      ['a shift of somebody else', { shiftId: SHIFT }],
    ])(
      'needs an open shift of whoever voids: %s is a conflict, and nothing changes',
      async (_name, change) => {
        const env = await setup();
        const made = await sell(env);
        const movements = env.purchasing.stock.book.length;

        const failure = await failureOf(env.useCase.voidSale(luisAdmin, made.id, voidBody(change)));

        expect(failure).toBeInstanceOf(ShiftRequiredError);
        expect(env.purchasing.stock.book).toHaveLength(movements);
        expect(env.cash.movements.records).toEqual([]);
        expect(env.fakeSales.voids.size).toBe(0);
      },
    );

    it('does not take the cash out of a shift that was already closed and counted', async () => {
      const env = await setup();
      const made = await sell(env);
      await env.cash.shifts.close(SHIFT_OF_LUIS, {
        closedAt: new Date('2026-10-18T14:30:00.000Z'),
        closedByUserId: LUIS,
        countedAmount: 0,
      });

      const failure = await failureOf(env.useCase.voidSale(luisAdmin, made.id, voidBody()));

      expect(failure).toBeInstanceOf(ShiftRequiredError);
      expect(env.cash.movements.records).toEqual([]);
    });

    it('can void with the shift of the sale itself when it is still open and it is the voider', async () => {
      const env = await setup();
      const made = await sell(env, {}, owner);

      await env.useCase.voidSale(owner, made.id, voidBody({ shiftId: SHIFT }));

      expect(env.cash.movements.records[0]?.shiftId).toBe(made.shiftId);
    });
  });

  describe('who can ask', () => {
    it.each(['owner', 'admin'] as const)('lets %s void a sale', async (role) => {
      const env = await setup();
      const made = await sell(env);

      await expect(
        env.useCase.voidSale(asPerson(role, LUIS), made.id, voidBody()),
      ).resolves.toMatchObject({ replayed: false });
    });

    it('is not for a cashier, who does not learn whether the sale exists either', async () => {
      const env = await setup();
      const made = await sell(env);

      expect(await failureOf(env.useCase.voidSale(ana, made.id, voidBody()))).toBeInstanceOf(
        ForbiddenError,
      );
      expect(await failureOf(env.useCase.voidSale(ana, UNKNOWN, voidBody()))).toBeInstanceOf(
        ForbiddenError,
      );
      expect(env.fakeSales.voids.size).toBe(0);
    });

    it('is not for someone without a business nor for someone who was let go', async () => {
      const env = await setup();
      const made = await sell(env);
      const letGo = memberSession('owner');

      expect(
        await failureOf(env.useCase.voidSale(loneSession(), made.id, voidBody())),
      ).toBeInstanceOf(NoMembershipError);
      expect(
        await failureOf(
          env.useCase.voidSale(
            { ...letGo, membership: { ...letGo.membership!, active: false } },
            made.id,
            voidBody(),
          ),
        ),
      ).toBeInstanceOf(UserInactiveError);
    });

    it('works inside the business of the person', async () => {
      const env = await setup();
      const made = await sell(env);

      await env.useCase.voidSale(luisAdmin, made.id, voidBody());

      expect(new Set(env.work.openedFor)).toEqual(new Set([BUSINESS_ID]));
    });
  });

  describe('what it refuses before touching anything', () => {
    it('needs a sale that exists, even if the identifier is not even one, and does not ask the database about that', async () => {
      const env = await setup();

      expect(await failureOf(env.useCase.voidSale(owner, UNKNOWN, voidBody()))).toBeInstanceOf(
        SaleNotFoundError,
      );
      const opened = env.work.openedFor.length;
      expect(
        await failureOf(env.useCase.voidSale(owner, 'no-es-un-id', voidBody())),
      ).toBeInstanceOf(SaleNotFoundError);
      expect(env.work.openedFor).toHaveLength(opened);
    });

    it('finds the sale by the identifier in lowercase, however it was written, and answers with it', async () => {
      const env = await setup();
      const made = await sell(env);

      const { sale } = await env.useCase.voidSale(luisAdmin, made.id.toUpperCase(), voidBody());

      expect(sale.id).toBe(made.id);
    });

    it('refuses a body that is not a void, saying every problem, before it opens the database', async () => {
      const env = await setup();
      const made = await sell(env);
      const opened = env.work.openedFor.length;

      const failure = await failureOf(
        env.useCase.voidSale(owner, made.id, { operationId: 'no', reason: '', extra: 1 }),
      );

      expect(failure).toBeInstanceOf(ValidationFailedError);
      expect(
        (failure as ValidationFailedError).errors.map((e) => `${e.pointer}:${e.code}`),
      ).toEqual(['/extra:unknown-field', '/operationId:invalid-id', '/reason:blank']);
      expect(env.work.openedFor).toHaveLength(opened);
    });
  });

  describe('the folio of the void (C4-A1, ADR 0036)', () => {
    it('gives the void its own folio, apart from the folio of the sale it voids', async () => {
      const env = await setup();
      const made = await sell(env);

      const { sale } = await env.useCase.voidSale(luisAdmin, made.id, voidBody());

      expect(sale.voided?.folio).toBe('ANU-000001');
      expect(sale.folio).toBe(made.folio);
      expect(sale.voided?.folio).not.toBe(sale.folio);
    });

    it('numbers the voids one after the other in the order they are made, not in the order of the sales', async () => {
      const env = await setup();
      const first = await sell(env);
      const second = await sell(env);
      const third = await sell(env);

      const ofThird = await env.useCase.voidSale(luisAdmin, third.id, voidBody());
      const ofFirst = await env.useCase.voidSale(luisAdmin, first.id, voidBody());
      const ofSecond = await env.useCase.voidSale(luisAdmin, second.id, voidBody());

      expect([ofThird, ofFirst, ofSecond].map(({ sale }) => sale.voided?.folio)).toEqual([
        'ANU-000001',
        'ANU-000002',
        'ANU-000003',
      ]);
    });

    it('answers a repeated request with the same folio and does not take another number', async () => {
      const env = await setup();
      const first = await sell(env);
      const second = await sell(env);
      const body = voidBody();
      await env.useCase.voidSale(luisAdmin, first.id, body);

      const again = await env.useCase.voidSale(luisAdmin, first.id, body);
      const next = await env.useCase.voidSale(luisAdmin, second.id, voidBody());

      expect(again.replayed).toBe(true);
      expect(again.sale.voided?.folio).toBe('ANU-000001');
      expect(next.sale.voided?.folio).toBe('ANU-000002');
    });

    it('takes no number when the void is refused, so the series has no hole', async () => {
      const env = await setup();
      const first = await sell(env);
      const second = await sell(env);
      await env.useCase.voidSale(luisAdmin, first.id, voidBody());

      // Ya anulada, y sin turno donde devolver el efectivo: las dos se rechazan antes de escribir la anulacion.
      const twice = await failureOf(env.useCase.voidSale(luisAdmin, first.id, voidBody()));
      const noShift = await failureOf(
        env.useCase.voidSale(luisAdmin, second.id, voidBody({ shiftId: UNKNOWN })),
      );
      const next = await env.useCase.voidSale(luisAdmin, second.id, voidBody());

      expect(twice).toBeInstanceOf(SaleVoidedError);
      expect(noShift).toBeInstanceOf(ShiftRequiredError);
      expect(next.sale.voided?.folio).toBe('ANU-000002');
    });
  });
});
