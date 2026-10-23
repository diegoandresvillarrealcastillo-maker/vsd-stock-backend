import { describe, expect, it } from 'vitest';
import { ForbiddenError, NoMembershipError } from '../../domain/model/people-errors.js';
import { OperationIdReusedError } from '../../domain/model/purchase-errors.js';
import {
  ADJUSTMENT_FIELDS,
  adjustmentFingerprint,
  readAdjustment,
} from '../../domain/model/stock-input.js';
import { InputReader, ValidationFailedError } from '../../domain/model/validation.js';
import { UserInactiveError } from '../../domain/ports/in/authenticate.js';
import type { ProductRecord } from '../../domain/ports/out/catalog.js';
import { FakeCatalog } from '../../../test/support/fake-catalog.js';
import { FakePeople, fakeUnitOfWork } from '../../../test/support/fake-people.js';
import { FakePurchasing } from '../../../test/support/fake-purchasing.js';
import {
  ACTOR_ID,
  BUSINESS_ID,
  loneSession,
  memberSession,
} from '../../../test/support/sessions.js';
import { StockAdjustmentsUseCase } from './stock-adjustments.usecase.js';

const OPERATION = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const OPERATION_2 = '1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const OTHER = '99999999-9999-4999-8999-999999999999';
const RICE = 'f0000000-0000-4000-8000-0000000000a1'; // unidades enteras
const SUGAR = 'f0000000-0000-4000-8000-0000000000a2'; // kilos
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
    product(RICE, { name: 'Arroz' }),
    product(SUGAR, { name: 'Azúcar', unit: 'kilogram' }),
    product(OLD, { name: 'Viejo', active: false }),
  );
  const purchasing = new FakePurchasing();
  const work = fakeUnitOfWork(new FakePeople(), 'Tienda', catalog, purchasing);
  return { catalog, purchasing, work, useCase: new StockAdjustmentsUseCase(work) };
};

const body = (overrides: Record<string, unknown> = {}) => ({
  operationId: OPERATION,
  productId: RICE,
  deltaMilli: -2000,
  reason: 'Se cayeron dos paquetes',
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

describe('StockAdjustmentsUseCase', () => {
  describe('adjusting', () => {
    it('adds a movement that goes down, with the reason as its note, and hands it back', async () => {
      const { purchasing, useCase } = setup();
      purchasing.stock.balances.set(RICE, 10_000);

      const { movement, replayed } = await useCase.adjust(memberSession('admin'), body());

      expect(replayed).toBe(false);
      expect(movement).toMatchObject({
        operationId: OPERATION,
        productId: RICE,
        kind: 'adjustment',
        deltaMilli: -2000,
        reason: 'Se cayeron dos paquetes',
      });
      expect(purchasing.stock.applied).toEqual([
        {
          operationId: OPERATION,
          changes: [
            {
              productId: RICE,
              delta: -2000,
              reason: 'adjustment',
              note: 'Se cayeron dos paquetes',
            },
          ],
        },
      ]);
      expect(purchasing.stock.balances.get(RICE)).toBe(8000);
    });

    it('adds a movement that goes up', async () => {
      const { purchasing, useCase } = setup();

      await useCase.adjust(memberSession('owner'), body({ deltaMilli: 3000, reason: 'Conteo' }));

      expect(purchasing.stock.balances.get(RICE)).toBe(3000);
    });

    it('lets the existence go below zero: the books say what happened and a person corrects it', async () => {
      const { purchasing, useCase } = setup();
      purchasing.stock.balances.set(RICE, 1000);

      await useCase.adjust(memberSession('owner'), body({ deltaMilli: -5000 }));

      expect(purchasing.stock.balances.get(RICE)).toBe(-4000);
    });

    it('is never an edit of the balance: it only adds one movement', async () => {
      const { purchasing, useCase } = setup();
      purchasing.stock.balances.set(RICE, 7000);

      await useCase.adjust(memberSession('owner'), body({ deltaMilli: 1000 }));
      await useCase.adjust(
        memberSession('owner'),
        body({ operationId: OPERATION_2, deltaMilli: 1000 }),
      );

      expect(purchasing.stock.book).toHaveLength(2);
      expect(purchasing.stock.balances.get(RICE)).toBe(9000);
    });

    it('claims the operation as an adjustment made by who asked', async () => {
      const { purchasing, useCase } = setup();

      await useCase.adjust(memberSession('owner'), body());

      expect(purchasing.operations.claims.get(OPERATION)).toMatchObject({
        kind: 'adjustment',
        userId: ACTOR_ID,
      });
    });

    it('works inside the business of the person who asks', async () => {
      const { work, useCase } = setup();

      await useCase.adjust(memberSession('owner'), body());

      expect(work.openedFor).toEqual([BUSINESS_ID]);
    });

    it('adjusts an archived product too: what it still has must be written off', async () => {
      const { purchasing, useCase } = setup();

      await useCase.adjust(memberSession('owner'), body({ productId: OLD, deltaMilli: -1000 }));

      expect(purchasing.stock.balances.get(OLD)).toBe(-1000);
    });

    it('takes thousandths only for what is counted by weight or volume: kilos yes, units no', async () => {
      const { purchasing, useCase } = setup();

      await useCase.adjust(memberSession('owner'), body({ productId: SUGAR, deltaMilli: -1500 }));
      const failure = await failureOf(
        useCase.adjust(
          memberSession('owner'),
          body({ operationId: OPERATION_2, productId: RICE, deltaMilli: 1500 }),
        ),
      );

      expect(purchasing.stock.balances.get(SUGAR)).toBe(-1500);
      expect(failure.errors).toEqual([
        {
          pointer: '/deltaMilli',
          code: 'not-whole',
          detail: 'Este producto se cuenta en unidades enteras: la cantidad no lleva decimales.',
        },
      ]);
    });

    it('takes a negative whole number of units written with its thousandths', async () => {
      const { purchasing, useCase } = setup();

      await useCase.adjust(memberSession('owner'), body({ deltaMilli: -3000 }));

      expect(purchasing.stock.balances.get(RICE)).toBe(-3000);
    });
  });

  describe('what must exist', () => {
    it('says the product does not exist in this business', async () => {
      const { purchasing, useCase } = setup();

      const failure = await failureOf(
        useCase.adjust(memberSession('owner'), body({ productId: OTHER })),
      );

      expect(failure.errors).toEqual([
        {
          pointer: '/productId',
          code: 'unknown-product',
          detail: 'No existe ese producto en este negocio.',
        },
      ]);
      expect(purchasing.stock.book).toEqual([]);
    });

    it('does not look at the database when what was sent is not even well formed', async () => {
      const { work, useCase } = setup();

      const failure = await failureOf(
        useCase.adjust(memberSession('owner'), { deltaMilli: 0, extra: 1 }),
      );

      expect(failure.errors.map((e) => `${e.pointer}:${e.code}`)).toEqual([
        '/extra:unknown-field',
        '/operationId:required',
        '/productId:required',
        '/deltaMilli:zero-delta',
        '/reason:required',
      ]);
      expect(work.openedFor).toEqual([]);
    });
  });

  describe('sending the same adjustment again (ADR 0019)', () => {
    it('hands back the movement already made and adds nothing', async () => {
      const { purchasing, useCase } = setup();
      const first = await useCase.adjust(memberSession('owner'), body());

      const again = await useCase.adjust(memberSession('owner'), body());

      expect(again.replayed).toBe(true);
      expect(again.movement).toEqual(first.movement);
      expect(purchasing.stock.book).toHaveLength(1);
      expect(purchasing.stock.balances.get(RICE)).toBe(-2000);
    });

    it('recognizes it however the body is written, and from another person of the business', async () => {
      const { purchasing, useCase } = setup();
      await useCase.adjust(memberSession('owner'), body());

      const again = await useCase.adjust(memberSession('admin'), {
        reason: '  Se cayeron dos paquetes ',
        deltaMilli: -2000,
        productId: RICE.toUpperCase(),
        operationId: OPERATION.toUpperCase(),
      });

      expect(again.replayed).toBe(true);
      expect(purchasing.stock.book).toHaveLength(1);
    });

    it('answers the same even if the product was archived in the meantime', async () => {
      const { catalog, useCase } = setup();
      await useCase.adjust(memberSession('owner'), body());
      catalog.products.splice(0, catalog.products.length);

      await expect(useCase.adjust(memberSession('owner'), body())).resolves.toMatchObject({
        replayed: true,
      });
    });

    it.each([
      ['the quantity', { deltaMilli: -3000 }],
      ['the sign', { deltaMilli: 2000 }],
      ['the product', { productId: SUGAR }],
      ['the reason', { reason: 'Otro motivo' }],
    ])('refuses the same operation id with %s changed', async (_name, change) => {
      const { purchasing, useCase } = setup();
      await useCase.adjust(memberSession('owner'), body());

      await expect(useCase.adjust(memberSession('owner'), body(change))).rejects.toBeInstanceOf(
        OperationIdReusedError,
      );
      expect(purchasing.stock.book).toHaveLength(1);
    });

    it('does not take as a repetition an operation id that a purchase holds', async () => {
      const { purchasing, useCase } = setup();
      await purchasing.operations.claim({
        operationId: OPERATION,
        kind: 'purchase',
        userId: ACTOR_ID,
        fingerprint: 'otra cosa',
      });

      await expect(useCase.adjust(memberSession('owner'), body())).rejects.toBeInstanceOf(
        OperationIdReusedError,
      );
    });

    it('does not invent a movement when the operation is claimed but wrote none: that is a broken state, not a repetition', async () => {
      const { purchasing, useCase } = setup();
      const reader = new InputReader(body(), ADJUSTMENT_FIELDS);
      await purchasing.operations.claim({
        operationId: OPERATION,
        kind: 'adjustment',
        userId: ACTOR_ID,
        fingerprint: adjustmentFingerprint(readAdjustment(reader)),
      });

      await expect(useCase.adjust(memberSession('owner'), body())).rejects.toThrow(
        /claimed but has no movement/,
      );
    });

    it('says so when the movement it just wrote cannot be read back, instead of answering with nothing', async () => {
      const { purchasing, useCase } = setup();
      purchasing.stock.movementOfOperation = () => Promise.resolve(null);

      await expect(useCase.adjust(memberSession('owner'), body())).rejects.toThrow(/vanished/);
    });

    it('is a different adjustment with a different operation id, even with the same data', async () => {
      const { purchasing, useCase } = setup();
      await useCase.adjust(memberSession('owner'), body());

      const second = await useCase.adjust(
        memberSession('owner'),
        body({ operationId: OPERATION_2 }),
      );

      expect(second.replayed).toBe(false);
      expect(purchasing.stock.balances.get(RICE)).toBe(-4000);
    });
  });

  describe('who can', () => {
    it('is for the management: an administrator can, a cashier can not', async () => {
      const { purchasing, useCase } = setup();

      await expect(useCase.adjust(memberSession('admin'), body())).resolves.toBeDefined();
      await expect(
        useCase.adjust(memberSession('cashier'), body({ operationId: OPERATION_2 })),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(purchasing.stock.book).toHaveLength(1);
    });

    it('refuses a cashier before looking at what they sent', async () => {
      const { useCase } = setup();

      await expect(useCase.adjust(memberSession('cashier'), { basura: 1 })).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    });

    it('refuses a person with no business and a person who was let go', async () => {
      const { useCase } = setup();

      await expect(useCase.adjust(loneSession(), body())).rejects.toBeInstanceOf(NoMembershipError);
      await expect(
        useCase.adjust(memberSession('owner', { active: false }), body()),
      ).rejects.toBeInstanceOf(UserInactiveError);
    });
  });
});
