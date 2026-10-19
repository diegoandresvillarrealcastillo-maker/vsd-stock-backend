import { describe, expect, it } from 'vitest';
import { decodeCursor } from '../../domain/model/pagination.js';
import { ForbiddenError, NoMembershipError } from '../../domain/model/people-errors.js';
import type { Role } from '../../domain/model/role.js';
import { SaleNotFoundError } from '../../domain/model/sale-errors.js';
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
const UNKNOWN = '99999999-9999-4999-8999-999999999999';

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

/** La misma sesion de un negocio, pero de otra persona. */
const asPerson = (role: Role, userId: string): Session => {
  const base = memberSession(role);
  return { ...base, membership: { ...base.membership!, userId } };
};
const ana = memberSession('cashier');
const luis = asPerson('cashier', LUIS);
const owner = memberSession('owner');

const setup = async () => {
  const catalog = new FakeCatalog();
  catalog.products.push(product);
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
  purchasing.stock.balances.set(COLA, 1_000_000);
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
  return { useCase, work, purchasing, fakeSales };
};
type Setup = Awaited<ReturnType<typeof setup>>;

let counter = 0;
/** Una venta de una gaseosa, hecha por quien dice la sesion en su turno, a la hora que se diga. */
const sell = async (
  { useCase }: Setup,
  session: Session,
  shiftId: string,
  at: string,
  change: Record<string, unknown> = {},
) => {
  counter += 1;
  const operationId = `0a1b2c3d-4e5f-4a6b-8c7d-${String(counter).padStart(12, '0')}`;
  const { sale } = await useCase.create(session, {
    operationId,
    shiftId,
    folio: `AA-${String(counter).padStart(6, '0')}`,
    total: 3_500,
    lines: [
      { productId: COLA, quantityMilli: 1_000, unitPrice: 3_500, discount: 0, taxRateBp: 1900 },
    ],
    payments: [{ method: 'cash', amount: 3_500 }],
    deviceTime: at,
    clockOffsetMs: 0,
    ...change,
  });
  return sale;
};

const codes = (failure: unknown) =>
  (failure as ValidationFailedError).errors.map((e) => `${e.pointer}:${e.code}`);

const failureOf = async (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );

describe('SalesUseCase: looking at sales', () => {
  describe('the list', () => {
    it('shows a cashier the sales of their own shifts, and the management those of everybody', async () => {
      const env = await setup();
      const mine = await sell(env, ana, SHIFT, '2026-10-18T14:00:00.000Z');
      const his = await sell(env, luis, SHIFT_OF_LUIS, '2026-10-18T14:30:00.000Z');

      const ofAna = await env.useCase.list(ana, {});
      const ofLuis = await env.useCase.list(luis, {});
      const ofOwner = await env.useCase.list(owner, {});

      expect(ofAna.items.map((sale) => sale.id)).toEqual([mine.id]);
      expect(ofLuis.items.map((sale) => sale.id)).toEqual([his.id]);
      expect(ofOwner.items.map((sale) => sale.id)).toEqual([his.id, mine.id]);
    });

    it('goes from the newest sale to the oldest, by the hour it happened and not by when it arrived', async () => {
      const env = await setup();
      const second = await sell(env, ana, SHIFT, '2026-10-18T12:00:00.000Z');
      const third = await sell(env, ana, SHIFT, '2026-10-18T14:00:00.000Z');
      const first = await sell(env, ana, SHIFT, '2026-10-18T09:00:00.000Z');

      const page = await env.useCase.list(owner, {});

      expect(page.items.map((sale) => sale.id)).toEqual([third.id, second.id, first.id]);
    });

    it('shows a sale without its lines and payments, with what is needed to decide whether to open it', async () => {
      const env = await setup();
      await sell(env, ana, SHIFT, '2026-10-18T14:00:00.000Z');

      const [item] = (await env.useCase.list(ana, {})).items;

      expect(item).toMatchObject({
        folio: expect.stringMatching(/^AA-/),
        total: 3_500,
        attention: false,
        review: null,
      });
      expect(item).not.toHaveProperty('lines');
      expect(item).not.toHaveProperty('payments');
    });

    it('pages by cursor, with the position of the last sale, and is the same for whoever asks', async () => {
      const env = await setup();
      const sales = [];
      for (const hour of [9, 10, 11, 12, 13]) {
        sales.push(
          await sell(env, ana, SHIFT, `2026-10-18T${String(hour).padStart(2, '0')}:00:00.000Z`),
        );
      }

      const first = await env.useCase.list(ana, { limit: '2' });
      const second = await env.useCase.list(ana, { limit: '2', cursor: first.nextCursor });
      const third = await env.useCase.list(ana, { limit: '2', cursor: second.nextCursor });

      expect(first.items.map((sale) => sale.id)).toEqual([sales[4]!.id, sales[3]!.id]);
      expect(second.items.map((sale) => sale.id)).toEqual([sales[2]!.id, sales[1]!.id]);
      expect(third.items.map((sale) => sale.id)).toEqual([sales[0]!.id]);
      expect(third.nextCursor).toBeNull();
      expect(decodeCursor(first.nextCursor!, 2)).toEqual([
        sales[3]!.occurredAt.toISOString(),
        sales[3]!.id,
      ]);
    });

    it('can be narrowed to one shift, and to one folio, which finds both sales when two brought the same', async () => {
      const env = await setup();
      const a = await sell(env, ana, SHIFT, '2026-10-18T13:00:00.000Z', { folio: 'AA-000900' });
      const clash = await sell(env, luis, SHIFT_OF_LUIS, '2026-10-18T13:30:00.000Z', {
        folio: 'AA-000900',
      });
      const other = await sell(env, ana, SHIFT, '2026-10-18T14:00:00.000Z', { folio: 'AA-000901' });

      const ofShift = await env.useCase.list(owner, { shiftId: SHIFT_OF_LUIS });
      const byFolio = await env.useCase.list(owner, { folio: ' aa-000900 ' });
      const ofCashier = await env.useCase.list(luis, { folio: 'AA-000900' });

      expect(ofShift.items.map((sale) => sale.id)).toEqual([clash.id]);
      expect(byFolio.items.map((sale) => sale.id)).toEqual([clash.id, a.id]);
      expect(byFolio.items.map((sale) => sale.id)).not.toContain(other.id);
      // Quien busca tiene su limite: Luis solo encuentra lo suyo.
      expect(ofCashier.items.map((sale) => sale.id)).toEqual([clash.id]);
    });

    describe('the tray of what needs attention', () => {
      it('has the sales that ask for it and nobody has reviewed, and no others', async () => {
        const env = await setup();
        const first = await sell(env, ana, SHIFT, '2026-10-18T10:00:00.000Z');
        const odd = await sell(env, ana, SHIFT, '2026-10-18T11:00:00.000Z', { total: 1 });
        const clash = await sell(env, ana, SHIFT, '2026-10-18T12:00:00.000Z', {
          folio: first.folioReported,
        });

        const tray = await env.useCase.list(owner, { attention: 'true' });
        const rest = await env.useCase.list(owner, { attention: 'false' });

        expect(new Set(tray.items.map((sale) => sale.id))).toEqual(new Set([odd.id, clash.id]));
        expect(tray.items.every((sale) => sale.attention)).toBe(true);
        expect(rest.items).toHaveLength(1);
        expect(rest.items.every((sale) => !sale.attention)).toBe(true);
      });

      it('lets a sale go once it was reviewed, but the sale keeps its flags', async () => {
        const env = await setup();
        const odd = await sell(env, ana, SHIFT, '2026-10-18T11:00:00.000Z', { total: 1 });

        await env.useCase.review(owner, odd.id, { note: 'Se cobró bien' });
        const tray = await env.useCase.list(owner, { attention: 'true' });
        const all = await env.useCase.list(owner, {});

        expect(tray.items).toEqual([]);
        expect(all.items[0]).toMatchObject({ flags: ['total-differs'], attention: false });
      });

      it('is for the management: a cashier who asks for it is told it is not theirs', async () => {
        const env = await setup();

        expect(await failureOf(env.useCase.list(ana, { attention: 'true' }))).toBeInstanceOf(
          ForbiddenError,
        );
        expect(await failureOf(env.useCase.list(ana, { attention: 'false' }))).toBeInstanceOf(
          ForbiddenError,
        );
      });
    });

    it('refuses what it does not know, saying every problem, and opens nothing', async () => {
      const env = await setup();

      const failure = await failureOf(
        env.useCase.list(owner, {
          limit: '0',
          shiftId: 'no',
          attention: 'a',
          folio: 'x',
          extra: '1',
        }),
      );

      expect(failure).toBeInstanceOf(ValidationFailedError);
      expect(codes(failure)).toEqual([
        '/extra:unknown-field',
        '/limit:out-of-range',
        '/shiftId:invalid-id',
        '/attention:invalid-value',
        '/folio:invalid-folio',
      ]);
      expect(env.work.openedFor).toEqual([]);
    });

    it('is not for someone without a business nor for someone who was let go', async () => {
      const env = await setup();

      expect(await failureOf(env.useCase.list(loneSession(), {}))).toBeInstanceOf(
        NoMembershipError,
      );
      expect(
        await failureOf(env.useCase.list(memberSession('owner', { active: false }), {})),
      ).toBeInstanceOf(UserInactiveError);
    });

    it('works inside the business of the person', async () => {
      const env = await setup();

      await env.useCase.list(owner, {});

      expect(env.work.openedFor).toEqual([BUSINESS_ID]);
    });
  });

  describe('one sale', () => {
    it('comes with its lines, its payments, its tax split and whether it is in the tray', async () => {
      const env = await setup();
      const made = await sell(env, ana, SHIFT, '2026-10-18T14:00:00.000Z', { total: 1 });

      const sale = await env.useCase.get(ana, made.id);

      expect(sale).toMatchObject({
        id: made.id,
        folio: made.folio,
        lines: made.lines,
        payments: made.payments,
        summary: made.summary,
        attention: true,
        review: null,
      });
    });

    it('is seen by the management, and by the cashier whose shift it is, but not by another cashier', async () => {
      const env = await setup();
      const made = await sell(env, ana, SHIFT, '2026-10-18T14:00:00.000Z');

      await expect(env.useCase.get(owner, made.id)).resolves.toMatchObject({ id: made.id });
      await expect(env.useCase.get(ana, made.id)).resolves.toMatchObject({ id: made.id });
      expect(await failureOf(env.useCase.get(luis, made.id))).toBeInstanceOf(SaleNotFoundError);
    });

    it('is seen by the management whichever shift it is from, also by an administrator who did not sell it', async () => {
      const env = await setup();
      const made = await sell(env, ana, SHIFT, '2026-10-18T14:00:00.000Z');
      const admin = asPerson('admin', LUIS);

      await expect(env.useCase.get(admin, made.id)).resolves.toMatchObject({ id: made.id });
    });

    it('does not exist when nothing has that identifier, or when it is not even one', async () => {
      const env = await setup();

      expect(await failureOf(env.useCase.get(owner, UNKNOWN))).toBeInstanceOf(SaleNotFoundError);
      const opened = env.work.openedFor.length;
      expect(await failureOf(env.useCase.get(owner, 'no-es-un-id'))).toBeInstanceOf(
        SaleNotFoundError,
      );
      // Lo que no es un identificador no es de nadie: no se le pregunta nada a la base.
      expect(env.work.openedFor).toHaveLength(opened);
    });

    it('is looked up by the identifier in lowercase, however it was written', async () => {
      const env = await setup();
      const made = await sell(env, ana, SHIFT, '2026-10-18T14:00:00.000Z');

      await expect(env.useCase.get(owner, made.id.toUpperCase())).resolves.toMatchObject({
        id: made.id,
      });
    });
  });

  describe('reviewing a sale', () => {
    it('is done by the management, takes the sale out of the tray and keeps who, when and what they wrote', async () => {
      const env = await setup();
      const odd = await sell(env, ana, SHIFT, '2026-10-18T11:00:00.000Z', { total: 1 });

      const outcome = await env.useCase.review(owner, odd.id, {
        note: '  Se ajustó el inventario  ',
      });

      expect(outcome).toEqual({
        saleId: odd.id,
        review: {
          reviewedAt: env.fakeSales.reviewedAt,
          reviewedByUserId: ACTOR_ID,
          note: 'Se ajustó el inventario',
        },
        replayed: false,
      });
      const sale = await env.useCase.get(owner, odd.id);
      expect(sale).toMatchObject({
        attention: false,
        review: outcome.review,
        flags: ['total-differs'],
      });
    });

    it('keeps who reviewed it, not who sold it', async () => {
      const env = await setup();
      const made = await sell(env, ana, SHIFT, '2026-10-18T11:00:00.000Z');

      const outcome = await env.useCase.review(asPerson('admin', LUIS), made.id, {});

      expect(made.userId).toBe(ACTOR_ID);
      expect(outcome.review.reviewedByUserId).toBe(LUIS);
    });

    it('finds the sale by the identifier in lowercase and answers with it, however it was written', async () => {
      const env = await setup();
      const made = await sell(env, ana, SHIFT, '2026-10-18T11:00:00.000Z');

      const outcome = await env.useCase.review(owner, made.id.toUpperCase(), {});

      expect(outcome.saleId).toBe(made.id);
      expect(env.fakeSales.reviews.has(made.id)).toBe(true);
    });

    it('can go without a note', async () => {
      const env = await setup();
      const made = await sell(env, ana, SHIFT, '2026-10-18T11:00:00.000Z');

      const outcome = await env.useCase.review(owner, made.id, {});

      expect(outcome.review.note).toBeNull();
    });

    it('is done once: reviewing again answers with the review that was there and writes nothing', async () => {
      const env = await setup();
      const made = await sell(env, ana, SHIFT, '2026-10-18T11:00:00.000Z');
      const first = await env.useCase.review(owner, made.id, { note: 'primera' });

      const again = await env.useCase.review(asPerson('admin', LUIS), made.id, { note: 'otra' });

      expect(again.replayed).toBe(true);
      expect(again.review).toEqual(first.review);
      expect(env.fakeSales.reviews.size).toBe(1);
    });

    it('is not for a cashier, and a cashier does not learn whether the sale exists', async () => {
      const env = await setup();
      const made = await sell(env, ana, SHIFT, '2026-10-18T11:00:00.000Z');

      expect(await failureOf(env.useCase.review(ana, made.id, {}))).toBeInstanceOf(ForbiddenError);
      expect(await failureOf(env.useCase.review(ana, UNKNOWN, {}))).toBeInstanceOf(ForbiddenError);
      await expect(env.useCase.get(owner, made.id)).resolves.toMatchObject({ review: null });
    });

    it('needs a sale that exists', async () => {
      const env = await setup();

      expect(await failureOf(env.useCase.review(owner, UNKNOWN, {}))).toBeInstanceOf(
        SaleNotFoundError,
      );
      const opened = env.work.openedFor.length;
      expect(await failureOf(env.useCase.review(owner, 'no-es-un-id', {}))).toBeInstanceOf(
        SaleNotFoundError,
      );
      // Lo que no es un identificador no es de nadie: no se le pregunta nada a la base.
      expect(env.work.openedFor).toHaveLength(opened);
    });

    it('refuses a body that is not a review, before it opens the database', async () => {
      const env = await setup();
      const made = await sell(env, ana, SHIFT, '2026-10-18T11:00:00.000Z');
      const opened = env.work.openedFor.length;

      const failure = await failureOf(env.useCase.review(owner, made.id, { note: '', extra: 1 }));

      expect(codes(failure)).toEqual(['/extra:unknown-field', '/note:blank']);
      expect(env.work.openedFor).toHaveLength(opened);
    });
  });
});
