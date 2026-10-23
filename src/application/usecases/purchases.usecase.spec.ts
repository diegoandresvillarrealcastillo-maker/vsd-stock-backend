import { describe, expect, it } from 'vitest';
import { encodeCursor } from '../../domain/model/pagination.js';
import { ForbiddenError, NoMembershipError } from '../../domain/model/people-errors.js';
import type { ProductRecord } from '../../domain/ports/out/catalog.js';
import {
  OperationIdReusedError,
  PurchaseNotFoundError,
  WarehouseMissingError,
} from '../../domain/model/purchase-errors.js';
import {
  PURCHASE_FIELDS,
  purchaseFingerprint,
  readPurchase,
} from '../../domain/model/purchase-input.js';
import { InputReader, ValidationFailedError } from '../../domain/model/validation.js';
import { UserInactiveError } from '../../domain/ports/in/authenticate.js';
import { FakeCatalog } from '../../../test/support/fake-catalog.js';
import { FakePeople, fakeUnitOfWork } from '../../../test/support/fake-people.js';
import { FakePurchasing, WAREHOUSE_ID } from '../../../test/support/fake-purchasing.js';
import {
  ACTOR_ID,
  BUSINESS_ID,
  loneSession,
  memberSession,
} from '../../../test/support/sessions.js';
import { PurchasesUseCase } from './purchases.usecase.js';

const OPERATION = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const OPERATION_2 = '1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const OTHER = '99999999-9999-4999-8999-999999999999';

const RICE = 'f0000000-0000-4000-8000-0000000000a1'; // se cuenta en unidades enteras
const SUGAR = 'f0000000-0000-4000-8000-0000000000a2'; // se cuenta en kilos
const OLD = 'f0000000-0000-4000-8000-0000000000a3'; // archivado

const product = (id: string, overrides: Partial<ProductRecord>): ProductRecord => ({
  id,
  name: 'Producto',
  sku: id.slice(-2),
  barcode: null,
  unit: 'unit',
  unitPrice: 1000,
  taxRateBp: 0,
  taxKind: 'exempt',
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
    product(RICE, { name: 'Arroz', unit: 'unit' }),
    product(SUGAR, { name: 'Azúcar', unit: 'kilogram' }),
    product(OLD, { name: 'Viejo', active: false }),
  );
  const purchasing = new FakePurchasing();
  const work = fakeUnitOfWork(new FakePeople(), 'Tienda', catalog, purchasing);
  return { catalog, purchasing, work, useCase: new PurchasesUseCase(work) };
};

const line = (productId = RICE, quantityMilli = 5000, unitCost = 2500) => ({
  productId,
  quantityMilli,
  unitCost,
});
const body = (overrides: Record<string, unknown> = {}) => ({
  operationId: OPERATION,
  lines: [line()],
  ...overrides,
});

const failureOf = async (work: Promise<unknown>): Promise<ValidationFailedError> => {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ValidationFailedError);
  return error as ValidationFailedError;
};

describe('PurchasesUseCase', () => {
  describe('registering a purchase', () => {
    it('saves the purchase with its lines and adds the stock, in the warehouse of the business', async () => {
      const { purchasing, useCase } = setup();

      const { purchase, replayed } = await useCase.create(
        memberSession('admin'),
        body({
          note: 'Pedido de octubre',
          lines: [line(RICE, 24_000, 2500), line(SUGAR, 12_500, 4200)],
        }),
      );

      expect(replayed).toBe(false);
      expect(purchase).toMatchObject({
        operationId: OPERATION,
        warehouseId: WAREHOUSE_ID,
        supplierId: null,
        note: 'Pedido de octubre',
        createdByUserId: ACTOR_ID,
        lines: [
          { productId: RICE, quantityMilli: 24_000, unitCost: 2500 },
          { productId: SUGAR, quantityMilli: 12_500, unitCost: 4200 },
        ],
      });
      expect(purchasing.purchases.records).toHaveLength(1);
      expect(purchasing.stock.applied).toEqual([
        {
          operationId: OPERATION,
          changes: [
            { productId: RICE, delta: 24_000, reason: 'purchase', note: 'Pedido de octubre' },
            { productId: SUGAR, delta: 12_500, reason: 'purchase', note: 'Pedido de octubre' },
          ],
        },
      ]);
      expect(purchasing.stock.balances.get(SUGAR)).toBe(12_500);
    });

    it('claims the operation as a purchase made by who asked', async () => {
      const { purchasing, useCase } = setup();

      await useCase.create(memberSession('owner'), body());

      expect(purchasing.operations.claims.get(OPERATION)).toMatchObject({
        kind: 'purchase',
        userId: ACTOR_ID,
      });
    });

    it('works inside the business of the person who asks', async () => {
      const { work, useCase } = setup();

      await useCase.create(memberSession('owner'), body());

      expect(work.openedFor).toEqual([BUSINESS_ID]);
    });

    it('takes a supplier that exists in the business', async () => {
      const { purchasing, useCase } = setup();
      const supplier = await purchasing.suppliers.create({ name: 'Distribuidora', contact: null });

      const { purchase } = await useCase.create(
        memberSession('owner'),
        body({ supplierId: supplier.id.toUpperCase() }),
      );

      expect(purchase.supplierId).toBe(supplier.id);
    });

    it('buys by the thousandth only what is counted by the thousandth: kilos yes, units no', async () => {
      const { useCase } = setup();

      await expect(
        useCase.create(memberSession('owner'), body({ lines: [line(SUGAR, 1500)] })),
      ).resolves.toBeDefined();
      const failure = await failureOf(
        useCase.create(
          memberSession('owner'),
          body({ operationId: OPERATION_2, lines: [line(RICE, 1500)] }),
        ),
      );

      expect(failure.errors).toEqual([
        {
          pointer: '/lines/0/quantityMilli',
          code: 'not-whole',
          detail: 'Este producto se cuenta en unidades enteras: la cantidad no lleva decimales.',
        },
      ]);
    });

    it('buys a whole number of units written with its thousandths', async () => {
      const { purchasing, useCase } = setup();

      await useCase.create(memberSession('owner'), body({ lines: [line(RICE, 3000)] }));

      expect(purchasing.stock.balances.get(RICE)).toBe(3000);
    });
  });

  describe('what must exist', () => {
    it('says which product does not exist, which is archived and which supplier is unknown, all at once', async () => {
      const { purchasing, useCase } = setup();

      const failure = await failureOf(
        useCase.create(
          memberSession('owner'),
          body({
            supplierId: OTHER,
            lines: [line(RICE), line(OTHER), line(OLD), line(SUGAR, 1500)],
          }),
        ),
      );

      expect(failure.errors).toEqual([
        {
          pointer: '/supplierId',
          code: 'unknown-supplier',
          detail: 'No existe ese proveedor en este negocio.',
        },
        {
          pointer: '/lines/1/productId',
          code: 'unknown-product',
          detail: 'No existe ese producto en este negocio.',
        },
        {
          pointer: '/lines/2/productId',
          code: 'archived-product',
          detail: 'Este producto está archivado: reactívalo antes de comprarlo.',
        },
      ]);
      expect(purchasing.purchases.records).toEqual([]);
      expect(purchasing.stock.applied).toEqual([]);
    });

    it('does not look at the database when what was sent is not even well formed', async () => {
      const { work, useCase } = setup();

      const failure = await failureOf(useCase.create(memberSession('owner'), { lines: [] }));

      expect(failure.errors.map((e) => `${e.pointer}:${e.code}`)).toEqual([
        '/operationId:required',
        '/lines:too-few',
      ]);
      expect(work.openedFor).toEqual([]);
    });

    it('says the business has no warehouse instead of making one up', async () => {
      const { purchasing, useCase } = setup();
      purchasing.stock.warehouseRecord = null;

      await expect(useCase.create(memberSession('owner'), body())).rejects.toBeInstanceOf(
        WarehouseMissingError,
      );
      expect(purchasing.purchases.records).toEqual([]);
    });
  });

  describe('sending the same purchase again (ADR 0019)', () => {
    it('hands back the purchase already made and adds nothing', async () => {
      const { purchasing, useCase } = setup();
      const first = await useCase.create(memberSession('owner'), body());

      const again = await useCase.create(memberSession('owner'), body());

      expect(again.replayed).toBe(true);
      expect(again.purchase).toEqual(first.purchase);
      expect(purchasing.purchases.records).toHaveLength(1);
      expect(purchasing.stock.applied).toHaveLength(1);
      expect(purchasing.stock.balances.get(RICE)).toBe(5000);
    });

    it('recognizes it however the body is written, and from another person of the business', async () => {
      const { purchasing, useCase } = setup();
      await useCase.create(memberSession('owner'), body({ note: 'x' }));

      const again = await useCase.create(memberSession('admin'), {
        note: '  x ',
        lines: [{ unitCost: 2500, quantityMilli: 5000, productId: RICE.toUpperCase() }],
        operationId: OPERATION.toUpperCase(),
      });

      expect(again.replayed).toBe(true);
      expect(purchasing.purchases.records).toHaveLength(1);
    });

    it('answers the same even if the product was archived in the meantime: it was valid when it was made', async () => {
      const { catalog, useCase } = setup();
      await useCase.create(memberSession('owner'), body());
      const rice = catalog.products.find((p) => p.id === RICE) as ProductRecord;
      catalog.products.splice(catalog.products.indexOf(rice), 1, { ...rice, active: false });

      await expect(useCase.create(memberSession('owner'), body())).resolves.toMatchObject({
        replayed: true,
      });
    });

    it('does not invent a purchase when the operation is claimed but made none: that is a broken state, not a repetition', async () => {
      const { purchasing, useCase } = setup();
      const reader = new InputReader(body(), PURCHASE_FIELDS);
      await purchasing.operations.claim({
        operationId: OPERATION,
        kind: 'purchase',
        userId: ACTOR_ID,
        fingerprint: purchaseFingerprint(readPurchase(reader)),
      });

      await expect(useCase.create(memberSession('owner'), body())).rejects.toThrow(
        /claimed but has no purchase/,
      );
    });

    it.each([
      ['a quantity', { lines: [line(RICE, 5001)] }],
      ['a cost', { lines: [line(RICE, 5000, 2501)] }],
      ['the product', { lines: [line(SUGAR)] }],
      ['the note', { note: 'otra' }],
      ['a line more', { lines: [line(), line(SUGAR)] }],
    ])('refuses the same operation id with %s changed', async (_name, change) => {
      const { purchasing, useCase } = setup();
      await useCase.create(memberSession('owner'), body());

      await expect(useCase.create(memberSession('owner'), body(change))).rejects.toBeInstanceOf(
        OperationIdReusedError,
      );
      expect(purchasing.purchases.records).toHaveLength(1);
      expect(purchasing.stock.balances.get(RICE)).toBe(5000);
    });

    it('is a different purchase with a different operation id, even with the same lines', async () => {
      const { purchasing, useCase } = setup();
      await useCase.create(memberSession('owner'), body());

      const second = await useCase.create(
        memberSession('owner'),
        body({ operationId: OPERATION_2 }),
      );

      expect(second.replayed).toBe(false);
      expect(purchasing.purchases.records).toHaveLength(2);
      expect(purchasing.stock.balances.get(RICE)).toBe(10_000);
    });

    it('does not take as a repetition an operation id that another kind of operation holds', async () => {
      const { purchasing, useCase } = setup();
      await purchasing.operations.claim({
        operationId: OPERATION,
        kind: 'adjustment',
        userId: ACTOR_ID,
        fingerprint: 'otra cosa',
      });

      await expect(useCase.create(memberSession('owner'), body())).rejects.toBeInstanceOf(
        OperationIdReusedError,
      );
    });
  });

  describe('who can', () => {
    it('is for the management: an administrator can, a cashier can not', async () => {
      const { purchasing, useCase } = setup();

      await expect(useCase.create(memberSession('admin'), body())).resolves.toBeDefined();
      await expect(
        useCase.create(memberSession('cashier'), body({ operationId: OPERATION_2 })),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(purchasing.purchases.records).toHaveLength(1);
    });

    it('refuses a cashier before looking at what they sent', async () => {
      const { useCase } = setup();

      await expect(useCase.create(memberSession('cashier'), { basura: 1 })).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    });

    it('refuses a person with no business and a person who was let go', async () => {
      const { useCase } = setup();

      await expect(useCase.create(loneSession(), body())).rejects.toBeInstanceOf(NoMembershipError);
      await expect(
        useCase.create(memberSession('owner', { active: false }), body()),
      ).rejects.toBeInstanceOf(UserInactiveError);
    });
  });

  describe('listing', () => {
    const buy = async (useCase: PurchasesUseCase, n: number) => {
      const operationId = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
      return (await useCase.create(memberSession('owner'), body({ operationId, note: `n${n}` })))
        .purchase;
    };

    it('lists the newest first, without the lines but telling how many there are', async () => {
      const { useCase } = setup();
      await buy(useCase, 1);
      await useCase.create(
        memberSession('owner'),
        body({ operationId: OPERATION_2, lines: [line(RICE), line(SUGAR)] }),
      );

      const page = await useCase.list(memberSession('admin'), {});

      expect(page.items.map((p) => [p.operationId, p.lineCount])).toEqual([
        [OPERATION_2, 2],
        ['00000000-0000-4000-8000-000000000001', 1],
      ]);
      expect(page.items[0]).not.toHaveProperty('lines');
      expect(page.nextCursor).toBeNull();
    });

    it('walks the list in pages, following the cursor, without repeating or skipping', async () => {
      const { useCase } = setup();
      for (const n of [1, 2, 3, 4, 5]) await buy(useCase, n);

      const notes: (string | null)[] = [];
      let cursor: string | null | undefined;
      do {
        const page = await useCase.list(
          memberSession('owner'),
          cursor ? { limit: '2', cursor } : { limit: '2' },
        );
        notes.push(...page.items.map((p) => p.note));
        cursor = page.nextCursor;
      } while (cursor);

      expect(notes).toEqual(['n5', 'n4', 'n3', 'n2', 'n1']);
    });

    it('puts in the cursor the moment and the id of the last purchase it hands over', async () => {
      const { useCase } = setup();
      await buy(useCase, 1);
      const second = await buy(useCase, 2);
      await buy(useCase, 3);

      const page = await useCase.list(memberSession('owner'), { limit: '2' });

      expect(page.nextCursor).toBe(encodeCursor([second.createdAt.toISOString(), second.id]));
    });

    it.each([
      ['a moment that is not one', ['ayer', OTHER]],
      ['an id that is not a UUID', ['2026-10-17T12:00:00.000Z', 'no-es-un-uuid']],
    ])(
      'refuses a cursor with %s, which the database could not compare',
      async (_name, position) => {
        const { useCase } = setup();

        const failure = await failureOf(
          useCase.list(memberSession('owner'), { cursor: encodeCursor(position) }),
        );

        expect(failure.errors.map((e) => `${e.pointer}:${e.code}`)).toEqual([
          '/cursor:invalid-cursor',
        ]);
      },
    );

    it('is for the management', async () => {
      const { useCase } = setup();

      await expect(useCase.list(memberSession('cashier'), {})).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    });
  });

  describe('looking at one purchase', () => {
    it('hands it back with its lines', async () => {
      const { useCase } = setup();
      const { purchase } = await useCase.create(
        memberSession('owner'),
        body({ lines: [line(RICE), line(SUGAR, 1500, 9)] }),
      );

      const found = await useCase.get(memberSession('admin'), purchase.id);

      expect(found).toEqual(purchase);
      expect(found.lines).toHaveLength(2);
    });

    it('says there is no such purchase, also for an id that is not a UUID, without asking the database', async () => {
      const { work, useCase } = setup();

      await expect(useCase.get(memberSession('owner'), OTHER)).rejects.toBeInstanceOf(
        PurchaseNotFoundError,
      );
      work.openedFor.length = 0;
      await expect(useCase.get(memberSession('owner'), 'no-es-uuid')).rejects.toBeInstanceOf(
        PurchaseNotFoundError,
      );
      expect(work.openedFor).toEqual([]);
    });

    it('is for the management', async () => {
      const { useCase } = setup();

      await expect(useCase.get(memberSession('cashier'), OTHER)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    });
  });
});
