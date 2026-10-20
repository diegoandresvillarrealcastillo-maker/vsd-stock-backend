import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applicationUrlOf } from '../../scripts/prepare-database.ts';
import { createPrismaClient } from '../../src/adapters/out/persistence/create-prisma-client.js';
import { PrismaUnitOfWork } from '../../src/adapters/out/persistence/prisma-unit-of-work.js';
import { SalesUseCase } from '../../src/application/usecases/sales.usecase.js';
import { SALE_FLAGS } from '../../src/domain/model/sale-flags.js';
import type { Session } from '../../src/domain/ports/in/authenticate.js';
import type { PaymentRecord, SaleLineRecord } from '../../src/domain/ports/out/sales.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { createAdminPool } from './support/database.js';
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

  const session = (userId: string, businessId = BUSINESS_A): Session => ({
    identity: { subject: randomUUID(), email: null, expiresAt: new Date(Date.now() + 3_600_000) },
    membership: { userId, businessId, role: 'cashier', active: true, fullName: 'Ana' },
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
        { productId: cola, quantityMilli: 2_000, unitPrice: 1_000, discount: 0, taxRateBp: 1900 },
        {
          productId: bread,
          quantityMilli: 1_500,
          unitPrice: 1_000,
          discount: 500,
          taxRateBp: 1900,
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
          { productId: cola, quantityMilli: 1_000, unitPrice: 1_500, discount: 0, taxRateBp: 0 },
        ],
        payments: [{ method: 'cash', amount: 1_500 }],
      });

      expect(sale.lines).toEqual([
        { productId: cola, quantityMilli: 1_000, unitPrice: 1_500, discount: 0, taxRateBp: 0 },
      ]);
      expect(sale.flags).toEqual(['price-differs']);
      expect(
        await select(admin, 'SELECT unit_price::int AS p, tax_rate_bp FROM sale_line'),
      ).toEqual([{ p: 1_500, tax_rate_bp: 0 }]);
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
          { productId: lone, quantityMilli: 2_000, unitPrice: 1_000, discount: 0, taxRateBp: 1900 },
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
          { productId: lone, quantityMilli: 2_000, unitPrice: 1_000, discount: 0, taxRateBp: 1900 },
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
          { productId: last, quantityMilli: 1_000, unitPrice: 1_000, discount: 0, taxRateBp: 1900 },
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
          },
        ],
        total: 1,
        payments: [{ method: 'cash', amount: 1 }],
      });
      await expect(sales.create(session(a.ownerId), same)).rejects.toThrow();

      const fixed = {
        ...same,
        lines: [
          { productId: cola, quantityMilli: 1_000, unitPrice: 1_000, discount: 0, taxRateBp: 1900 },
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
          `INSERT INTO sale_line (id_negocio, sale_id, product_id, quantity_milli, unit_price, tax_rate_bp, position)
           VALUES ($1, $2, $3, $4, 1, 0, $5)`,
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
          `INSERT INTO sale_line (id_negocio, sale_id, product_id, quantity_milli, unit_price, tax_rate_bp, position)
           VALUES ($1, $2, $3, 1000, 1, 0, $4)`,
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
});
