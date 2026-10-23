import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applicationUrlOf } from '../../scripts/prepare-database.ts';
import { createPrismaClient } from '../../src/adapters/out/persistence/create-prisma-client.js';
import { PrismaUnitOfWork } from '../../src/adapters/out/persistence/prisma-unit-of-work.js';
import { SalesUseCase } from '../../src/application/usecases/sales.usecase.js';
import type { TimeFlag } from '../../src/domain/model/operation-time.js';
import type { Role } from '../../src/domain/model/role.js';
import { requiresAttention } from '../../src/domain/model/sale-attention.js';
import { SaleNotFoundError, SaleVoidedError } from '../../src/domain/model/sale-errors.js';
import { ShiftRequiredError } from '../../src/domain/model/shift-errors.js';
import { SALE_FLAGS, type SaleFlag } from '../../src/domain/model/sale-flags.js';
import type { Session } from '../../src/domain/ports/in/authenticate.js';
import type { PaymentRecord, SaleLineRecord } from '../../src/domain/ports/out/sales.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { asApplication, createAdminPool } from './support/database.js';
import { BUSINESS_A, BUSINESS_B, resetData, seedBusiness, seedProduct } from './support/seed.js';
import { select } from './support/sql.js';

/**
 * La venta contra PostgreSQL real (C3-03, ADR 0013 y 0027): el caso de uso, el adaptador, los disparadores del libro y las
 * restricciones juntos. Lo que los dobles de memoria no pueden probar: que la venta es todo o nada, que dos envios iguales
 * a la vez venden una vez, que dos ventas del ultimo articulo marcan exactamente a la que sobra, que el folio repetido se
 * guarda y se marca, y que cerrar el turno espera a las ventas en curso.
 */
describe('sales against PostgreSQL (C3-03)', () => {
  let admin: pg.Pool;
  let prisma: PrismaClient;
  let unitOfWork: PrismaUnitOfWork;
  let sales: SalesUseCase;
  let a: Awaited<ReturnType<typeof seedBusiness>>;
  let b: Awaited<ReturnType<typeof seedBusiness>>;
  let shiftId: string;
  let cola: string;
  let bread: string;

  beforeAll(() => {
    admin = createAdminPool(3);
    prisma = createPrismaClient(applicationUrlOf(process.env['TEST_DATABASE_URL']!), { max: 12 });
    unitOfWork = new PrismaUnitOfWork(prisma);
    sales = new SalesUseCase(unitOfWork, { now: () => new Date() });
  });

  beforeEach(async () => {
    await resetData(admin);
    a = await seedBusiness(admin, BUSINESS_A);
    b = await seedBusiness(admin, BUSINESS_B);
    cola = await seedProduct(admin, BUSINESS_A);
    bread = await seedProduct(admin, BUSINESS_A, randomUUID(), { unit: 'kilogram' });
    shiftId = randomUUID();
    await unitOfWork.inBusiness(BUSINESS_A, (s) =>
      s.shifts.open({
        id: shiftId,
        deviceId: a.deviceId,
        userId: a.ownerId,
        openedAt: new Date(Date.now() - 3_600_000),
        openingAmount: 50_000,
      }),
    );
    await stockUp(cola, 100_000);
    await stockUp(bread, 100_000);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await admin.end();
  });

  const session = (userId: string, businessId = BUSINESS_A, role: Role = 'cashier'): Session => ({
    identity: { subject: randomUUID(), email: null, expiresAt: new Date(Date.now() + 3_600_000) },
    membership: { userId, businessId, role, active: true, fullName: 'Ana' },
  });

  /** Existencia que ya habia en el estante, escrita como un ajuste. */
  async function stockUp(productId: string, milli: number): Promise<void> {
    await unitOfWork.inBusiness(BUSINESS_A, async (s) => {
      const operationId = randomUUID();
      await s.operations.claim({
        operationId,
        kind: 'adjustment',
        userId: a.ownerId,
        fingerprint: operationId,
      });
      await s.stock.addMovements(operationId, [
        { productId, delta: milli, reason: 'adjustment', note: 'Inventario inicial' },
      ]);
    });
  }

  const quantityOf = async (productId: string) =>
    Number(
      (
        await select(admin, 'SELECT quantity FROM stock_balance WHERE product_id = $1', [productId])
      )[0]?.['quantity'],
    );

  let serial = 0;
  const body = (change: Record<string, unknown> = {}) => {
    serial += 1;
    return {
      operationId: randomUUID(),
      shiftId,
      folio: `ZZ-${String(serial).padStart(6, '0')}`,
      total: 3_000,
      lines: [
        {
          productId: cola,
          quantityMilli: 2_000,
          unitPrice: 1_000,
          discount: 0,
          taxRateBp: 1900,
          taxKind: 'taxed',
        },
        {
          productId: bread,
          quantityMilli: 1_500,
          unitPrice: 1_000,
          discount: 500,
          taxRateBp: 1900,
          taxKind: 'taxed',
        },
      ],
      payments: [
        { method: 'cash', amount: 2_000 },
        { method: 'card', amount: 1_000, reference: 'aprobacion 1' },
      ],
      deviceTime: new Date().toISOString(),
      clockOffsetMs: 0,
      ...change,
    };
  };

  const sell = (change: Record<string, unknown> = {}, userId = a.ownerId) =>
    sales.create(session(userId), body(change));

  describe('registering', () => {
    it('writes the sale, its lines, its payments and the movements of the stock, all together', async () => {
      const { sale, replayed } = await sell();

      expect(replayed).toBe(false);
      expect(sale).toMatchObject({
        shiftId,
        deviceId: a.deviceId,
        userId: a.ownerId,
        total: 3_000,
        needsAdjustment: false,
        folioConflict: false,
      });
      expect(await select(admin, 'SELECT count(*)::int AS n FROM sale')).toEqual([{ n: 1 }]);
      expect(await select(admin, 'SELECT count(*)::int AS n FROM sale_line')).toEqual([{ n: 2 }]);
      expect(await select(admin, 'SELECT count(*)::int AS n FROM payment')).toEqual([{ n: 2 }]);
      expect(await quantityOf(cola)).toBe(98_000);
      expect(await quantityOf(bread)).toBe(98_500);
      expect(
        await select(
          admin,
          "SELECT product_id, delta::int AS delta, reason FROM stock_movement WHERE reason = 'sale' ORDER BY product_id",
        ),
      ).toEqual(
        [
          { product_id: cola, delta: -2_000, reason: 'sale' },
          { product_id: bread, delta: -1_500, reason: 'sale' },
        ].sort((x, y) => (x.product_id < y.product_id ? -1 : 1)),
      );
    });

    it('records the operation as a sale of the device, with the time that the device said', async () => {
      const deviceTime = '2026-10-18T14:59:50.000Z';
      const { sale } = await sell({ deviceTime, clockOffsetMs: 4_000 });

      expect(sale.occurredAt).toBeInstanceOf(Date);
      expect(
        await select(
          admin,
          'SELECT kind, user_id, device_id, device_time_raw FROM operation WHERE operation_id = $1',
          [sale.operationId],
        ),
      ).toEqual([
        { kind: 'sale', user_id: a.ownerId, device_id: a.deviceId, device_time_raw: deviceTime },
      ]);
    });

    it('keeps the lines and the payments in the order that the device sold them, however many there are', async () => {
      const products = await Promise.all(
        Array.from({ length: 12 }, async () => {
          const id = await seedProduct(admin, BUSINESS_A);
          await stockUp(id, 20_000);
          return id;
        }),
      );
      const lines: SaleLineRecord[] = products.map((productId, index) => ({
        productId,
        quantityMilli: 1_000 * (index + 1),
        unitPrice: 100,
        discount: 0,
        taxRateBp: 0,
        taxKind: 'exempt',
      }));
      const payments: PaymentRecord[] = [
        { method: 'transfer', amount: 100, reference: 'primero' },
        { method: 'cash', amount: 200, reference: null },
        { method: 'card', amount: 300, reference: 'tercero' },
        { method: 'cash', amount: 7_200, reference: null },
      ];

      const payload = body({ total: 7_800, lines, payments });
      const { sale } = await sales.create(session(a.ownerId), payload);
      const again = await sales.create(session(a.ownerId), payload);

      expect(sale.lines.map((line) => line.productId)).toEqual(products);
      expect(sale.payments).toEqual(payments);
      expect(again.replayed).toBe(true);
      expect(again.sale.lines).toEqual(sale.lines);
      expect(again.sale.payments).toEqual(sale.payments);
    });

    it('keeps the price that the customer saw, not the one of the catalog', async () => {
      const { sale } = await sell({
        total: 1_500,
        lines: [
          {
            productId: cola,
            quantityMilli: 1_000,
            unitPrice: 1_500,
            discount: 0,
            taxRateBp: 0,
            taxKind: 'exempt',
          },
        ],
        payments: [{ method: 'cash', amount: 1_500 }],
      });

      expect(sale.lines).toEqual([
        {
          productId: cola,
          quantityMilli: 1_000,
          unitPrice: 1_500,
          discount: 0,
          taxRateBp: 0,
          taxKind: 'exempt',
        },
      ]);
      expect(sale.flags).toEqual(['price-differs']);
      expect(
        await select(admin, 'SELECT unit_price::int AS p, tax_rate_bp, tax_kind FROM sale_line'),
      ).toEqual([{ p: 1_500, tax_rate_bp: 0, tax_kind: 'exempt' }]);
    });

    it('stores the flags and reads them back in order', async () => {
      const { sale } = await sell({ folio: 'AB-000001', total: 1, payments: [] });

      expect(sale.flags).toEqual(['total-differs', 'payment-mismatch', 'folio-device']);
      expect(
        await select(admin, 'SELECT flags FROM sale WHERE operation_id = $1', [sale.operationId]),
      ).toEqual([{ flags: ['total-differs', 'payment-mismatch', 'folio-device'] }]);
    });

    it('accepts a sale of nothing, with no payments at all', async () => {
      const { sale } = await sell({
        total: 0,
        lines: [
          {
            productId: cola,
            quantityMilli: 1_000,
            unitPrice: 1_000,
            discount: 1_000,
            taxRateBp: 0,
            taxKind: 'exempt',
          },
        ],
        payments: [],
      });

      expect(sale.total).toBe(0);
      expect(sale.payments).toEqual([]);
      expect(await select(admin, 'SELECT count(*)::int AS n FROM payment')).toEqual([{ n: 0 }]);
    });
  });

  describe('the stock', () => {
    it('accepts a sale of more than there is, leaves the stock below zero and marks the sale', async () => {
      const lone = await seedProduct(admin, BUSINESS_A);
      await stockUp(lone, 1_000);

      const { sale } = await sell({
        total: 2_000,
        lines: [
          {
            productId: lone,
            quantityMilli: 2_000,
            unitPrice: 1_000,
            discount: 0,
            taxRateBp: 1900,
            taxKind: 'taxed',
          },
        ],
        payments: [{ method: 'cash', amount: 2_000 }],
      });

      expect(sale.needsAdjustment).toBe(true);
      expect(await quantityOf(lone)).toBe(-1_000);
    });

    it('does not mark a sale that leaves exactly nothing', async () => {
      const lone = await seedProduct(admin, BUSINESS_A);
      await stockUp(lone, 2_000);

      const { sale } = await sell({
        total: 2_000,
        lines: [
          {
            productId: lone,
            quantityMilli: 2_000,
            unitPrice: 1_000,
            discount: 0,
            taxRateBp: 1900,
            taxKind: 'taxed',
          },
        ],
        payments: [{ method: 'cash', amount: 2_000 }],
      });

      expect(sale.needsAdjustment).toBe(false);
      expect(await quantityOf(lone)).toBe(0);
    });

    it('marks exactly the sales that did not find stock when many sell the last items at once', async () => {
      const last = await seedProduct(admin, BUSINESS_A);
      await stockUp(last, 3_000);
      const oneUnit = {
        total: 1_000,
        lines: [
          {
            productId: last,
            quantityMilli: 1_000,
            unitPrice: 1_000,
            discount: 0,
            taxRateBp: 1900,
            taxKind: 'taxed',
          },
        ],
        payments: [{ method: 'cash', amount: 1_000 }],
      };

      const results = await Promise.all(Array.from({ length: 8 }, () => sell(oneUnit)));

      expect(results.filter((result) => result.sale.needsAdjustment)).toHaveLength(5);
      expect(await quantityOf(last)).toBe(-5_000);
    });

    it('reads the stock of products without movements as nothing', async () => {
      const fresh = await seedProduct(admin, BUSINESS_A);

      const quantities = await unitOfWork.inBusiness(BUSINESS_A, (s) =>
        s.stock.quantitiesOf([cola, fresh]),
      );

      expect(quantities.get(cola)).toBe(100_000);
      expect(quantities.get(fresh)).toBe(0);
    });
  });

  describe('repeating and racing', () => {
    it('sells once however many times the same sale arrives at the same time', async () => {
      const same = body();

      const results = await Promise.all(
        Array.from({ length: 6 }, () => sales.create(session(a.ownerId), same)),
      );

      expect(results.filter((result) => !result.replayed)).toHaveLength(1);
      expect(new Set(results.map((result) => result.sale.id)).size).toBe(1);
      expect(await select(admin, 'SELECT count(*)::int AS n FROM sale')).toEqual([{ n: 1 }]);
      expect(await quantityOf(cola)).toBe(98_000);
      expect(
        await select(admin, "SELECT count(*)::int AS n FROM stock_movement WHERE reason = 'sale'"),
      ).toEqual([{ n: 2 }]);
    });

    it('refuses the same operation with another sale and leaves nothing of it', async () => {
      const first = await sell();

      await expect(sell({ operationId: first.sale.operationId, total: 1 })).rejects.toThrow();

      expect(await quantityOf(cola)).toBe(98_000);
      expect(await select(admin, 'SELECT count(*)::int AS n FROM sale')).toEqual([{ n: 1 }]);
    });

    it('is all or nothing: if something fails after the movements, nothing is left, not even the claim', async () => {
      const operationId = randomUUID();

      await expect(
        unitOfWork.inBusiness(BUSINESS_A, async (s) => {
          await s.operations.claim({
            operationId,
            kind: 'sale',
            userId: a.ownerId,
            fingerprint: 'x',
            deviceId: a.deviceId,
          });
          await s.stock.addMovements(operationId, [
            { productId: cola, delta: -1_000, reason: 'sale', note: null },
          ]);
          await s.sales.create({
            operationId,
            shiftId,
            folio: 'ZZ-900001',
            total: 1_000,
            needsAdjustment: false,
            flags: [],
            lines: [
              {
                productId: cola,
                quantityMilli: 1_000,
                unitPrice: 1_000,
                discount: 0,
                taxRateBp: 0,
                taxKind: 'exempt',
              },
            ],
            payments: [{ method: 'cash', amount: 1_000, reference: null }],
          });
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      expect(await quantityOf(cola)).toBe(100_000);
      expect(await select(admin, 'SELECT count(*)::int AS n FROM sale')).toEqual([{ n: 0 }]);
      expect(
        await select(admin, 'SELECT count(*)::int AS n FROM operation WHERE kind = $1', ['sale']),
      ).toEqual([{ n: 0 }]);
    });

    it('does not claim the operation of a sale it refused, so the same operation can be sent again corrected', async () => {
      const same = body({
        lines: [
          {
            productId: randomUUID(),
            quantityMilli: 1_000,
            unitPrice: 1,
            discount: 0,
            taxRateBp: 0,
            taxKind: 'exempt',
          },
        ],
        total: 1,
        payments: [{ method: 'cash', amount: 1 }],
      });
      await expect(sales.create(session(a.ownerId), same)).rejects.toThrow();

      const fixed = {
        ...same,
        lines: [
          {
            productId: cola,
            quantityMilli: 1_000,
            unitPrice: 1_000,
            discount: 0,
            taxRateBp: 1900,
            taxKind: 'taxed',
          },
        ],
        total: 1_000,
        payments: [{ method: 'cash', amount: 1_000 }],
      };
      const { replayed } = await sales.create(session(a.ownerId), fixed);

      expect(replayed).toBe(false);
    });
  });

  describe('the folio', () => {
    it('keeps a sale whose folio is already another one, under another folio and marked', async () => {
      const first = await sell({ folio: 'ZZ-000777' });

      const second = await sell({ folio: 'ZZ-000777' });

      expect(first.sale.folio).toBe('ZZ-000777');
      expect(second.sale).toMatchObject({
        folio: `ZZ-000777~${second.sale.operationId.slice(0, 8)}`,
        folioReported: 'ZZ-000777',
        folioConflict: true,
      });
      expect(
        await select(
          admin,
          'SELECT folio, folio_reported, folio_conflict FROM sale ORDER BY folio',
        ),
      ).toHaveLength(2);
    });

    it('keeps both when two sales with the same folio arrive at the same time', async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, () => sell({ folio: 'ZZ-000888' })),
      );

      expect(results.filter((result) => result.sale.folioConflict)).toHaveLength(4);
      expect(new Set(results.map((result) => result.sale.folio)).size).toBe(5);
      expect(results.every((result) => result.sale.folioReported === 'ZZ-000888')).toBe(true);
      expect(await select(admin, 'SELECT count(*)::int AS n FROM sale')).toEqual([{ n: 5 }]);
    });

    it('is not a conflict with the folio of another business', async () => {
      await sell({ folio: 'ZZ-000555' });
      const otherProduct = await seedProduct(admin, BUSINESS_B);
      const otherShift = randomUUID();
      await unitOfWork.inBusiness(BUSINESS_B, (s) =>
        s.shifts.open({
          id: otherShift,
          deviceId: b.deviceId,
          userId: b.ownerId,
          openedAt: new Date(Date.now() - 3_600_000),
          openingAmount: 0,
        }),
      );

      const { sale } = await sales.create(session(b.ownerId, BUSINESS_B), {
        ...body({ folio: 'ZZ-000555', total: 1_000 }),
        shiftId: otherShift,
        lines: [
          {
            productId: otherProduct,
            quantityMilli: 1_000,
            unitPrice: 1_000,
            discount: 0,
            taxRateBp: 1900,
            taxKind: 'taxed',
          },
        ],
        payments: [{ method: 'cash', amount: 1_000 }],
      });

      expect(sale.folioConflict).toBe(false);
      expect(sale.folio).toBe('ZZ-000555');
    });
  });

  describe('the shift', () => {
    it('makes closing it wait for a sale that is in progress, so the cash count does not miss it', async () => {
      let releaseSale: () => void = () => undefined;
      const saleMayEnd = new Promise<void>((resolve) => {
        releaseSale = resolve;
      });
      let lockTaken: () => void = () => undefined;
      const locked = new Promise<void>((resolve) => {
        lockTaken = resolve;
      });

      const inProgress = unitOfWork.inBusiness(BUSINESS_A, async (s) => {
        await s.shifts.lockShared(shiftId);
        lockTaken();
        await saleMayEnd;
      });
      await locked;
      let closed = false;
      const closing = unitOfWork
        .inBusiness(BUSINESS_A, (s) =>
          s.shifts.close(shiftId, {
            closedAt: new Date(),
            closedByUserId: a.ownerId,
            countedAmount: 50_000,
          }),
        )
        .then(() => {
          closed = true;
        });

      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(closed).toBe(false);
      releaseSale();
      await inProgress;
      await closing;
      expect(closed).toBe(true);
    });

    it('accepts a sale that happened after the shift was closed, marks it and shows it apart in the cash count', async () => {
      await unitOfWork.inBusiness(BUSINESS_A, (s) =>
        s.shifts.close(shiftId, {
          closedAt: new Date(Date.now() - 60_000),
          closedByUserId: a.ownerId,
          countedAmount: 50_000,
        }),
      );

      const { sale } = await sell({ deviceTime: new Date().toISOString() });
      const totals = await unitOfWork.inBusiness(BUSINESS_A, (s) => s.shifts.totals(shiftId));

      expect(sale.flags).toEqual(['late-shift']);
      expect(totals).toMatchObject({ cashSales: 0, late: { count: 1, cashAmount: 2_000 } });
    });

    it('counts the cash of a sale made before the closing, even when it arrives after it', async () => {
      const closedAt = new Date(Date.now() - 60_000);
      await unitOfWork.inBusiness(BUSINESS_A, (s) =>
        s.shifts.close(shiftId, { closedAt, closedByUserId: a.ownerId, countedAmount: 50_000 }),
      );

      const { sale } = await sell({
        deviceTime: new Date(closedAt.getTime() - 120_000).toISOString(),
      });
      const totals = await unitOfWork.inBusiness(BUSINESS_A, (s) => s.shifts.totals(shiftId));

      expect(sale.flags).toEqual([]);
      expect(totals).toMatchObject({ cashSales: 2_000, late: { count: 0, cashAmount: 0 } });
    });
  });

  describe('the order of what was sold', () => {
    it('asks the database for the order, because rows come back in the order they were written', async () => {
      const operationId = randomUUID();
      const saleId = randomUUID();
      await admin.query(
        `INSERT INTO operation (id_negocio, operation_id, kind, user_id, device_id) VALUES ($1, $2, 'sale', $3, $4)`,
        [BUSINESS_A, operationId, a.ownerId, a.deviceId],
      );
      await admin.query(
        `INSERT INTO sale (id, id_negocio, operation_id, shift_id, folio, folio_reported, total, needs_adjustment)
         VALUES ($1, $2, $3, $4, 'ZZ-777000', 'ZZ-777000', 3, false)`,
        [saleId, BUSINESS_A, operationId, shiftId],
      );
      // Escritas al reves: la fila fisica de la posicion 2 va primero.
      for (const position of [2, 0, 1]) {
        await admin.query(
          `INSERT INTO sale_line (id_negocio, sale_id, product_id, quantity_milli, unit_price, tax_rate_bp, tax_kind, position)
           VALUES ($1, $2, $3, $4, 1, 0, 'exempt', $5)`,
          [BUSINESS_A, saleId, cola, 1000 * (position + 1), position],
        );
      }
      for (const position of [1, 0]) {
        await admin.query(
          `INSERT INTO payment (id_negocio, sale_id, method, amount, position) VALUES ($1, $2, 'cash', $3, $4)`,
          [BUSINESS_A, saleId, position + 1, position],
        );
      }

      const found = await unitOfWork.inBusiness(BUSINESS_A, (s) =>
        s.sales.findByOperation(operationId),
      );

      expect(found?.lines.map((line) => line.quantityMilli)).toEqual([1000, 2000, 3000]);
      expect(found?.payments.map((payment) => payment.amount)).toEqual([1, 2]);
    });
  });

  describe('who sees it', () => {
    it('is not visible to another business, not even by its operation', async () => {
      const { sale } = await sell();

      const seen = await unitOfWork.inBusiness(BUSINESS_B, (s) =>
        s.sales.findByOperation(sale.operationId),
      );

      expect(seen).toBeNull();
    });

    it('is not found when no operation made it', async () => {
      const seen = await unitOfWork.inBusiness(BUSINESS_A, (s) =>
        s.sales.findByOperation(randomUUID()),
      );

      expect(seen).toBeNull();
    });
  });

  describe('what the database refuses by itself', () => {
    const insertSale =
      (flags: string, folio = 'ZZ-100000', folioReported = 'ZZ-100000') =>
      async () => {
        const operationId = randomUUID();
        await admin.query(
          `INSERT INTO operation (id_negocio, operation_id, kind, user_id) VALUES ($1, $2, 'sale', $3)`,
          [BUSINESS_A, operationId, a.ownerId],
        );
        await admin.query(
          `INSERT INTO sale (id_negocio, operation_id, shift_id, folio, folio_reported, total, needs_adjustment, flags)
           VALUES ($1, $2, $3, $4, $5, 1, false, ${flags})`,
          [BUSINESS_A, operationId, shiftId, folio, folioReported],
        );
      };

    it('has exactly the flags of the domain in its check, no more and no fewer', async () => {
      const [row] = await select(
        admin,
        "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = 'sale_flags_known'",
      );
      const allowed = [...String(row?.['definition']).matchAll(/'([a-z-]+)'/g)].map(
        (match) => match[1],
      );

      expect([...allowed].sort()).toEqual([...SALE_FLAGS].sort());
    });

    it('knows every flag of the domain and no other', async () => {
      await expect(
        insertSale(`ARRAY['${SALE_FLAGS.join("','")}']::text[]`)(),
      ).resolves.toBeUndefined();
      await expect(
        insertSale("ARRAY['otra-marca']::text[]", 'ZZ-100001', 'ZZ-100001')(),
      ).rejects.toThrow(/sale_flags_known/);
    });

    it('keeps the order of the lines and of the payments within a range the device can not exceed', async () => {
      const insertLine = (position: number) => async () => {
        const operationId = randomUUID();
        await admin.query(
          `INSERT INTO operation (id_negocio, operation_id, kind, user_id) VALUES ($1, $2, 'sale', $3)`,
          [BUSINESS_A, operationId, a.ownerId],
        );
        const saleId = randomUUID();
        await admin.query(
          `INSERT INTO sale (id, id_negocio, operation_id, shift_id, folio, folio_reported, total, needs_adjustment)
           VALUES ($1, $2, $3, $4, $5, $5, 1, false)`,
          [saleId, BUSINESS_A, operationId, shiftId, `ZZ-${randomUUID().slice(0, 6)}`],
        );
        return { saleId, position };
      };
      const line = async (position: number) => {
        const { saleId } = await insertLine(position)();
        await admin.query(
          `INSERT INTO sale_line (id_negocio, sale_id, product_id, quantity_milli, unit_price, tax_rate_bp, tax_kind, position)
           VALUES ($1, $2, $3, 1000, 1, 0, 'exempt', $4)`,
          [BUSINESS_A, saleId, cola, position],
        );
        await admin.query(
          `INSERT INTO payment (id_negocio, sale_id, method, amount, position) VALUES ($1, $2, 'cash', 1, $3)`,
          [BUSINESS_A, saleId, Math.min(position, 9)],
        );
      };

      await expect(line(0)).resolves.toBeUndefined();
      await expect(line(199)).resolves.toBeUndefined();
      await expect(line(200)).rejects.toThrow(/sale_line_position_range/);
      await expect(line(-1)).rejects.toThrow(/sale_line_position_range/);
      const payment = async (position: number) => {
        const { saleId } = await insertLine(position)();
        await admin.query(
          `INSERT INTO payment (id_negocio, sale_id, method, amount, position) VALUES ($1, $2, 'cash', 1, $3)`,
          [BUSINESS_A, saleId, position],
        );
      };
      await expect(payment(9)).resolves.toBeUndefined();
      await expect(payment(10)).rejects.toThrow(/payment_position_range/);
      await expect(payment(-1)).rejects.toThrow(/payment_position_range/);
    });

    it('wants a folio that says something', async () => {
      await expect(insertSale("'{}'::text[]", '', 'ZZ-3')()).rejects.toThrow(/sale_folio_shape/);
      await expect(insertSale("'{}'::text[]", 'ZZ-4', '')()).rejects.toThrow(/sale_folio_shape/);
    });

    it('wants a folio of reasonable size', async () => {
      await expect(insertSale("'{}'::text[]", 'x'.repeat(61), 'ZZ-1')()).rejects.toThrow(
        /sale_folio_shape/,
      );
      await expect(insertSale("'{}'::text[]", 'ZZ-2', 'x'.repeat(41))()).rejects.toThrow(
        /sale_folio_shape/,
      );
    });
  });

  describe('reading and reviewing (C3-04)', () => {
    const manager = () => session(a.ownerId, BUSINESS_A, 'owner');

    let planted = 0;
    interface Planted {
      readonly id?: string;
      readonly at?: string;
      readonly shift?: string;
      readonly userId?: string;
      readonly folio?: string;
      readonly folioReported?: string;
      readonly folioConflict?: boolean;
      readonly needsAdjustment?: boolean;
      readonly flags?: readonly SaleFlag[];
      readonly timeFlags?: readonly TimeFlag[];
      readonly reviewed?: boolean;
    }

    /** Escribe una venta con exactamente lo que se pide, sin pasar por el caso de uso: la hora y las marcas las fija la prueba. */
    async function plant(spec: Planted = {}): Promise<string> {
      planted += 1;
      const operationId = randomUUID();
      const id = spec.id ?? randomUUID();
      const folio = spec.folio ?? `PL-${String(planted).padStart(6, '0')}`;
      await admin.query(
        `INSERT INTO operation (id_negocio, operation_id, kind, user_id, device_id, occurred_at, received_at, time_flags)
         VALUES ($1, $2, 'sale', $3, $4, $5::timestamptz, now(), $6::text[])`,
        [
          BUSINESS_A,
          operationId,
          spec.userId ?? a.ownerId,
          a.deviceId,
          spec.at ?? new Date().toISOString(),
          [...(spec.timeFlags ?? [])],
        ],
      );
      await admin.query(
        `INSERT INTO sale (id, id_negocio, operation_id, shift_id, folio, folio_reported, folio_conflict, total,
                           needs_adjustment, flags)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 1000, $8, $9::text[])`,
        [
          id,
          BUSINESS_A,
          operationId,
          spec.shift ?? shiftId,
          folio,
          spec.folioReported ?? folio,
          spec.folioConflict ?? false,
          spec.needsAdjustment ?? false,
          [...(spec.flags ?? [])],
        ],
      );
      if (spec.reviewed === true) {
        await admin.query(
          `INSERT INTO sale_review (id_negocio, sale_id, user_id, note) VALUES ($1, $2, $3, 'Revisada')`,
          [BUSINESS_A, id, a.ownerId],
        );
      }
      return id;
    }

    /** Todas las paginas de una consulta, en el orden en que salen. */
    async function everything(query: Record<string, unknown>, as = manager()): Promise<string[]> {
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await sales.list(as, {
          limit: '2',
          ...query,
          ...(cursor === null ? {} : { cursor }),
        });
        ids.push(...page.items.map((sale) => sale.id));
        cursor = page.nextCursor;
      } while (cursor !== null);
      return ids;
    }

    describe('the list', () => {
      it('goes from the newest to the oldest by the hour it happened, not by the hour it arrived', async () => {
        const morning = await plant({ at: '2026-10-18T10:00:00.000Z' });
        const noon = await plant({ at: '2026-10-18T12:00:00.000Z' });
        const late = await plant({ at: '2026-10-18T11:00:00.000Z' });

        const page = await sales.list(manager(), {});

        expect(page.items.map((sale) => sale.id)).toEqual([noon, late, morning]);
        expect(page.nextCursor).toBeNull();
      });

      it('pages without repeating or skipping, even where two sales share a millisecond', async () => {
        // Misma milesima de segundo, distinta millonesima: manda el identificador, que aqui va al reves de la hora.
        const newest = await plant({ at: '2026-10-18T10:00:01.000000Z' });
        const early = await plant({
          id: '00000000-0000-4000-8000-000000000002',
          at: '2026-10-18T10:00:00.000100Z',
        });
        const late = await plant({
          id: '00000000-0000-4000-8000-000000000001',
          at: '2026-10-18T10:00:00.000900Z',
        });
        const before = await plant({ at: '2026-10-18T09:59:59.000000Z' });
        const oldest = await plant({ at: '2026-10-18T09:00:00.000000Z' });

        expect(await everything({})).toEqual([newest, early, late, before, oldest]);
        expect((await sales.list(manager(), { limit: '2' })).nextCursor).not.toBeNull();
        expect((await sales.list(manager(), { limit: '5' })).nextCursor).toBeNull();
      });

      it('shows the sales of one shift', async () => {
        const other = randomUUID();
        const cashier = await seedUser('cashier');
        await unitOfWork.inBusiness(BUSINESS_A, (s) =>
          s.shifts.open({
            id: other,
            deviceId: a.deviceId,
            userId: cashier,
            openedAt: new Date(Date.now() - 1_800_000),
            openingAmount: 0,
          }),
        );
        const mine = await plant({ at: '2026-10-18T10:00:00.000Z' });
        const theirs = await plant({
          at: '2026-10-18T11:00:00.000Z',
          shift: other,
          userId: cashier,
        });

        expect(await everything({ shiftId: shiftId })).toEqual([mine]);
        expect(await everything({ shiftId: other })).toEqual([theirs]);
        expect(await everything({})).toEqual([theirs, mine]);
      });

      it('shows a cashier only the sales of his own shifts, and the management all of them', async () => {
        const other = randomUUID();
        const cashier = await seedUser('cashier');
        await unitOfWork.inBusiness(BUSINESS_A, (s) =>
          s.shifts.open({
            id: other,
            deviceId: a.deviceId,
            userId: cashier,
            openedAt: new Date(Date.now() - 1_800_000),
            openingAmount: 0,
          }),
        );
        const ofOwner = await plant({ at: '2026-10-18T10:00:00.000Z' });
        const ofCashier = await plant({
          at: '2026-10-18T11:00:00.000Z',
          shift: other,
          userId: cashier,
        });

        expect(await everything({}, session(cashier, BUSINESS_A, 'cashier'))).toEqual([ofCashier]);
        expect(await everything({}, session(a.ownerId, BUSINESS_A, 'cashier'))).toEqual([ofOwner]);
        expect(await everything({}, session(a.ownerId, BUSINESS_A, 'admin'))).toEqual([
          ofCashier,
          ofOwner,
        ]);
      });

      it('gives of each sale all that the sale says itself, and not what only the whole sale carries', async () => {
        const reviewer = await seedUser('admin');
        await sell({ folio: 'ZZ-000500' });
        const clash = await sell({
          folio: 'ZZ-000500',
          total: 1,
          deviceTime: '2026-10-18T10:00:00.000Z',
          clockOffsetMs: 0,
        });
        await sales.review(session(reviewer, BUSINESS_A, 'admin'), clash.sale.id, {
          note: 'Revisada a mano',
        });
        const whole = await sales.get(manager(), clash.sale.id);
        const header = Object.fromEntries(
          Object.entries(whole).filter(([key]) => !['lines', 'payments', 'summary'].includes(key)),
        );

        const listed = (await sales.list(manager(), {})).items.find(
          (item) => item.id === clash.sale.id,
        );

        expect(listed).toEqual(header);
        // Lo que la prueba necesita para ser fuerte: cada campo dice algo distinto de los demas.
        expect(whole.folio).not.toBe(whole.folioReported);
        expect(whole.receivedAt.getTime()).not.toBe(whole.occurredAt.getTime());
        expect(whole.review).toMatchObject({
          reviewedByUserId: reviewer,
          note: 'Revisada a mano',
        });
        expect(whole.deviceId).not.toBeNull();
      });

      it('never gives more rows than it was asked for', async () => {
        for (let index = 0; index < 3; index += 1) await plant();

        const rows = await unitOfWork.inBusiness(BUSINESS_A, (s) => s.sales.list({ limit: 2 }));

        expect(rows).toHaveLength(2);
      });

      it('shows a cashier the sales of his shifts, whoever registered them', async () => {
        const cashier = await seedUser('cashier');
        const mine = randomUUID();
        await unitOfWork.inBusiness(BUSINESS_A, (s) =>
          s.shifts.open({
            id: mine,
            deviceId: a.deviceId,
            userId: cashier,
            openedAt: new Date(Date.now() - 1_800_000),
            openingAmount: 0,
          }),
        );
        const ofHisShift = await plant({ shift: mine, userId: a.ownerId });
        await plant({ userId: cashier });

        expect(await everything({}, session(cashier, BUSINESS_A, 'cashier'))).toEqual([ofHisShift]);
      });

      it('also finds a sale by the folio under which it was stored', async () => {
        const stored = await plant({
          folio: 'AA-000142~1a2b3c4d',
          folioReported: 'AA-000142',
          folioConflict: true,
        });
        await plant({ folio: 'AA-000142' });

        const rows = await unitOfWork.inBusiness(BUSINESS_A, (s) =>
          s.sales.list({ limit: 10, folio: 'AA-000142~1a2b3c4d' }),
        );

        expect(rows.map((row) => row.id)).toEqual([stored]);
      });

      it('finds a sale by the folio that the device printed, also when it was saved with another one', async () => {
        const first = await plant({ folio: 'AA-000142', at: '2026-10-18T10:00:00.000Z' });
        const repeated = await plant({
          folio: 'AA-000142~1a2b3c4d',
          folioReported: 'AA-000142',
          folioConflict: true,
          at: '2026-10-18T11:00:00.000Z',
        });
        await plant({ folio: 'AA-000143' });

        expect(await everything({ folio: 'AA-000142' })).toEqual([repeated, first]);
        expect(await everything({ folio: 'AA-000999' })).toEqual([]);
        expect(await everything({ folio: 'aa-000142' })).toEqual([repeated, first]);
      });

      it('does not show the sales of another business', async () => {
        await plant();
        const otherSeller = await unitOfWork.inBusiness(BUSINESS_B, (s) =>
          s.sales.list({ limit: 10 }),
        );

        expect(otherSeller).toEqual([]);
      });
    });

    describe('the tray «Requiere atención»', () => {
      it('holds what asks for attention and nobody has reviewed, for every combination that the domain knows', async () => {
        const timeCases: readonly (readonly TimeFlag[])[] = [
          [],
          ['clock-unverified'],
          ['stale'],
          ['clock-skew'],
          ['future'],
          ['unreadable'],
          ['clock-unverified', 'stale'],
        ];
        const planned: { id: string; asks: boolean; reviewed: boolean }[] = [];
        let minute = 0;
        for (const needsAdjustment of [false, true]) {
          for (const folioConflict of [false, true]) {
            for (const flags of [[], ['price-differs']] as const) {
              for (const timeFlags of timeCases) {
                for (const reviewed of [false, true]) {
                  minute += 1;
                  const id = await plant({
                    at: new Date(Date.UTC(2026, 9, 18, 0, minute)).toISOString(),
                    needsAdjustment,
                    folioConflict,
                    flags,
                    timeFlags,
                    reviewed,
                    ...(folioConflict
                      ? {
                          folioReported: 'AA-000001',
                          folio: `AA-000001~${String(minute).padStart(8, '0')}`,
                        }
                      : {}),
                  });
                  planned.push({
                    id,
                    asks: requiresAttention({ needsAdjustment, folioConflict, flags, timeFlags }),
                    reviewed,
                  });
                }
              }
            }
          }
        }
        const newestFirst = [...planned].reverse();

        const inTray = await everything({ attention: 'true' });
        const outside = await everything({ attention: 'false' });

        expect(inTray).toEqual(
          newestFirst.filter((sale) => sale.asks && !sale.reviewed).map((sale) => sale.id),
        );
        expect(outside).toEqual(
          newestFirst.filter((sale) => !(sale.asks && !sale.reviewed)).map((sale) => sale.id),
        );
        // Tanto la lista como la venta dicen lo mismo que la bandeja.
        const listed = await sales.list(manager(), { limit: '200' });
        for (const sale of listed.items) {
          expect(sale.attention, sale.id).toBe(inTray.includes(sale.id));
        }
        const one = planned.find((sale) => sale.asks && !sale.reviewed);
        expect((await sales.get(manager(), one!.id)).attention).toBe(true);
        const reviewedOne = planned.find((sale) => sale.asks && sale.reviewed);
        expect((await sales.get(manager(), reviewedOne!.id)).attention).toBe(false);
      });

      it('leaves a sale out of the tray once somebody reviews it, without changing the sale', async () => {
        const id = await plant({
          needsAdjustment: true,
          flags: ['price-differs'],
          timeFlags: ['future'],
        });
        const before = await sales.get(manager(), id);
        expect(await everything({ attention: 'true' })).toEqual([id]);

        const outcome = await sales.review(manager(), id, { note: 'Se ajustó el inventario' });

        expect(outcome.replayed).toBe(false);
        expect(outcome.review).toMatchObject({
          reviewedByUserId: a.ownerId,
          note: 'Se ajustó el inventario',
        });
        expect(await everything({ attention: 'true' })).toEqual([]);
        expect(await everything({ attention: 'false' })).toEqual([id]);
        const after = await sales.get(manager(), id);
        expect(after).toEqual({ ...before, attention: false, review: outcome.review });
        expect(after.flags).toEqual(['price-differs']);
        expect(after.needsAdjustment).toBe(true);
        expect(
          await select(admin, 'SELECT flags, needs_adjustment FROM sale WHERE id = $1', [id]),
        ).toEqual([{ flags: ['price-differs'], needs_adjustment: true }]);
      });
    });

    describe('the review', () => {
      it('is made once: the second time gives back the first, with its author, its hour and its note', async () => {
        const id = await plant({ needsAdjustment: true });
        const second = await seedUser('admin');

        const first = await sales.review(manager(), id, { note: 'Primera' });
        const again = await sales.review(session(second, BUSINESS_A, 'admin'), id, {
          note: 'Segunda',
        });

        expect(first.replayed).toBe(false);
        expect(again.replayed).toBe(true);
        expect(again.review).toEqual(first.review);
        expect(again.review).toMatchObject({ reviewedByUserId: a.ownerId, note: 'Primera' });
        expect(await select(admin, 'SELECT count(*)::int AS n FROM sale_review')).toEqual([
          { n: 1 },
        ]);
      });

      it('writes a single review when several people review at the same time', async () => {
        const id = await plant({ needsAdjustment: true });
        const people = await Promise.all([seedUser('admin'), seedUser('admin'), seedUser('admin')]);

        const outcomes = await Promise.all([
          sales.review(manager(), id, {}),
          ...people.map((userId) => sales.review(session(userId, BUSINESS_A, 'admin'), id, {})),
        ]);

        expect(outcomes.filter((outcome) => !outcome.replayed)).toHaveLength(1);
        expect(new Set(outcomes.map((outcome) => outcome.review.reviewedByUserId)).size).toBe(1);
        expect(await select(admin, 'SELECT count(*)::int AS n FROM sale_review')).toEqual([
          { n: 1 },
        ]);
      });

      it('gives back the review of the sale that was asked for when several were reviewed', async () => {
        // Identificadores fijos: la base devuelve las filas ordenadas por venta, y la primera revision es la de menor identificador.
        const first = await plant({
          id: '00000000-0000-4000-8000-0000000000a1',
          needsAdjustment: true,
        });
        const second = await plant({
          id: '00000000-0000-4000-8000-0000000000a2',
          needsAdjustment: true,
        });
        const other = await seedUser('admin');
        await sales.review(manager(), first, { note: 'de la primera' });

        const outcome = await sales.review(session(other, BUSINESS_A, 'admin'), second, {
          note: 'de la segunda',
        });

        expect(outcome.review).toMatchObject({ note: 'de la segunda', reviewedByUserId: other });
        expect((await sales.get(manager(), first)).review?.note).toBe('de la primera');
      });

      it('can be made without a note', async () => {
        const id = await plant({ needsAdjustment: true });

        const { review } = await sales.review(manager(), id, {});

        expect(review.note).toBeNull();
      });

      it('does not exist for a sale that is not there, nor for the sale of another business', async () => {
        const id = await plant({ needsAdjustment: true });

        await expect(sales.review(manager(), randomUUID(), {})).rejects.toBeInstanceOf(
          SaleNotFoundError,
        );
        await expect(
          sales.review(session(b.ownerId, BUSINESS_B, 'owner'), id, {}),
        ).rejects.toBeInstanceOf(SaleNotFoundError);
        await expect(sales.get(session(b.ownerId, BUSINESS_B, 'owner'), id)).rejects.toBeInstanceOf(
          SaleNotFoundError,
        );
        expect(await select(admin, 'SELECT count(*)::int AS n FROM sale_review')).toEqual([
          { n: 0 },
        ]);
      });

      it('is not visible to another business', async () => {
        const id = await plant({ needsAdjustment: true, reviewed: true });

        const seen = await asApplication(admin, BUSINESS_B, (client) =>
          client.query('SELECT 1 FROM sale_review WHERE sale_id = $1', [id]),
        );

        expect(seen.rowCount).toBe(0);
      });
    });

    describe('what the database refuses by itself', () => {
      it('never changes or erases a review, not even for whoever owns the table', async () => {
        const id = await plant({ needsAdjustment: true, reviewed: true });

        await expect(
          admin.query(`UPDATE sale_review SET note = 'Otra' WHERE sale_id = $1`, [id]),
        ).rejects.toThrow(/append-only/);
        await expect(
          admin.query('DELETE FROM sale_review WHERE sale_id = $1', [id]),
        ).rejects.toThrow(/append-only/);
        await expect(admin.query('TRUNCATE sale_review')).rejects.toThrow(/append-only/);
        await expect(
          asApplication(admin, BUSINESS_A, (client) =>
            client.query(`UPDATE sale_review SET note = 'Otra'`),
          ),
        ).rejects.toThrow(/permission denied/);
        await expect(
          asApplication(admin, BUSINESS_A, (client) => client.query('DELETE FROM sale_review')),
        ).rejects.toThrow(/permission denied/);
      });

      it('wants a note of one line and of 200 characters at the most, or none', async () => {
        const note = async (text: string | null) => {
          const id = await plant({ needsAdjustment: true });
          await admin.query(
            `INSERT INTO sale_review (id_negocio, sale_id, user_id, note) VALUES ($1, $2, $3, $4)`,
            [BUSINESS_A, id, a.ownerId, text],
          );
        };

        await expect(note(null)).resolves.toBeUndefined();
        await expect(note('x')).resolves.toBeUndefined();
        await expect(note('x'.repeat(200))).resolves.toBeUndefined();
        await expect(note('')).rejects.toThrow(/sale_review_note_shape/);
        await expect(note('x'.repeat(201))).rejects.toThrow(/sale_review_note_shape/);
        await expect(note('dos\nlíneas')).rejects.toThrow(/sale_review_note_shape/);
        await expect(note('con\ttabulador')).rejects.toThrow(/sale_review_note_shape/);
      });

      it('wants the sale and the person of the same business as the review', async () => {
        const id = await plant({ needsAdjustment: true });

        await expect(
          admin.query(
            `INSERT INTO sale_review (id_negocio, sale_id, user_id) VALUES ($1, $2, $3)`,
            [BUSINESS_A, id, b.ownerId],
          ),
        ).rejects.toThrow(/sale_review_id_negocio_user_id_fkey/);
        await expect(
          admin.query(
            `INSERT INTO sale_review (id_negocio, sale_id, user_id) VALUES ($1, $2, $3)`,
            [BUSINESS_B, id, b.ownerId],
          ),
        ).rejects.toThrow(/sale_review_id_negocio_sale_id_fkey/);
      });

      it('does not let a business write a review as if it were another one', async () => {
        const id = await plant({ needsAdjustment: true });

        await expect(
          asApplication(admin, BUSINESS_B, (client) =>
            client.query(
              `INSERT INTO sale_review (id_negocio, sale_id, user_id) VALUES ($1, $2, $3)`,
              [BUSINESS_A, id, a.ownerId],
            ),
          ),
        ).rejects.toThrow(/row-level security policy/);
      });

      it('lets a sale be reviewed once, however the second try gets in', async () => {
        const id = await plant({ needsAdjustment: true, reviewed: true });

        await expect(
          admin.query(
            `INSERT INTO sale_review (id_negocio, sale_id, user_id) VALUES ($1, $2, $3)`,
            [BUSINESS_A, id, a.ownerId],
          ),
        ).rejects.toThrow(/sale_review_sale_unique/);
      });
    });

    /** Una persona más del negocio A. */
    async function seedUser(role: 'admin' | 'cashier'): Promise<string> {
      const id = randomUUID();
      await admin.query(
        `INSERT INTO app_user (id, id_negocio, auth_user_id, full_name, role) VALUES ($1, $2, $3, 'Otra persona', $4)`,
        [id, BUSINESS_A, randomUUID(), role],
      );
      return id;
    }
  });

  describe('voiding (C3-05)', () => {
    const owner = () => session(a.ownerId, BUSINESS_A, 'owner');
    const voidBody = (change: Record<string, unknown> = {}) => ({
      operationId: randomUUID(),
      shiftId,
      reason: 'Se equivocó',
      ...change,
    });

    /** Una persona de la gerencia con su propio turno abierto. */
    async function managerWithShift(): Promise<{ userId: string; shift: string; as: Session }> {
      const userId = randomUUID();
      await admin.query(
        `INSERT INTO app_user (id, id_negocio, auth_user_id, full_name, role) VALUES ($1, $2, $3, 'Gerente', 'admin')`,
        [userId, BUSINESS_A, randomUUID()],
      );
      const shift = randomUUID();
      await unitOfWork.inBusiness(BUSINESS_A, (s) =>
        s.shifts.open({
          id: shift,
          deviceId: a.deviceId,
          userId,
          openedAt: new Date(Date.now() - 600_000),
          openingAmount: 0,
        }),
      );
      return { userId, shift, as: session(userId, BUSINESS_A, 'admin') };
    }

    const count = async (table: string, where = 'true', params: unknown[] = []) =>
      Number(
        (
          await select(admin, `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params)
        )[0]?.['n'],
      );

    it('gives back the stock and the cash, adds a void, and keeps the sale exactly as it was', async () => {
      const { sale } = await sell();
      const body = voidBody();

      const { sale: voided, replayed } = await sales.voidSale(owner(), sale.id, body);

      expect(replayed).toBe(false);
      expect(await quantityOf(cola)).toBe(100_000);
      expect(await quantityOf(bread)).toBe(100_000);
      expect(
        await select(
          admin,
          `SELECT product_id, delta::int AS delta, reason FROM stock_movement WHERE operation_id = $1 ORDER BY product_id`,
          [body.operationId],
        ),
      ).toEqual(
        [
          { product_id: cola, delta: 2_000, reason: 'void' },
          { product_id: bread, delta: 1_500, reason: 'void' },
        ].sort((x, y) => (x.product_id < y.product_id ? -1 : 1)),
      );
      expect(
        await select(
          admin,
          `SELECT shift_id, direction, amount::int AS amount, reason FROM cash_movement WHERE operation_id = $1`,
          [body.operationId],
        ),
      ).toEqual([
        {
          shift_id: shiftId,
          direction: 'out',
          amount: 2_000,
          reason: `Anulación de ${sale.folio}`,
        },
      ]);
      expect(
        await select(admin, `SELECT kind, user_id FROM operation WHERE operation_id = $1`, [
          body.operationId,
        ]),
      ).toEqual([{ kind: 'sale_void', user_id: a.ownerId }]);
      expect(
        await select(admin, `SELECT reason FROM sale_void WHERE sale_id = $1`, [sale.id]),
      ).toEqual([{ reason: 'Se equivocó' }]);
      expect(voided.voided).toMatchObject({
        operationId: body.operationId,
        voidedByUserId: a.ownerId,
        reason: 'Se equivocó',
      });
      expect(voided).toMatchObject({
        total: sale.total,
        lines: sale.lines,
        payments: sale.payments,
        flags: sale.flags,
      });
      expect(await count('sale')).toBe(1);
      expect(await count('sale_line')).toBe(2);
      expect(await count('payment')).toBe(2);
    });

    it('takes the cash out of the shift of whoever voids, which can be another person than the seller', async () => {
      const { sale } = await sell();
      const other = await managerWithShift();

      await sales.voidSale(other.as, sale.id, voidBody({ shiftId: other.shift }));

      expect(
        await select(admin, `SELECT shift_id, amount::int AS amount FROM cash_movement`),
      ).toEqual([{ shift_id: other.shift, amount: 2_000 }]);
    });

    it('shows who voided it, which is not who sold it, in the list and one by one', async () => {
      const { sale } = await sell();
      const other = await managerWithShift();
      await sales.voidSale(other.as, sale.id, voidBody({ shiftId: other.shift }));

      const listed = (await sales.list(owner(), {})).items[0];
      const one = await sales.get(owner(), sale.id);

      expect(sale.userId).toBe(a.ownerId);
      expect(listed?.voided?.voidedByUserId).toBe(other.userId);
      expect(one.voided?.voidedByUserId).toBe(other.userId);
    });

    it('tells apart the sales that were voided from those that were not, in the list and one by one', async () => {
      const first = await sell();
      const second = await sell();
      const third = await sell();
      const bodyOfFirst = voidBody({ reason: 'Primera' });
      await sales.voidSale(owner(), first.sale.id, bodyOfFirst);
      await sales.voidSale(owner(), third.sale.id, voidBody({ reason: 'Tercera' }));

      const listed = (await sales.list(owner(), {})).items;

      expect(listed).toHaveLength(3);
      const reasonOf = (id: string) =>
        listed.find((item) => item.id === id)?.voided?.reason ?? null;
      expect(reasonOf(first.sale.id)).toBe('Primera');
      expect(reasonOf(second.sale.id)).toBeNull();
      expect(reasonOf(third.sale.id)).toBe('Tercera');
      expect((await sales.get(owner(), second.sale.id)).voided).toBeNull();
      expect((await sales.get(owner(), first.sale.id)).voided?.reason).toBe('Primera');
      expect((await sales.get(owner(), third.sale.id)).voided?.reason).toBe('Tercera');
    });

    it('answers a repeated request with the sale of that operation, when other sales were voided as well', async () => {
      const first = await sell();
      const second = await sell();
      const bodyOfFirst = voidBody({ reason: 'Primera' });
      await sales.voidSale(owner(), first.sale.id, bodyOfFirst);
      await sales.voidSale(owner(), second.sale.id, voidBody({ reason: 'Segunda' }));

      const again = await sales.voidSale(owner(), first.sale.id, bodyOfFirst);

      expect(again.replayed).toBe(true);
      expect(again.sale.id).toBe(first.sale.id);
      expect(again.sale.voided?.reason).toBe('Primera');
    });

    it('shows the void in the list and one by one', async () => {
      const { sale } = await sell();
      const { sale: voided } = await sales.voidSale(owner(), sale.id, voidBody());

      const listed = (await sales.list(owner(), {})).items[0];
      const one = await sales.get(owner(), sale.id);

      expect(listed?.voided).toEqual(voided.voided);
      expect(one.voided).toEqual(voided.voided);
      expect(voided.voided).not.toBeNull();
    });

    it('is all or nothing: when the cash can not go back nothing stays, not even the claim, and it can be sent again', async () => {
      const { sale } = await sell();
      const body = voidBody({ shiftId: randomUUID() });

      await expect(sales.voidSale(owner(), sale.id, body)).rejects.toBeInstanceOf(
        ShiftRequiredError,
      );

      expect(await count('operation', 'operation_id = $1', [body.operationId])).toBe(0);
      expect(await count('sale_void')).toBe(0);
      expect(await count('stock_movement', "reason = 'void'")).toBe(0);
      expect(await quantityOf(cola)).toBe(98_000);
      await expect(sales.voidSale(owner(), sale.id, { ...body, shiftId })).resolves.toMatchObject({
        replayed: false,
      });
    });

    it('needs the shift to be open: one that was closed in the meantime does not receive the cash', async () => {
      const { sale } = await sell();
      const other = await managerWithShift();
      await admin.query(
        `UPDATE cash_shift SET closed_at = now(), counted_amount = 0, closed_by_user_id = user_id WHERE id = $1`,
        [other.shift],
      );

      await expect(
        sales.voidSale(other.as, sale.id, voidBody({ shiftId: other.shift })),
      ).rejects.toBeInstanceOf(ShiftRequiredError);
      expect(await count('cash_movement')).toBe(0);
    });

    it('voids a sale once however many ask at the same time: the others find it already voided and leave nothing behind', async () => {
      const { sale } = await sell();
      const people = await Promise.all([
        managerWithShift(),
        managerWithShift(),
        managerWithShift(),
      ]);

      const results = await Promise.allSettled(
        people.map((person) =>
          sales.voidSale(person.as, sale.id, voidBody({ shiftId: person.shift })),
        ),
      );

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      for (const result of results) {
        if (result.status === 'rejected') {
          expect(result.reason).toBeInstanceOf(SaleVoidedError);
        }
      }
      // Lo que las perdedoras hicieron antes de enterarse se deshizo con ellas.
      expect(await quantityOf(cola)).toBe(100_000);
      expect(await quantityOf(bread)).toBe(100_000);
      expect(await count('sale_void')).toBe(1);
      expect(await count('cash_movement')).toBe(1);
      expect(await count('stock_movement', "reason = 'void'")).toBe(2);
      expect(await count('operation', "kind = 'sale_void'")).toBe(1);
    });

    it('answers a repeated request with the same sale however many are sent at once, and writes once', async () => {
      const { sale } = await sell();
      const body = voidBody();

      const outcomes = await Promise.all(
        Array.from({ length: 5 }, () => sales.voidSale(owner(), sale.id, body)),
      );

      expect(outcomes.filter((outcome) => !outcome.replayed)).toHaveLength(1);
      expect(new Set(outcomes.map((outcome) => outcome.sale.voided?.operationId))).toEqual(
        new Set([body.operationId]),
      );
      expect(await count('stock_movement', "reason = 'void'")).toBe(2);
      expect(await count('cash_movement')).toBe(1);
    });

    it('does not exist for another business: it can not void what it can not see', async () => {
      const { sale } = await sell();

      await expect(
        sales.voidSale(session(b.ownerId, BUSINESS_B, 'owner'), sale.id, voidBody()),
      ).rejects.toBeInstanceOf(SaleNotFoundError);
      expect(await count('sale_void')).toBe(0);
    });

    describe('the folio of the void (C4-A1, ADR 0036)', () => {
      const folioOf = (outcome: { sale: { voided: { folio: string } | null } }) =>
        outcome.sale.voided?.folio;
      const numbers = async (): Promise<number[]> =>
        (await select(admin, 'SELECT number FROM sale_void ORDER BY number')).map((row) =>
          Number(row['number']),
        );
      const nextNumber = async (businessId = BUSINESS_A): Promise<number | null> => {
        const rows = await select(
          admin,
          'SELECT next_number FROM void_counter WHERE id_negocio = $1',
          [businessId],
        );
        return rows.length === 0 ? null : Number(rows[0]?.['next_number']);
      };

      it('numbers the voids from 1, one after the other, in the order they are made and whichever sale they void', async () => {
        const first = await sell();
        const second = await sell();
        const third = await sell();

        const ofThird = await sales.voidSale(owner(), third.sale.id, voidBody());
        const ofFirst = await sales.voidSale(owner(), first.sale.id, voidBody());
        const ofSecond = await sales.voidSale(owner(), second.sale.id, voidBody());

        expect([ofThird, ofFirst, ofSecond].map(folioOf)).toEqual([
          'ANU-000001',
          'ANU-000002',
          'ANU-000003',
        ]);
        expect(await numbers()).toEqual([1, 2, 3]);
        expect(
          await select(
            admin,
            `SELECT s.folio, v.number FROM sale_void v JOIN sale s ON s.id = v.sale_id ORDER BY v.number`,
          ),
        ).toEqual([
          { folio: third.sale.folio, number: 1 },
          { folio: first.sale.folio, number: 2 },
          { folio: second.sale.folio, number: 3 },
        ]);
      });

      it('shows the folio of each void in the list and one by one, and none in the sales that were not voided', async () => {
        const first = await sell();
        const second = await sell();
        const third = await sell();
        await sales.voidSale(owner(), first.sale.id, voidBody());
        await sales.voidSale(owner(), third.sale.id, voidBody());

        const listed = (await sales.list(owner(), {})).items;
        const folioInList = (id: string) => listed.find((item) => item.id === id)?.voided?.folio;

        expect(folioInList(first.sale.id)).toBe('ANU-000001');
        expect(folioInList(second.sale.id)).toBeUndefined();
        expect(folioInList(third.sale.id)).toBe('ANU-000002');
        expect((await sales.get(owner(), first.sale.id)).voided?.folio).toBe('ANU-000001');
        expect((await sales.get(owner(), second.sale.id)).voided).toBeNull();
        expect((await sales.get(owner(), third.sale.id)).voided?.folio).toBe('ANU-000002');
      });

      it('answers a repeated request with the same folio and takes no new number', async () => {
        const first = await sell();
        const second = await sell();
        const body = voidBody();
        await sales.voidSale(owner(), first.sale.id, body);

        const again = await sales.voidSale(owner(), first.sale.id, body);
        const next = await sales.voidSale(owner(), second.sale.id, voidBody());

        expect(again.replayed).toBe(true);
        expect(folioOf(again)).toBe('ANU-000001');
        expect(folioOf(next)).toBe('ANU-000002');
        expect(await numbers()).toEqual([1, 2]);
        expect(await nextNumber()).toBe(3);
      });

      it('leaves no hole when a void is refused: it takes no number, and the claim goes with it', async () => {
        const first = await sell();
        const second = await sell();
        await sales.voidSale(owner(), first.sale.id, voidBody());

        await expect(sales.voidSale(owner(), first.sale.id, voidBody())).rejects.toBeInstanceOf(
          SaleVoidedError,
        );
        await expect(
          sales.voidSale(owner(), second.sale.id, voidBody({ shiftId: randomUUID() })),
        ).rejects.toBeInstanceOf(ShiftRequiredError);
        const next = await sales.voidSale(owner(), second.sale.id, voidBody());

        expect(folioOf(next)).toBe('ANU-000002');
        expect(await numbers()).toEqual([1, 2]);
        expect(await nextNumber()).toBe(3);
      });

      it('does not touch the counter of a business that never voided anything', async () => {
        await sell();

        expect(await nextNumber()).toBeNull();
      });

      it('gives consecutive numbers, with no repeats and no holes, to voids made at the same time', async () => {
        const made = [];
        for (let i = 0; i < 6; i += 1) made.push(await sell());

        const outcomes = await Promise.all(
          made.map(({ sale }) => sales.voidSale(owner(), sale.id, voidBody())),
        );

        expect(new Set(outcomes.map(folioOf))).toEqual(
          new Set([1, 2, 3, 4, 5, 6].map((n) => `ANU-00000${String(n)}`)),
        );
        expect(await numbers()).toEqual([1, 2, 3, 4, 5, 6]);
        expect(await nextNumber()).toBe(7);
      });

      it('takes a number only for the one that wins when many ask to void the same sale at once', async () => {
        const { sale } = await sell();
        const other = await sell();
        const people = await Promise.all([
          managerWithShift(),
          managerWithShift(),
          managerWithShift(),
        ]);

        await Promise.allSettled(
          people.map((person) =>
            sales.voidSale(person.as, sale.id, voidBody({ shiftId: person.shift })),
          ),
        );
        const next = await sales.voidSale(owner(), other.sale.id, voidBody());

        expect(await count('sale_void')).toBe(2);
        expect(await numbers()).toEqual([1, 2]);
        expect(folioOf(next)).toBe('ANU-000002');
      });

      it('lets each business count its own voids from 1', async () => {
        const { sale } = await sell();
        await sales.voidSale(owner(), sale.id, voidBody());
        const again = await sell();
        await sales.voidSale(owner(), again.sale.id, voidBody());
        const productOfB = await seedProduct(admin, BUSINESS_B);
        const shiftOfB = randomUUID();
        await unitOfWork.inBusiness(BUSINESS_B, async (scope) => {
          await scope.shifts.open({
            id: shiftOfB,
            deviceId: b.deviceId,
            userId: b.ownerId,
            openedAt: new Date(Date.now() - 3_600_000),
            openingAmount: 0,
          });
          const operationId = randomUUID();
          await scope.operations.claim({
            operationId,
            kind: 'adjustment',
            userId: b.ownerId,
            fingerprint: operationId,
          });
          await scope.stock.addMovements(operationId, [
            { productId: productOfB, delta: 10_000, reason: 'adjustment', note: 'Inventario' },
          ]);
        });
        const ownerOfB = session(b.ownerId, BUSINESS_B, 'owner');
        const { sale: saleOfB } = await sales.create(
          ownerOfB,
          body({
            shiftId: shiftOfB,
            total: 1_000,
            lines: [
              {
                productId: productOfB,
                quantityMilli: 1_000,
                unitPrice: 1_000,
                discount: 0,
                taxRateBp: 1900,
                taxKind: 'taxed',
              },
            ],
            payments: [{ method: 'card', amount: 1_000, reference: 'aprobacion' }],
          }),
        );

        const ofB = await sales.voidSale(ownerOfB, saleOfB.id, voidBody({ shiftId: null }));

        expect(folioOf(ofB)).toBe('ANU-000001');
        expect(await nextNumber(BUSINESS_A)).toBe(3);
        expect(await nextNumber(BUSINESS_B)).toBe(2);
      });

      it('is refused by the database itself when a number repeats inside a business, is below 1 or is missing', async () => {
        const first = await sell();
        const second = await sell();
        await sales.voidSale(owner(), first.sale.id, voidBody());
        const operationId = randomUUID();
        await admin.query(
          `INSERT INTO operation (id_negocio, operation_id, kind, user_id) VALUES ($1, $2, 'sale_void', $3)`,
          [BUSINESS_A, operationId, a.ownerId],
        );
        const insert = (number: number | null) =>
          admin.query(
            `INSERT INTO sale_void (id_negocio, sale_id, operation_id, reason, number) VALUES ($1, $2, $3, 'Prueba', $4)`,
            [BUSINESS_A, second.sale.id, operationId, number],
          );

        await expect(insert(1)).rejects.toMatchObject({ code: '23505' });
        await expect(insert(0)).rejects.toMatchObject({ code: '23514' });
        await expect(insert(null)).rejects.toMatchObject({ code: '23502' });
        expect(await count('sale_void')).toBe(1);
      });

      it('keeps the counter from going back to a number that was already given', async () => {
        const { sale } = await sell();
        await sales.voidSale(owner(), sale.id, voidBody());

        await expect(
          admin.query(`UPDATE void_counter SET next_number = 1 WHERE id_negocio = $1`, [
            BUSINESS_A,
          ]),
        ).rejects.toMatchObject({ code: '23514' });
      });
    });
  });
});
