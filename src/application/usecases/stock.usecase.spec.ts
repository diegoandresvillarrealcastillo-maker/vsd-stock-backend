import { describe, expect, it } from 'vitest';
import { ProductNotFoundError } from '../../domain/model/catalog-errors.js';
import { encodeCursor } from '../../domain/model/pagination.js';
import { NoMembershipError } from '../../domain/model/people-errors.js';
import { ValidationFailedError } from '../../domain/model/validation.js';
import { UserInactiveError } from '../../domain/ports/in/authenticate.js';
import type { ProductRecord } from '../../domain/ports/out/catalog.js';
import { FakeCatalog } from '../../../test/support/fake-catalog.js';
import { FakePeople, fakeUnitOfWork } from '../../../test/support/fake-people.js';
import { FakePurchasing } from '../../../test/support/fake-purchasing.js';
import { BUSINESS_ID, loneSession, memberSession } from '../../../test/support/sessions.js';
import { StockUseCase } from './stock.usecase.js';

const RICE = 'f0000000-0000-4000-8000-0000000000a1';
const SUGAR = 'f0000000-0000-4000-8000-0000000000a2';
const SALT = 'f0000000-0000-4000-8000-0000000000a3';
const OIL = 'f0000000-0000-4000-8000-0000000000a4';
const CATEGORY = 'c0000000-0000-4000-8000-0000000000c1';
const OTHER = '99999999-9999-4999-8999-999999999999';

const product = (id: string, overrides: Partial<ProductRecord>): ProductRecord => ({
  id,
  name: 'Producto',
  sku: id.slice(-2).toUpperCase(),
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

const setup = () => {
  const catalog = new FakeCatalog();
  catalog.products.push(
    product(RICE, { name: 'Arroz', sku: 'ARR-500', minStockMilli: 10_000, categoryId: CATEGORY }),
    product(SUGAR, { name: 'Azúcar', sku: 'AZU-1K', unit: 'kilogram', minStockMilli: 5000 }),
    product(SALT, { name: 'Sal', sku: 'SAL-1', barcode: '7701234567897' }),
    product(OIL, { name: 'Aceite', sku: 'ACE-1', active: false, minStockMilli: 1000 }),
  );
  const purchasing = new FakePurchasing();
  const work = fakeUnitOfWork(new FakePeople(), 'Tienda', catalog, purchasing);
  const stockOf = (balances: Record<string, number>) => {
    for (const [id, quantity] of Object.entries(balances))
      purchasing.stock.balances.set(id, quantity);
  };
  return { catalog, purchasing, work, stockOf, useCase: new StockUseCase(work) };
};

const failureOf = async (work: Promise<unknown>): Promise<ValidationFailedError> => {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ValidationFailedError);
  return error as ValidationFailedError;
};

describe('StockUseCase', () => {
  describe('the stock of every product', () => {
    it('lists every product by name, with what there is and the minimum, to every role', async () => {
      const { stockOf, work, useCase } = setup();
      stockOf({ [RICE]: 24_000, [SUGAR]: 2500 });

      for (const role of ['owner', 'admin', 'cashier'] as const) {
        const page = await useCase.list(memberSession(role), {});

        expect(page.items.map((s) => s.name)).toEqual(['Aceite', 'Arroz', 'Azúcar', 'Sal']);
      }
      expect(work.openedFor).toEqual([BUSINESS_ID, BUSINESS_ID, BUSINESS_ID]);
    });

    it('says how much there is of each product, and zero of what never moved', async () => {
      const { stockOf, useCase } = setup();
      stockOf({ [RICE]: 24_000 });

      const page = await useCase.list(memberSession('owner'), { active: 'true' });

      expect(page.items).toEqual([
        {
          productId: RICE,
          name: 'Arroz',
          sku: 'ARR-500',
          unit: 'unit',
          active: true,
          quantityMilli: 24_000,
          minStockMilli: 10_000,
          belowMinimum: false,
        },
        {
          productId: SUGAR,
          name: 'Azúcar',
          sku: 'AZU-1K',
          unit: 'kilogram',
          active: true,
          quantityMilli: 0,
          minStockMilli: 5000,
          belowMinimum: true,
        },
        {
          productId: SALT,
          name: 'Sal',
          sku: 'SAL-1',
          unit: 'unit',
          active: true,
          quantityMilli: 0,
          minStockMilli: null,
          belowMinimum: false,
        },
      ]);
    });

    it('warns only when there is strictly less than the minimum, and only when a minimum was set', async () => {
      const { stockOf, useCase } = setup();
      stockOf({ [RICE]: 10_000, [SUGAR]: 4999, [SALT]: 0 });

      const page = await useCase.list(memberSession('owner'), {});

      expect(page.items.map((s) => [s.name, s.belowMinimum])).toEqual([
        ['Aceite', true],
        ['Arroz', false],
        ['Azúcar', true],
        ['Sal', false],
      ]);
    });

    it('lists only what is below the minimum when asked to', async () => {
      const { stockOf, useCase } = setup();
      stockOf({ [RICE]: 3000, [SUGAR]: 5000 });

      const page = await useCase.list(memberSession('owner'), { belowMinimum: 'true' });

      expect(page.items.map((s) => s.name)).toEqual(['Aceite', 'Arroz']);
    });

    it('hands back everything with belowMinimum=false: the filter only narrows when it is true', async () => {
      const { useCase } = setup();

      const page = await useCase.list(memberSession('owner'), { belowMinimum: 'false' });

      expect(page.items).toHaveLength(4);
    });

    it('searches by a part of the name or the SKU, without caring about case, or by a whole barcode', async () => {
      const { useCase } = setup();

      const byName = await useCase.list(memberSession('owner'), { search: 'ARR' });
      const bySku = await useCase.list(memberSession('owner'), { search: 'azu-1' });
      const byBarcode = await useCase.list(memberSession('owner'), { search: '7701234567897' });

      expect(byName.items.map((s) => s.name)).toEqual(['Arroz']);
      expect(bySku.items.map((s) => s.name)).toEqual(['Azúcar']);
      expect(byBarcode.items.map((s) => s.name)).toEqual(['Sal']);
    });

    it('filters by category and by whether the product is archived', async () => {
      const { useCase } = setup();

      const category = await useCase.list(memberSession('owner'), { categoryId: CATEGORY });
      const archived = await useCase.list(memberSession('owner'), { active: 'false' });

      expect(category.items.map((s) => s.name)).toEqual(['Arroz']);
      expect(archived.items.map((s) => s.name)).toEqual(['Aceite']);
    });

    it('walks the list in pages by following the cursor, without repeating or skipping', async () => {
      const { useCase } = setup();

      const names: string[] = [];
      let cursor: string | null | undefined;
      do {
        const page = await useCase.list(
          memberSession('cashier'),
          cursor ? { limit: '3', cursor } : { limit: '3' },
        );
        names.push(...page.items.map((s) => s.name));
        cursor = page.nextCursor;
      } while (cursor);

      expect(names).toEqual(['Aceite', 'Arroz', 'Azúcar', 'Sal']);
    });

    it('puts in the cursor the name and the id of the last product it hands over', async () => {
      const { useCase } = setup();

      const page = await useCase.list(memberSession('owner'), { limit: '2' });

      expect(page.nextCursor).toBe(encodeCursor(['Arroz', RICE]));
    });

    it('says every problem of what was asked, at once, and asks the database nothing', async () => {
      const { work, useCase } = setup();

      const failure = await failureOf(
        useCase.list(memberSession('owner'), {
          limit: '0',
          search: '',
          categoryId: 'x',
          active: 'quizas',
          belowMinimum: 'si',
          cursor: encodeCursor(['Arroz', 'no-es-un-uuid']),
        }),
      );

      expect(failure.errors.map((e) => `${e.pointer}:${e.code}`)).toEqual([
        '/limit:out-of-range',
        '/cursor:invalid-cursor',
        '/search:blank',
        '/categoryId:invalid-id',
        '/active:invalid-value',
        '/belowMinimum:invalid-value',
      ]);
      expect(work.openedFor).toEqual([]);
    });

    it('refuses a person with no business and a person who was let go', async () => {
      const { useCase } = setup();

      await expect(useCase.list(loneSession(), {})).rejects.toBeInstanceOf(NoMembershipError);
      await expect(
        useCase.list(memberSession('owner', { active: false }), {}),
      ).rejects.toBeInstanceOf(UserInactiveError);
    });
  });

  describe('the history of a product', () => {
    const buy = async (
      purchasing: ReturnType<typeof setup>['purchasing'],
      productId: string,
      n: number,
      delta: number,
      kind: 'purchase' | 'adjustment' = 'purchase',
      note: string | null = null,
    ) =>
      purchasing.stock.addMovements(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, [
        { productId, delta, reason: kind, note },
      ]);

    it('lists the movements of a product, the newest first, to every role', async () => {
      const { purchasing, useCase } = setup();
      await buy(purchasing, RICE, 1, 24_000, 'purchase', 'Pedido');
      await buy(purchasing, SUGAR, 2, 500);
      await buy(purchasing, RICE, 3, -2000, 'adjustment', 'Se cayeron dos');

      for (const role of ['owner', 'admin', 'cashier'] as const) {
        const page = await useCase.movements(memberSession(role), { productId: RICE });

        expect(page.items.map((m) => [m.kind, m.deltaMilli, m.reason])).toEqual([
          ['adjustment', -2000, 'Se cayeron dos'],
          ['purchase', 24_000, 'Pedido'],
        ]);
      }
    });

    it('does not hand over the movements of another product', async () => {
      const { purchasing, useCase } = setup();
      await buy(purchasing, SUGAR, 1, 500);

      const page = await useCase.movements(memberSession('owner'), { productId: RICE });

      expect(page.items).toEqual([]);
      expect(page.nextCursor).toBeNull();
    });

    it('walks the history in pages by following the cursor, without repeating or skipping', async () => {
      const { purchasing, useCase } = setup();
      for (let n = 1; n <= 5; n += 1) await buy(purchasing, RICE, n, n * 1000);

      const deltas: number[] = [];
      let cursor: string | null | undefined;
      do {
        const page = await useCase.movements(
          memberSession('owner'),
          cursor ? { productId: RICE, limit: '2', cursor } : { productId: RICE, limit: '2' },
        );
        deltas.push(...page.items.map((m) => m.deltaMilli));
        cursor = page.nextCursor;
      } while (cursor);

      expect(deltas).toEqual([5000, 4000, 3000, 2000, 1000]);
    });

    it('puts in the cursor the moment and the id of the last movement it hands over', async () => {
      const { purchasing, useCase } = setup();
      for (let n = 1; n <= 3; n += 1) await buy(purchasing, RICE, n, 1000);

      const page = await useCase.movements(memberSession('owner'), { productId: RICE, limit: '2' });

      const last = page.items[1]!;
      expect(page.nextCursor).toBe(encodeCursor([last.createdAt.toISOString(), last.id]));
    });

    it('wants the product: the history of nothing is not a list', async () => {
      const { useCase } = setup();

      const failure = await failureOf(useCase.movements(memberSession('owner'), {}));

      expect(failure.errors.map((e) => `${e.pointer}:${e.code}`)).toEqual(['/productId:required']);
    });

    it('says every problem of what was asked, and a cursor that is not a moment and an id', async () => {
      const { work, useCase } = setup();

      const failure = await failureOf(
        useCase.movements(memberSession('owner'), {
          productId: 'x',
          limit: '999',
          cursor: encodeCursor(['ayer', OTHER]),
          extra: '1',
        }),
      );

      expect(failure.errors.map((e) => `${e.pointer}:${e.code}`)).toEqual([
        '/extra:unknown-field',
        '/limit:out-of-range',
        '/cursor:invalid-cursor',
        '/productId:invalid-id',
      ]);
      expect(work.openedFor).toEqual([]);
    });

    it('says there is no such product when it does not exist in the business', async () => {
      const { useCase } = setup();

      await expect(
        useCase.movements(memberSession('owner'), { productId: OTHER }),
      ).rejects.toBeInstanceOf(ProductNotFoundError);
    });

    it('shows the history of an archived product: it keeps its story', async () => {
      const { purchasing, useCase } = setup();
      await buy(purchasing, OIL, 1, 1000);

      const page = await useCase.movements(memberSession('owner'), { productId: OIL });

      expect(page.items).toHaveLength(1);
    });

    it('refuses a person with no business and a person who was let go', async () => {
      const { useCase } = setup();

      await expect(useCase.movements(loneSession(), { productId: RICE })).rejects.toBeInstanceOf(
        NoMembershipError,
      );
      await expect(
        useCase.movements(memberSession('cashier', { active: false }), { productId: RICE }),
      ).rejects.toBeInstanceOf(UserInactiveError);
    });
  });
});
