import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applicationUrlOf } from '../../scripts/prepare-database.ts';
import { createPrismaClient } from '../../src/adapters/out/persistence/create-prisma-client.js';
import { PrismaUnitOfWork } from '../../src/adapters/out/persistence/prisma-unit-of-work.js';
import {
  SupplierInUseError,
  SupplierNotFoundError,
  WarehouseMissingError,
} from '../../src/domain/model/purchase-errors.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { createAdminPool } from './support/database.js';
import { BUSINESS_A, BUSINESS_B, resetData, seedBusiness, seedProduct } from './support/seed.js';
import { select } from './support/sql.js';

/**
 * Proveedores, compras, existencias y operaciones contra PostgreSQL (C2-06), con el rol real de la aplicacion: cada
 * negocio ve lo suyo, el saldo lo sube el disparador y las compras son historia que no se edita.
 */
describe('suppliers, purchases and stock against PostgreSQL (C2-06)', () => {
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

  const line = (productId: string, quantityMilli = 5000, unitCost = 2500) => ({
    productId,
    quantityMilli,
    unitCost,
  });

  describe('suppliers', () => {
    it('creates, finds, lists, changes and deletes a supplier', async () => {
      const created = await unitOfWork.inBusiness(BUSINESS_A, (s) =>
        s.suppliers.create({ name: 'Granos del Valle', contact: '300 123 4567' }),
      );
      expect(created).toMatchObject({ name: 'Granos del Valle', contact: '300 123 4567' });
      expect(created.createdAt).toBeInstanceOf(Date);

      expect(await unitOfWork.inBusiness(BUSINESS_A, (s) => s.suppliers.find(created.id))).toEqual(
        created,
      );
      expect(
        await unitOfWork.inBusiness(BUSINESS_A, (s) => s.suppliers.list({ limit: 10 })),
      ).toEqual([created]);

      const renamed = await unitOfWork.inBusiness(BUSINESS_A, (s) =>
        s.suppliers.update(created.id, { name: 'Cereales del Valle' }),
      );
      expect(renamed).toMatchObject({ name: 'Cereales del Valle', contact: '300 123 4567' });
      const cleared = await unitOfWork.inBusiness(BUSINESS_A, (s) =>
        s.suppliers.update(created.id, { contact: null }),
      );
      expect(cleared.contact).toBeNull();

      await unitOfWork.inBusiness(BUSINESS_A, (s) => s.suppliers.remove(created.id));
      expect(
        await unitOfWork.inBusiness(BUSINESS_A, (s) => s.suppliers.find(created.id)),
      ).toBeNull();
    });

    it('lists by name and then id, in pages that follow the position', async () => {
      const names = ['Bebidas', 'Aseo', 'Granos', 'Aseo'];
      for (const name of names) {
        await unitOfWork.inBusiness(BUSINESS_A, (s) => s.suppliers.create({ name, contact: null }));
      }
      const all = await unitOfWork.inBusiness(BUSINESS_A, (s) => s.suppliers.list({ limit: 10 }));
      expect(all.map((s) => s.name)).toEqual(['Aseo', 'Aseo', 'Bebidas', 'Granos']);
      expect(all[0]!.id < all[1]!.id).toBe(true);

      const seen: string[] = [];
      let after: readonly [string, string] | undefined;
      for (;;) {
        const page = await unitOfWork.inBusiness(BUSINESS_A, (s) =>
          s.suppliers.list({ limit: 3, ...(after === undefined ? {} : { after }) }),
        );
        seen.push(...page.map((s) => s.id));
        if (page.length < 3) break;
        const last = page[page.length - 1]!;
        after = [last.name, last.id];
      }
      expect(seen).toEqual(all.map((s) => s.id));
    });

    it('does not show a business the suppliers of another', async () => {
      const mine = await unitOfWork.inBusiness(BUSINESS_A, (s) =>
        s.suppliers.create({ name: 'Mio', contact: null }),
      );

      expect(await unitOfWork.inBusiness(BUSINESS_B, (s) => s.suppliers.find(mine.id))).toBeNull();
      expect(
        await unitOfWork.inBusiness(BUSINESS_B, (s) => s.suppliers.list({ limit: 10 })),
      ).toEqual([]);
      await expect(
        unitOfWork.inBusiness(BUSINESS_B, (s) => s.suppliers.update(mine.id, { name: 'Robado' })),
      ).rejects.toBeInstanceOf(SupplierNotFoundError);
      await expect(
        unitOfWork.inBusiness(BUSINESS_B, (s) => s.suppliers.remove(mine.id)),
      ).rejects.toBeInstanceOf(SupplierNotFoundError);
    });

    it('says there is no such supplier when changing or deleting one that does not exist', async () => {
      await expect(
        unitOfWork.inBusiness(BUSINESS_A, (s) => s.suppliers.update(randomUUID(), { name: 'X' })),
      ).rejects.toBeInstanceOf(SupplierNotFoundError);
      await expect(
        unitOfWork.inBusiness(BUSINESS_A, (s) => s.suppliers.remove(randomUUID())),
      ).rejects.toBeInstanceOf(SupplierNotFoundError);
    });

    it('keeps a supplier that has purchases', async () => {
      const product = await seedProduct(admin, BUSINESS_A);
      const supplier = await unitOfWork.inBusiness(BUSINESS_A, (s) =>
        s.suppliers.create({ name: 'Con historia', contact: null }),
      );
      const operationId = randomUUID();
      await unitOfWork.inBusiness(BUSINESS_A, async (s) => {
        await s.operations.claim({
          operationId,
          kind: 'purchase',
          userId: a.ownerId,
          fingerprint: 'y',
        });
        await s.purchases.create({
          operationId,
          userId: a.ownerId,
          warehouseId: a.warehouseId,
          supplierId: supplier.id,
          note: null,
          lines: [line(product)],
        });
      });

      await expect(
        unitOfWork.inBusiness(BUSINESS_A, (s) => s.suppliers.remove(supplier.id)),
      ).rejects.toBeInstanceOf(SupplierInUseError);
      expect(
        await unitOfWork.inBusiness(BUSINESS_A, (s) => s.suppliers.find(supplier.id)),
      ).not.toBeNull();
    });
  });

  describe('operations (ADR 0019)', () => {
    const claim = (
      businessId: string,
      request: { operationId: string; fingerprint: string; kind?: 'purchase' | 'adjustment' },
      userId = a.ownerId,
    ) =>
      unitOfWork.inBusiness(businessId, (s) =>
        s.operations.claim({ kind: 'purchase', userId, ...request }),
      );

    it('claims a new operation once and says «replay» for the same body afterwards', async () => {
      const operationId = randomUUID();

      expect(await claim(BUSINESS_A, { operationId, fingerprint: 'cuerpo' })).toBe('claimed');
      expect(await claim(BUSINESS_A, { operationId, fingerprint: 'cuerpo' })).toBe('replay');
      expect(await claim(BUSINESS_A, { operationId, fingerprint: 'cuerpo' })).toBe('replay');
    });

    it('says «conflict» for the same operation with another body or another kind', async () => {
      const operationId = randomUUID();
      await claim(BUSINESS_A, { operationId, fingerprint: 'cuerpo' });

      expect(await claim(BUSINESS_A, { operationId, fingerprint: 'otro cuerpo' })).toBe('conflict');
      expect(
        await claim(BUSINESS_A, { operationId, fingerprint: 'cuerpo', kind: 'adjustment' }),
      ).toBe('conflict');
    });

    it('stores who made it, of which kind and a fingerprint, never the body itself', async () => {
      const operationId = randomUUID();
      await claim(BUSINESS_A, { operationId, fingerprint: 'cuerpo secreto de la compra' });

      const rows = await select(
        admin,
        'SELECT kind, user_id, body_hash FROM operation WHERE operation_id = $1',
        [operationId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: 'purchase', user_id: a.ownerId });
      expect(rows[0]!['body_hash']).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(rows[0])).not.toContain('secreto');
    });

    it('keeps operation ids apart between businesses: the same id is two different operations', async () => {
      const operationId = randomUUID();

      expect(await claim(BUSINESS_A, { operationId, fingerprint: 'a' })).toBe('claimed');
      expect(await claim(BUSINESS_B, { operationId, fingerprint: 'b' }, b.ownerId)).toBe('claimed');
      expect(await claim(BUSINESS_A, { operationId, fingerprint: 'a' })).toBe('replay');
    });

    it('leaves nothing claimed when the work that follows fails', async () => {
      const operationId = randomUUID();

      await expect(
        unitOfWork.inBusiness(BUSINESS_A, async (s) => {
          await s.operations.claim({
            operationId,
            kind: 'purchase',
            userId: a.ownerId,
            fingerprint: 'cuerpo',
          });
          throw new Error('algo fallo despues');
        }),
      ).rejects.toThrow('algo fallo despues');

      expect(await claim(BUSINESS_A, { operationId, fingerprint: 'otro cuerpo' })).toBe('claimed');
    });

    it('lets only one of two concurrent claims win; the other waits and then sees a replay', async () => {
      const operationId = randomUUID();

      const results = await Promise.all([
        claim(BUSINESS_A, { operationId, fingerprint: 'cuerpo' }),
        claim(BUSINESS_A, { operationId, fingerprint: 'cuerpo' }),
        claim(BUSINESS_A, { operationId, fingerprint: 'cuerpo' }),
      ]);

      expect([...results].sort()).toEqual(['claimed', 'replay', 'replay']);
    });
  });

  describe('stock', () => {
    it('hands over the one warehouse of the business', async () => {
      expect(await unitOfWork.inBusiness(BUSINESS_A, (s) => s.stock.warehouse())).toEqual({
        id: a.warehouseId,
        name: 'Bodega',
      });
      expect(await unitOfWork.inBusiness(BUSINESS_B, (s) => s.stock.warehouse())).toEqual({
        id: b.warehouseId,
        name: 'Bodega',
      });
    });

    it('says the business has no warehouse when it has none', async () => {
      await admin.query('DELETE FROM warehouse WHERE id_negocio = $1', [BUSINESS_A]);

      await expect(
        unitOfWork.inBusiness(BUSINESS_A, (s) => s.stock.warehouse()),
      ).rejects.toBeInstanceOf(WarehouseMissingError);
    });

    it('adds movements and the trigger raises the balance in the same transaction', async () => {
      const product = await seedProduct(admin, BUSINESS_A, randomUUID(), { unit: 'kilogram' });
      const operationId = randomUUID();

      await unitOfWork.inBusiness(BUSINESS_A, async (s) => {
        await s.operations.claim({
          operationId,
          kind: 'purchase',
          userId: a.ownerId,
          fingerprint: 'x',
        });
        await s.stock.addMovements(operationId, [
          { productId: product, delta: 12_500, reason: 'purchase', note: 'Pedido' },
        ]);
      });

      const movements = await select(
        admin,
        'SELECT delta, reason, note, warehouse_id FROM stock_movement WHERE product_id = $1',
        [product],
      );
      expect(movements).toEqual([
        { delta: '12500', reason: 'purchase', note: 'Pedido', warehouse_id: a.warehouseId },
      ]);
      const balance = await select(
        admin,
        'SELECT quantity FROM stock_balance WHERE product_id = $1',
        [product],
      );
      expect(balance).toEqual([{ quantity: '12500' }]);
    });

    it('applies the movements in the order of the products, whatever order they arrive in', async () => {
      const ids = [
        '00000000-0000-4000-8000-0000000000c3',
        '00000000-0000-4000-8000-0000000000a1',
        '00000000-0000-4000-8000-0000000000b2',
      ];
      for (const id of ids) await seedProduct(admin, BUSINESS_A, id);
      const operationId = randomUUID();

      await unitOfWork.inBusiness(BUSINESS_A, async (s) => {
        await s.operations.claim({
          operationId,
          kind: 'purchase',
          userId: a.ownerId,
          fingerprint: 'x',
        });
        await s.stock.addMovements(
          operationId,
          ids.map((productId) => ({
            productId,
            delta: 1000,
            reason: 'purchase' as const,
            note: null,
          })),
        );
      });

      // La fila de cada movimiento nace en el orden en que se inserto: su orden fisico es el del bloqueo.
      const rows = await select(
        admin,
        'SELECT product_id FROM stock_movement WHERE operation_id = $1 ORDER BY ctid',
        [operationId],
      );
      expect(rows.map((r) => r['product_id'])).toEqual([...ids].sort());
    });

    it('refuses a movement for a product of another business', async () => {
      const foreign = await seedProduct(admin, BUSINESS_B);
      const operationId = randomUUID();

      await expect(
        unitOfWork.inBusiness(BUSINESS_A, async (s) => {
          await s.operations.claim({
            operationId,
            kind: 'purchase',
            userId: a.ownerId,
            fingerprint: 'x',
          });
          await s.stock.addMovements(operationId, [
            { productId: foreign, delta: 1000, reason: 'purchase', note: null },
          ]);
        }),
      ).rejects.toThrow();
      expect(
        await select(admin, 'SELECT 1 FROM stock_movement WHERE product_id = $1', [foreign]),
      ).toEqual([]);
    });
  });

  describe('purchases', () => {
    const purchase = async (
      businessId: string,
      user: string,
      warehouseId: string,
      overrides: {
        operationId?: string;
        supplierId?: string | null;
        note?: string | null;
        lines?: ReturnType<typeof line>[];
      },
      fallbackProduct: string,
    ) => {
      const operationId = overrides.operationId ?? randomUUID();
      return unitOfWork.inBusiness(businessId, async (s) => {
        await s.operations.claim({
          operationId,
          kind: 'purchase',
          userId: user,
          fingerprint: operationId,
        });
        return s.purchases.create({
          operationId,
          userId: user,
          warehouseId,
          supplierId: overrides.supplierId ?? null,
          note: overrides.note ?? null,
          lines: overrides.lines ?? [line(fallbackProduct)],
        });
      });
    };

    it('creates a purchase with its lines and finds it by id and by operation', async () => {
      const rice = await seedProduct(admin, BUSINESS_A);
      const sugar = await seedProduct(admin, BUSINESS_A, randomUUID(), { unit: 'kilogram' });
      const supplier = await unitOfWork.inBusiness(BUSINESS_A, (s) =>
        s.suppliers.create({ name: 'Distribuidora', contact: null }),
      );
      const operationId = randomUUID();

      const created = await purchase(
        BUSINESS_A,
        a.ownerId,
        a.warehouseId,
        {
          operationId,
          supplierId: supplier.id,
          note: 'Pedido de octubre',
          lines: [line(rice, 24_000, 2500), line(sugar, 12_500, 4200)],
        },
        rice,
      );

      expect(created).toMatchObject({
        operationId,
        warehouseId: a.warehouseId,
        supplierId: supplier.id,
        note: 'Pedido de octubre',
        createdByUserId: a.ownerId,
      });
      expect(created.createdAt).toBeInstanceOf(Date);
      expect([...created.lines].sort((x, y) => x.quantityMilli - y.quantityMilli)).toEqual([
        { productId: sugar, quantityMilli: 12_500, unitCost: 4200 },
        { productId: rice, quantityMilli: 24_000, unitCost: 2500 },
      ]);
      expect(await unitOfWork.inBusiness(BUSINESS_A, (s) => s.purchases.find(created.id))).toEqual(
        created,
      );
      expect(
        await unitOfWork.inBusiness(BUSINESS_A, (s) => s.purchases.findByOperation(operationId)),
      ).toEqual(created);
    });

    it('does not find a purchase of another business, nor by its operation id', async () => {
      const product = await seedProduct(admin, BUSINESS_A);
      const mine = await purchase(BUSINESS_A, a.ownerId, a.warehouseId, {}, product);

      expect(await unitOfWork.inBusiness(BUSINESS_B, (s) => s.purchases.find(mine.id))).toBeNull();
      expect(
        await unitOfWork.inBusiness(BUSINESS_B, (s) =>
          s.purchases.findByOperation(mine.operationId),
        ),
      ).toBeNull();
      expect(
        await unitOfWork.inBusiness(BUSINESS_B, (s) => s.purchases.list({ limit: 10 })),
      ).toEqual([]);
    });

    it('finds nothing for an id or an operation that does not exist', async () => {
      expect(
        await unitOfWork.inBusiness(BUSINESS_A, (s) => s.purchases.find(randomUUID())),
      ).toBeNull();
      expect(
        await unitOfWork.inBusiness(BUSINESS_A, (s) => s.purchases.findByOperation(randomUUID())),
      ).toBeNull();
    });

    it('lists newest first, with the number of lines and without them', async () => {
      const p1 = await seedProduct(admin, BUSINESS_A);
      const p2 = await seedProduct(admin, BUSINESS_A);
      const first = await purchase(BUSINESS_A, a.ownerId, a.warehouseId, { note: 'primera' }, p1);
      const second = await purchase(
        BUSINESS_A,
        a.ownerId,
        a.warehouseId,
        {
          note: 'segunda',
          lines: [line(p1), line(p2)],
        },
        p1,
      );

      const page = await unitOfWork.inBusiness(BUSINESS_A, (s) => s.purchases.list({ limit: 10 }));

      expect(page.map((p) => [p.id, p.lineCount])).toEqual([
        [second.id, 2],
        [first.id, 1],
      ]);
      expect(page[0]).not.toHaveProperty('lines');
      expect(page[0]).toMatchObject({ note: 'segunda', createdByUserId: a.ownerId });
    });

    it('walks the list in pages without repeating or skipping, even when purchases share the same millisecond', async () => {
      const product = await seedProduct(admin, BUSINESS_A);
      const made: string[] = [];
      for (let n = 0; n < 7; n += 1) {
        made.push((await purchase(BUSINESS_A, a.ownerId, a.warehouseId, {}, product)).id);
      }
      // Cinco compras caen en el MISMO milisegundo (pero en microsegundos distintos): el orden solo depende de (hora, id).
      const client = await admin.connect();
      try {
        // La historia no se edita, ni siquiera con la conexion de administracion: aqui solo se prepara el escenario.
        await client.query('SET session_replication_role = replica');
        await client.query(
          `UPDATE purchase SET created_at = date_trunc('millisecond', now()) + (random() * interval '0.9 milliseconds')
            WHERE id = ANY($1::uuid[])`,
          [made.slice(0, 5)],
        );
        await client.query('SET session_replication_role = DEFAULT');
      } finally {
        client.release();
      }

      const walked: string[] = [];
      let after: readonly [string, string] | undefined;
      for (;;) {
        const page = await unitOfWork.inBusiness(BUSINESS_A, (s) =>
          s.purchases.list({ limit: 3, ...(after === undefined ? {} : { after }) }),
        );
        walked.push(...page.map((p) => p.id));
        if (page.length < 3) break;
        const last = page[page.length - 1]!;
        after = [last.createdAt.toISOString(), last.id];
      }

      expect(walked).toHaveLength(7);
      expect(new Set(walked).size).toBe(7);
      expect([...walked].sort()).toEqual([...made].sort());
    });

    it('is history: the application can not change or delete a purchase', async () => {
      const product = await seedProduct(admin, BUSINESS_A);
      const created = await purchase(BUSINESS_A, a.ownerId, a.warehouseId, {}, product);

      await expect(
        unitOfWork.transaction(
          BUSINESS_A,
          (tx) =>
            tx.$executeRaw`UPDATE purchase SET note = 'cambiada' WHERE id = ${created.id}::uuid`,
        ),
      ).rejects.toThrow();
      await expect(
        unitOfWork.transaction(
          BUSINESS_A,
          (tx) => tx.$executeRaw`DELETE FROM purchase_line WHERE purchase_id = ${created.id}::uuid`,
        ),
      ).rejects.toThrow();
    });

    it('refuses a supplier or a product of another business', async () => {
      const mine = await seedProduct(admin, BUSINESS_A);
      const foreignProduct = await seedProduct(admin, BUSINESS_B);
      const foreignSupplier = await unitOfWork.inBusiness(BUSINESS_B, (s) =>
        s.suppliers.create({ name: 'Ajeno', contact: null }),
      );

      await expect(
        purchase(BUSINESS_A, a.ownerId, a.warehouseId, { supplierId: foreignSupplier.id }, mine),
      ).rejects.toThrow();
      await expect(
        purchase(BUSINESS_A, a.ownerId, a.warehouseId, { lines: [line(foreignProduct)] }, mine),
      ).rejects.toThrow();
      expect(
        await select(admin, 'SELECT 1 FROM purchase WHERE id_negocio = $1', [BUSINESS_A]),
      ).toEqual([]);
    });
  });
});
