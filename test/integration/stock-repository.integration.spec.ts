import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applicationUrlOf } from '../../scripts/prepare-database.ts';
import { createPrismaClient } from '../../src/adapters/out/persistence/create-prisma-client.js';
import { PrismaUnitOfWork } from '../../src/adapters/out/persistence/prisma-unit-of-work.js';
import type { StockChange, StockFilter } from '../../src/domain/ports/out/stock.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { createAdminPool } from './support/database.js';
import { BUSINESS_A, BUSINESS_B, resetData, seedBusiness } from './support/seed.js';
import { select } from './support/sql.js';

interface NewProduct {
  id?: string;
  name: string;
  sku: string;
  unit?: string;
  minStockMilli?: number | null;
  barcode?: string | null;
  categoryId?: string | null;
  active?: boolean;
}

/**
 * La existencia y el historial contra PostgreSQL (C2-07, ADR 0013), con el rol real de la aplicacion: la existencia es la
 * suma del libro, un producto que nunca se movio tiene cero y cada negocio ve solo lo suyo.
 */
describe('stock and its history against PostgreSQL (C2-07)', () => {
  let admin: pg.Pool;
  let prisma: PrismaClient;
  let unitOfWork: PrismaUnitOfWork;
  let a: Awaited<ReturnType<typeof seedBusiness>>;
  let b: Awaited<ReturnType<typeof seedBusiness>>;

  beforeAll(() => {
    admin = createAdminPool(3);
    prisma = createPrismaClient(applicationUrlOf(process.env['TEST_DATABASE_URL']!), { max: 3 });
    unitOfWork = new PrismaUnitOfWork(prisma);
  });

  beforeEach(async () => {
    await resetData(admin);
    a = await seedBusiness(admin, BUSINESS_A);
    b = await seedBusiness(admin, BUSINESS_B);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await admin.end();
  });

  const newProduct = async (businessId: string, product: NewProduct): Promise<string> => {
    const id = product.id ?? randomUUID();
    await admin.query(
      `INSERT INTO product (id, id_negocio, name, sku, barcode, unit, unit_price, tax_rate_bp, tax_kind,
                            category_id, min_stock_milli, active)
       VALUES ($1, $2, $3, $4, $5, $6, 1000, 0, 'exempt', $7, $8, $9)`,
      [
        id,
        businessId,
        product.name,
        product.sku,
        product.barcode ?? null,
        product.unit ?? 'unit',
        product.categoryId ?? null,
        product.minStockMilli ?? null,
        product.active ?? true,
      ],
    );
    return id;
  };

  const move = async (
    businessId: string,
    userId: string,
    changes: StockChange[],
    operationId = randomUUID(),
  ): Promise<string> => {
    await unitOfWork.inBusiness(businessId, async (s) => {
      await s.operations.claim({ operationId, kind: 'purchase', userId, fingerprint: operationId });
      await s.stock.addMovements(operationId, changes);
    });
    return operationId;
  };

  const change = (
    productId: string,
    delta: number,
    reason: StockChange['reason'] = 'purchase',
    note: string | null = null,
  ): StockChange => ({ productId, delta, reason, note });

  const list = (
    businessId: string,
    filter: StockFilter = {},
    limit = 50,
    after?: [string, string],
  ) =>
    unitOfWork.inBusiness(businessId, (s) =>
      s.stock.list({ limit, filter, ...(after === undefined ? {} : { after }) }),
    );

  describe('the stock of every product', () => {
    it('gives zero to a product that never moved and the sum of the book to one that did', async () => {
      const rice = await newProduct(BUSINESS_A, { name: 'Arroz', sku: 'ARR' });
      const salt = await newProduct(BUSINESS_A, { name: 'Sal', sku: 'SAL', minStockMilli: 2000 });
      await move(BUSINESS_A, a.ownerId, [change(rice, 24_000)]);
      await move(BUSINESS_A, a.ownerId, [change(rice, -2000, 'adjustment', 'Se cayeron')]);

      const rows = await list(BUSINESS_A);

      expect(rows).toEqual([
        {
          productId: rice,
          name: 'Arroz',
          sku: 'ARR',
          unit: 'unit',
          active: true,
          quantityMilli: 22_000,
          minStockMilli: null,
          belowMinimum: false,
        },
        {
          productId: salt,
          name: 'Sal',
          sku: 'SAL',
          unit: 'unit',
          active: true,
          quantityMilli: 0,
          minStockMilli: 2000,
          belowMinimum: true,
        },
      ]);
    });

    it('sorts by name and then id, in pages that follow the position', async () => {
      const names = ['Bebida', 'Aseo', 'Granos', 'Dulces'];
      for (const [i, name] of names.entries()) await newProduct(BUSINESS_A, { name, sku: `S${i}` });
      // Dos con el mismo nombre, insertados al reves de como se ordenan sus ids: solo el desempate por id los acomoda.
      const second = '00000000-0000-4000-8000-0000000000b2';
      const first = '00000000-0000-4000-8000-0000000000a1';
      await newProduct(BUSINESS_A, { id: second, name: 'Aseo', sku: 'S-B' });
      await newProduct(BUSINESS_A, { id: first, name: 'Aseo', sku: 'S-A' });
      const all = await list(BUSINESS_A);
      expect(all.map((r) => r.name)).toEqual([
        'Aseo',
        'Aseo',
        'Aseo',
        'Bebida',
        'Dulces',
        'Granos',
      ]);
      expect(
        all
          .filter((r) => r.name === 'Aseo' && [first, second].includes(r.productId))
          .map((r) => r.productId),
      ).toEqual([first, second]);

      const seen: string[] = [];
      let after: [string, string] | undefined;
      for (let guard = 0; guard < 20; guard += 1) {
        const page = await list(BUSINESS_A, {}, 2, after);
        seen.push(...page.map((r) => r.productId));
        if (page.length < 2) break;
        const last = page[page.length - 1]!;
        after = [last.name, last.productId];
      }
      expect(seen).toEqual(all.map((r) => r.productId));
    });

    it('warns only when there is strictly less than the minimum, and only if a minimum was set', async () => {
      const equal = await newProduct(BUSINESS_A, { name: 'Igual', sku: 'I', minStockMilli: 5000 });
      const under = await newProduct(BUSINESS_A, { name: 'Bajo', sku: 'B', minStockMilli: 5000 });
      const above = await newProduct(BUSINESS_A, { name: 'Sobre', sku: 'S', minStockMilli: 5000 });
      const noMinimum = await newProduct(BUSINESS_A, { name: 'Libre', sku: 'L' });
      const negative = await newProduct(BUSINESS_A, {
        name: 'Negativo',
        sku: 'N',
        minStockMilli: 0,
      });
      await move(BUSINESS_A, a.ownerId, [
        change(equal, 5000),
        change(under, 4999),
        change(above, 5001),
        change(noMinimum, -3000, 'adjustment', 'x'),
        change(negative, -1000, 'adjustment', 'x'),
      ]);

      const rows = await list(BUSINESS_A);
      const below = await list(BUSINESS_A, { belowMinimum: true });

      expect(Object.fromEntries(rows.map((r) => [r.name, r.belowMinimum]))).toEqual({
        Igual: false,
        Bajo: true,
        Sobre: false,
        Libre: false,
        Negativo: true,
      });
      expect(below.map((r) => r.name)).toEqual(['Bajo', 'Negativo']);
      expect((await list(BUSINESS_A, { belowMinimum: false })).map((r) => r.name)).toHaveLength(5);
    });

    it('pages what is below the minimum without skipping any', async () => {
      for (let n = 0; n < 5; n += 1) {
        const id = await newProduct(BUSINESS_A, {
          name: `P${n}`,
          sku: `P${n}`,
          minStockMilli: 1000,
        });
        await move(BUSINESS_A, a.ownerId, [change(id, n % 2 === 0 ? 100 : 5000)]);
      }

      const first = await list(BUSINESS_A, { belowMinimum: true }, 2);
      const second = await list(BUSINESS_A, { belowMinimum: true }, 2, [
        first[1]!.name,
        first[1]!.productId,
      ]);

      expect([...first, ...second].map((r) => r.name)).toEqual(['P0', 'P2', 'P4']);
    });

    it('searches by a part of the name or the SKU without caring about case, or by a whole barcode', async () => {
      await newProduct(BUSINESS_A, {
        name: 'Arroz Diana',
        sku: 'ARR-500',
        barcode: '7701234567897',
      });
      await newProduct(BUSINESS_A, { name: 'Aceite', sku: 'ACE-1' });

      expect((await list(BUSINESS_A, { search: 'arroz' })).map((r) => r.sku)).toEqual(['ARR-500']);
      expect((await list(BUSINESS_A, { search: 'ace-1' })).map((r) => r.sku)).toEqual(['ACE-1']);
      expect((await list(BUSINESS_A, { search: '7701234567897' })).map((r) => r.sku)).toEqual([
        'ARR-500',
      ]);
      expect(await list(BUSINESS_A, { search: '770123' })).toEqual([]);
    });

    it('takes % _ and the backslash as the characters they are, not as wildcards', async () => {
      await newProduct(BUSINESS_A, { name: 'Descuento 100% total', sku: 'D1' });
      await newProduct(BUSINESS_A, { name: 'Ruta A_B', sku: 'D2' });
      await newProduct(BUSINESS_A, { name: 'Ruta AxB', sku: 'D3' });
      await newProduct(BUSINESS_A, { name: 'Carpeta C:\\temp', sku: 'D4' });

      expect((await list(BUSINESS_A, { search: '100%' })).map((r) => r.sku)).toEqual(['D1']);
      expect((await list(BUSINESS_A, { search: 'A_B' })).map((r) => r.sku)).toEqual(['D2']);
      expect((await list(BUSINESS_A, { search: '%' })).map((r) => r.sku)).toEqual(['D1']);
      expect((await list(BUSINESS_A, { search: 'C:\\t' })).map((r) => r.sku)).toEqual(['D4']);
    });

    it('filters by category and by whether the product is archived', async () => {
      const category = randomUUID();
      await admin.query('INSERT INTO category (id, id_negocio, name) VALUES ($1, $2, $3)', [
        category,
        BUSINESS_A,
        'Granos',
      ]);
      await newProduct(BUSINESS_A, { name: 'Arroz', sku: 'A', categoryId: category });
      await newProduct(BUSINESS_A, { name: 'Viejo', sku: 'V', active: false });
      await newProduct(BUSINESS_A, { name: 'Otro', sku: 'O' });

      expect((await list(BUSINESS_A, { categoryId: category })).map((r) => r.name)).toEqual([
        'Arroz',
      ]);
      expect((await list(BUSINESS_A, { active: false })).map((r) => r.name)).toEqual(['Viejo']);
      expect((await list(BUSINESS_A, { active: true })).map((r) => r.name)).toEqual([
        'Arroz',
        'Otro',
      ]);
    });

    it('combines the filters', async () => {
      const low = await newProduct(BUSINESS_A, {
        name: 'Arroz bajo',
        sku: 'A1',
        minStockMilli: 9000,
      });
      const high = await newProduct(BUSINESS_A, {
        name: 'Arroz alto',
        sku: 'A2',
        minStockMilli: 1000,
      });
      await newProduct(BUSINESS_A, { name: 'Sal baja', sku: 'S1', minStockMilli: 9000 });
      await move(BUSINESS_A, a.ownerId, [change(low, 100), change(high, 5000)]);

      const rows = await list(BUSINESS_A, { search: 'arroz', belowMinimum: true, active: true });

      expect(rows.map((r) => r.sku)).toEqual(['A1']);
    });

    it('does not show a business the products or the stock of another', async () => {
      const mine = await newProduct(BUSINESS_A, { name: 'Mio', sku: 'M' });
      await newProduct(BUSINESS_B, { name: 'Ajeno', sku: 'X' });
      await move(BUSINESS_A, a.ownerId, [change(mine, 3000)]);

      expect((await list(BUSINESS_A)).map((r) => r.name)).toEqual(['Mio']);
      expect((await list(BUSINESS_B)).map((r) => [r.name, r.quantityMilli])).toEqual([
        ['Ajeno', 0],
      ]);
    });

    it('keeps every quantity equal to the sum of the book after any sequence of movements', async () => {
      const products = [
        await newProduct(BUSINESS_A, { name: 'A', sku: 'A' }),
        await newProduct(BUSINESS_A, { name: 'B', sku: 'B', unit: 'kilogram' }),
        await newProduct(BUSINESS_A, { name: 'C', sku: 'C' }),
      ];
      let seed = 7;
      const next = () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed;
      };
      for (let round = 0; round < 25; round += 1) {
        const picked = products.filter(() => next() % 3 !== 0);
        const changes = picked.map((id) =>
          change(id, ((next() % 9) + 1) * 1000 * (next() % 2 === 0 ? 1 : -1), 'adjustment', 'x'),
        );
        if (changes.length > 0) await move(BUSINESS_A, a.ownerId, changes);
      }

      const rows = await list(BUSINESS_A);
      const book = await select(
        admin,
        'SELECT product_id, sum(delta)::bigint AS total FROM stock_movement GROUP BY product_id',
      );
      const sums = new Map(book.map((r) => [r['product_id'] as string, Number(r['total'])]));
      for (const row of rows) expect(row.quantityMilli).toBe(sums.get(row.productId) ?? 0);
    });
  });

  describe('the history of a product', () => {
    it('lists the movements of one product, the newest first, with their kind and their note', async () => {
      const rice = await newProduct(BUSINESS_A, { name: 'Arroz', sku: 'ARR' });
      const sugar = await newProduct(BUSINESS_A, { name: 'Azúcar', sku: 'AZU' });
      const first = await move(BUSINESS_A, a.ownerId, [change(rice, 24_000, 'purchase', 'Pedido')]);
      await move(BUSINESS_A, a.ownerId, [change(sugar, 500)]);
      const third = await move(BUSINESS_A, a.ownerId, [
        change(rice, -2000, 'adjustment', 'Se cayeron dos'),
      ]);

      const movements = await unitOfWork.inBusiness(BUSINESS_A, (s) =>
        s.stock.movements(rice, { limit: 10 }),
      );

      expect(movements.map((m) => [m.operationId, m.kind, m.deltaMilli, m.reason])).toEqual([
        [third, 'adjustment', -2000, 'Se cayeron dos'],
        [first, 'purchase', 24_000, 'Pedido'],
      ]);
      expect(movements[0]!.productId).toBe(rice);
      expect(movements[0]!.createdAt).toBeInstanceOf(Date);
    });

    it('walks the history in pages without repeating or skipping, even when movements share the same millisecond', async () => {
      const rice = await newProduct(BUSINESS_A, { name: 'Arroz', sku: 'ARR' });
      for (let n = 0; n < 7; n += 1)
        await move(BUSINESS_A, a.ownerId, [change(rice, (n + 1) * 1000)]);
      const client = await admin.connect();
      try {
        // El libro no se edita, ni con la conexion de administracion: aqui solo se prepara el escenario.
        await client.query('SET session_replication_role = replica');
        await client.query(
          `UPDATE stock_movement
              SET created_at = date_trunc('millisecond', now()) + (random() * interval '0.9 milliseconds')
            WHERE delta IN (1000, 2000, 3000, 4000, 5000)`,
        );
        await client.query('SET session_replication_role = DEFAULT');
      } finally {
        client.release();
      }

      const walked: string[] = [];
      let after: [string, string] | undefined;
      for (let guard = 0; guard < 20; guard += 1) {
        const page = await unitOfWork.inBusiness(BUSINESS_A, (s) =>
          s.stock.movements(rice, { limit: 3, ...(after === undefined ? {} : { after }) }),
        );
        walked.push(...page.map((m) => m.id));
        expect(page.length).toBeLessThanOrEqual(3);
        if (page.length < 3) break;
        const last = page[page.length - 1]!;
        after = [last.createdAt.toISOString(), last.id];
      }

      const everything = await select(admin, 'SELECT id FROM stock_movement');
      expect(walked).toHaveLength(7);
      expect(new Set(walked).size).toBe(7);
      expect([...walked].sort()).toEqual(everything.map((r) => r['id'] as string).sort());
    });

    it('does not hand over the movements of a product of another business', async () => {
      const foreign = await newProduct(BUSINESS_B, { name: 'Ajeno', sku: 'X' });
      await move(BUSINESS_B, b.ownerId, [change(foreign, 1000)]);

      expect(
        await unitOfWork.inBusiness(BUSINESS_A, (s) => s.stock.movements(foreign, { limit: 10 })),
      ).toEqual([]);
    });

    it('finds the movement an operation wrote, and nothing for an operation that did not', async () => {
      const rice = await newProduct(BUSINESS_A, { name: 'Arroz', sku: 'ARR' });
      const operationId = await move(BUSINESS_A, a.ownerId, [
        change(rice, -1000, 'adjustment', 'Conteo'),
      ]);

      const found = await unitOfWork.inBusiness(BUSINESS_A, (s) =>
        s.stock.movementOfOperation(operationId),
      );

      expect(found).toMatchObject({
        operationId,
        productId: rice,
        kind: 'adjustment',
        deltaMilli: -1000,
        reason: 'Conteo',
      });
      expect(
        await unitOfWork.inBusiness(BUSINESS_A, (s) => s.stock.movementOfOperation(randomUUID())),
      ).toBeNull();
      expect(
        await unitOfWork.inBusiness(BUSINESS_B, (s) => s.stock.movementOfOperation(operationId)),
      ).toBeNull();
    });

    it('is history: the application can not change or delete a movement', async () => {
      const rice = await newProduct(BUSINESS_A, { name: 'Arroz', sku: 'ARR' });
      await move(BUSINESS_A, a.ownerId, [change(rice, 1000)]);

      await expect(
        unitOfWork.transaction(
          BUSINESS_A,
          (tx) => tx.$executeRaw`UPDATE stock_movement SET delta = 5`,
        ),
      ).rejects.toThrow();
      await expect(
        unitOfWork.transaction(BUSINESS_A, (tx) => tx.$executeRaw`DELETE FROM stock_movement`),
      ).rejects.toThrow();
      await expect(
        unitOfWork.transaction(
          BUSINESS_A,
          (tx) => tx.$executeRaw`UPDATE stock_balance SET quantity = 99`,
        ),
      ).rejects.toThrow();
    });
  });
});
