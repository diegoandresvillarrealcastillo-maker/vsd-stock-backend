import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from '../../domain/model/pagination.js';
import { NoMembershipError } from '../../domain/model/people-errors.js';
import { ValidationFailedError } from '../../domain/model/validation.js';
import { UserInactiveError } from '../../domain/ports/in/authenticate.js';
import type { ProductRecord } from '../../domain/ports/out/catalog.js';
import type { Clock } from '../../domain/ports/out/clock.js';
import { FakeCatalog } from '../../../test/support/fake-catalog.js';
import { FakePeople, fakeUnitOfWork } from '../../../test/support/fake-people.js';
import { FakePurchasing } from '../../../test/support/fake-purchasing.js';
import { BUSINESS_ID, loneSession, memberSession } from '../../../test/support/sessions.js';
import { SyncCopyUseCase } from './sync-copy.usecase.js';

const NOW = new Date('2026-10-18T15:00:00.000Z');
const clock: Clock = { now: () => NOW };

const product = (n: number, change: Partial<ProductRecord> = {}): ProductRecord => ({
  id: `f0000000-0000-4000-8000-00000000000${String(n)}`,
  name: `Producto ${String(n)}`,
  sku: `sku${String(n)}`,
  barcode: null,
  unit: 'unit',
  unitPrice: 3500,
  taxRateBp: 1900,
  active: true,
  categoryId: null,
  minStockMilli: null,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  updatedAt: new Date(`2026-10-1${String(n)}T10:00:00.000Z`),
  ...change,
});

const setup = () => {
  const catalog = new FakeCatalog();
  const purchasing = new FakePurchasing();
  const work = fakeUnitOfWork(new FakePeople(), 'Tienda', catalog, purchasing);
  return { useCase: new SyncCopyUseCase(work, clock), catalog, purchasing, work };
};

const cashier = memberSession('cashier');

describe('SyncCopyUseCase: the products', () => {
  it('gives everything when no since is asked, from the oldest change to the newest, archived ones included', async () => {
    const { useCase, catalog } = setup();
    catalog.products.push(
      product(3),
      product(1),
      product(2, { active: false, updatedAt: new Date('2026-10-12T10:00:00.000Z') }),
    );

    const page = await useCase.products(cashier, {});

    expect(page.items.map((item) => item.name)).toEqual(['Producto 1', 'Producto 2', 'Producto 3']);
    expect(page.items.map((item) => item.active)).toEqual([true, false, true]);
    expect(page.nextCursor).toBeNull();
  });

  it('says what hour the server read it, taken before reading, for the device to ask from there next time', async () => {
    const { useCase } = setup();

    const page = await useCase.products(cashier, {});

    expect(page.asOf).toEqual(NOW);
  });

  it('gives only what changed after since, and not what changed at that very instant', async () => {
    const { useCase, catalog } = setup();
    catalog.products.push(product(1), product(2), product(3));

    const page = await useCase.products(cashier, { since: '2026-10-12T10:00:00.000Z' });

    expect(page.items.map((item) => item.name)).toEqual(['Producto 3']);
  });

  it('pages by cursor in the order of the changes, without repeating or skipping anyone', async () => {
    const { useCase, catalog } = setup();
    catalog.products.push(product(1), product(2), product(3), product(4), product(5));

    const first = await useCase.products(cashier, { limit: '2' });
    const second = await useCase.products(cashier, { limit: '2', cursor: first.nextCursor });
    const third = await useCase.products(cashier, { limit: '2', cursor: second.nextCursor });

    expect(first.items.map((item) => item.name)).toEqual(['Producto 1', 'Producto 2']);
    expect(second.items.map((item) => item.name)).toEqual(['Producto 3', 'Producto 4']);
    expect(third.items.map((item) => item.name)).toEqual(['Producto 5']);
    expect(third.nextCursor).toBeNull();
    expect(decodeCursor(first.nextCursor!, 2)).toEqual(['2026-10-12T10:00:00.000Z', product(2).id]);
  });

  it('breaks a tie of hours by the identifier, so the order is always the same', async () => {
    const { useCase, catalog } = setup();
    const same = new Date('2026-10-12T10:00:00.000Z');
    catalog.products.push(
      product(3, { updatedAt: same }),
      product(1, { updatedAt: same }),
      product(2, { updatedAt: same }),
    );

    const first = await useCase.products(cashier, { limit: '2' });
    const second = await useCase.products(cashier, { limit: '2', cursor: first.nextCursor });

    expect([...first.items, ...second.items].map((item) => item.name)).toEqual([
      'Producto 1',
      'Producto 2',
      'Producto 3',
    ]);
  });

  it('refuses a cursor that is not an instant followed by a product', async () => {
    const { useCase } = setup();
    const aProduct = 'f0000000-0000-4000-8000-000000000001';

    for (const cursor of [
      encodeCursor(['ayer', aProduct]),
      encodeCursor(['2026-10-18T15:00:00.000Z', 'no-es-un-id']),
    ]) {
      const failure = await useCase.products(cashier, { cursor }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ValidationFailedError);
      expect(
        (failure as ValidationFailedError).errors.map((e) => `${e.pointer}:${e.code}`),
      ).toEqual(['/cursor:invalid-cursor']);
    }
  });

  it('works for the three roles: a cashier needs the catalog to sell', async () => {
    const { useCase } = setup();

    for (const role of ['owner', 'admin', 'cashier'] as const) {
      await expect(useCase.products(memberSession(role), {})).resolves.toMatchObject({ items: [] });
    }
  });

  it('refuses what it does not know, saying every problem, and reads nothing', async () => {
    const { useCase, work } = setup();
    const opened = work.openedFor.length;

    const failure = await useCase
      .products(cashier, { since: 'ayer', limit: '0', cursor: 'no', otra: 1 })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ValidationFailedError);
    expect((failure as ValidationFailedError).errors.map((e) => `${e.pointer}:${e.code}`)).toEqual([
      '/otra:unknown-field',
      '/limit:out-of-range',
      '/cursor:invalid-cursor',
      '/since:invalid-moment',
    ]);
    expect(work.openedFor).toHaveLength(opened);
  });

  it('works inside the business of the person', async () => {
    const { useCase, work } = setup();

    await useCase.products(cashier, {});

    expect(new Set(work.openedFor)).toEqual(new Set([BUSINESS_ID]));
  });

  it('is not for someone without a business nor for someone who was let go', async () => {
    const { useCase } = setup();
    const letGo = memberSession('owner');

    await expect(useCase.products(loneSession(), {})).rejects.toBeInstanceOf(NoMembershipError);
    await expect(
      useCase.products({ ...letGo, membership: { ...letGo.membership!, active: false } }, {}),
    ).rejects.toBeInstanceOf(UserInactiveError);
  });
});

describe('SyncCopyUseCase: the stock', () => {
  const P1 = 'f0000000-0000-4000-8000-000000000001';
  const P2 = 'f0000000-0000-4000-8000-000000000002';
  const P3 = 'f0000000-0000-4000-8000-000000000003';

  const move = async (
    purchasing: ReturnType<typeof setup>['purchasing'],
    productId: string,
    delta: number,
  ) => {
    await purchasing.stock.addMovements(`op-${productId}-${String(delta)}`, [
      { productId, delta, reason: 'adjustment', note: null },
    ]);
  };

  it('gives the stock of each product that ever moved, ordered by product, as the server has it now', async () => {
    const { useCase, purchasing } = setup();
    await move(purchasing, P2, 5_000);
    await move(purchasing, P1, 2_000);
    await move(purchasing, P2, -1_500);

    const page = await useCase.stock(cashier, {});

    expect(page.items).toEqual([
      { productId: P1, quantityMilli: 2_000 },
      { productId: P2, quantityMilli: 3_500 },
    ]);
    expect(page.asOf).toEqual(NOW);
    expect(page.nextCursor).toBeNull();
  });

  it('gives a negative stock as it is: that is what the shelf says', async () => {
    const { useCase, purchasing } = setup();
    await move(purchasing, P1, -3_000);

    expect((await useCase.stock(cashier, {})).items).toEqual([
      { productId: P1, quantityMilli: -3_000 },
    ]);
  });

  it('gives only the products that moved after since, with their stock of now', async () => {
    const { useCase, purchasing } = setup();
    await move(purchasing, P1, 1_000);
    await move(purchasing, P2, 2_000);
    await move(purchasing, P3, 3_000);
    // El doble le pone a cada movimiento una hora: uno por minuto desde las 13:01.
    const since = purchasing.stock.book[1]!.createdAt.toISOString();

    const page = await useCase.stock(cashier, { since });

    expect(page.items.map((item) => item.productId)).toEqual([P3]);
  });

  it('pages by product, without repeating or skipping anyone', async () => {
    const { useCase, purchasing } = setup();
    for (const productId of [P3, P1, P2]) await move(purchasing, productId, 1_000);

    const first = await useCase.stock(cashier, { limit: '2' });
    const second = await useCase.stock(cashier, { limit: '2', cursor: first.nextCursor });

    expect(first.items.map((item) => item.productId)).toEqual([P1, P2]);
    expect(second.items.map((item) => item.productId)).toEqual([P3]);
    expect(decodeCursor(first.nextCursor!, 1)).toEqual([P2]);
    expect(second.nextCursor).toBeNull();
  });

  it('refuses a cursor that is not a product, and what it does not know', async () => {
    const { useCase } = setup();

    const failure = await useCase
      .stock(cashier, { cursor: encodeCursor(['no-es-un-id']), since: 'ayer' })
      .catch((error: unknown) => error);

    expect((failure as ValidationFailedError).errors.map((e) => `${e.pointer}:${e.code}`)).toEqual([
      '/cursor:invalid-cursor',
      '/since:invalid-moment',
    ]);
  });

  it('works for the three roles and not for whoever has no business', async () => {
    const { useCase } = setup();

    for (const role of ['owner', 'admin', 'cashier'] as const) {
      await expect(useCase.stock(memberSession(role), {})).resolves.toMatchObject({ items: [] });
    }
    await expect(useCase.stock(loneSession(), {})).rejects.toBeInstanceOf(NoMembershipError);
  });
});
