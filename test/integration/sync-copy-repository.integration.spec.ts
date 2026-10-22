import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applicationUrlOf } from '../../scripts/prepare-database.ts';
import { createPrismaClient } from '../../src/adapters/out/persistence/create-prisma-client.js';
import { PrismaUnitOfWork } from '../../src/adapters/out/persistence/prisma-unit-of-work.js';
import { SyncCopyUseCase } from '../../src/application/usecases/sync-copy.usecase.js';
import type { Session } from '../../src/domain/ports/in/authenticate.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { asApplication, createAdminPool } from './support/database.js';
import { BUSINESS_A, BUSINESS_B, resetData, seedBusiness, seedProduct } from './support/seed.js';

/**
 * La copia de lectura contra PostgreSQL real (C3-06, ADR 0028): lo que los dobles de memoria no pueden probar, que es como la base
 * compara las horas. El cursor lleva el instante al MILISEGUNDO y la base guarda microsegundos: si la consulta comparara con la
 * fraccion mas fina, un producto de la misma milesima que el ultimo de la pagina volveria a salir en la siguiente y la descarga
 * no terminaria nunca.
 */
describe('the read copy against PostgreSQL (C3-06)', () => {
  let admin: pg.Pool;
  let prisma: PrismaClient;
  let copy: SyncCopyUseCase;
  let a: Awaited<ReturnType<typeof seedBusiness>>;

  beforeAll(() => {
    admin = createAdminPool(3);
    prisma = createPrismaClient(applicationUrlOf(process.env['TEST_DATABASE_URL']!), { max: 6 });
    copy = new SyncCopyUseCase(new PrismaUnitOfWork(prisma), { now: () => new Date() });
  });

  beforeEach(async () => {
    await resetData(admin);
    a = await seedBusiness(admin, BUSINESS_A);
    await seedBusiness(admin, BUSINESS_B);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await admin.end();
  });

  const cashier = (businessId = BUSINESS_A): Session => ({
    identity: { subject: randomUUID(), email: null, expiresAt: new Date(Date.now() + 3_600_000) },
    membership: { userId: a.ownerId, businessId, role: 'cashier', active: true, fullName: 'Ana' },
  });

  /** Un producto cuya ultima modificacion es EXACTAMENTE la que se dice, con microsegundos. */
  async function productAt(
    updatedAt: string,
    id?: string,
    businessId = BUSINESS_A,
  ): Promise<string> {
    const productId = await seedProduct(admin, businessId, id ?? randomUUID());
    await admin.query('UPDATE product SET updated_at = $1::timestamptz WHERE id = $2', [
      updatedAt,
      productId,
    ]);
    return productId;
  }

  const idOf = (n: number) => `00000000-0000-4000-8000-00000000000${String(n)}`;

  /** Baja todas las paginas, de a `limit`, y devuelve los ids en el orden en que llegaron. */
  async function everything(
    work: (query: Record<string, string>) => Promise<{
      items: { id?: string; productId?: string }[];
      nextCursor: string | null;
    }>,
    query: Record<string, string> = {},
  ): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let pages = 0; pages < 50; pages += 1) {
      const page = await work({ ...query, ...(cursor === null ? {} : { cursor }) });
      ids.push(...page.items.map((item) => item.id ?? item.productId ?? ''));
      cursor = page.nextCursor;
      if (cursor === null) return ids;
    }
    throw new Error('The download never ended');
  }

  describe('the products', () => {
    it('goes through the products of the same millisecond, one by one, without repeating or looping', async () => {
      // La misma milesima de segundo, distinta millonesima: manda el identificador, que aqui va al reves de la hora.
      const late = await productAt('2026-10-18T10:00:00.000900Z', idOf(1));
      const early = await productAt('2026-10-18T10:00:00.000100Z', idOf(2));
      const next = await productAt('2026-10-18T10:00:00.001500Z', idOf(3));
      const before = await productAt('2026-10-18T09:59:59.999999Z', idOf(4));

      const seen = await everything((query) => copy.products(cashier(), { limit: '1', ...query }));

      expect(seen).toEqual([before, late, early, next]);
    });

    it('compares since to the millisecond: what changed in the same millisecond is not after it', async () => {
      const same = await productAt('2026-10-18T10:00:00.000900Z');
      const after = await productAt('2026-10-18T10:00:00.001000Z');
      await productAt('2026-10-18T09:59:59.999000Z');

      const page = await copy.products(cashier(), { since: '2026-10-18T10:00:00.000Z' });

      expect(page.items.map((item) => item.id)).toEqual([after]);
      expect(page.items.map((item) => item.id)).not.toContain(same);
    });

    it('gives the archived ones too, marked, so that the device removes them', async () => {
      const gone = await productAt('2026-10-18T10:00:00.000Z');
      await admin.query('UPDATE product SET active = false WHERE id = $1', [gone]);

      const page = await copy.products(cashier(), {});

      expect(page.items).toEqual([expect.objectContaining({ id: gone, active: false })]);
    });

    it('goes from the oldest change to the newest, whatever the name', async () => {
      const zeta = await productAt('2026-10-18T10:00:01.000Z');
      const alfa = await productAt('2026-10-18T10:00:03.000Z');
      const mitad = await productAt('2026-10-18T10:00:02.000Z');
      await admin.query("UPDATE product SET name = 'Zeta' WHERE id = $1", [zeta]);
      await admin.query("UPDATE product SET name = 'Alfa' WHERE id = $1", [alfa]);

      const page = await copy.products(cashier(), {});

      expect(page.items.map((item) => item.id)).toEqual([zeta, mitad, alfa]);
    });

    it('does not show the products of another business', async () => {
      await productAt('2026-10-18T10:00:00.000Z', undefined, BUSINESS_B);
      const mine = await productAt('2026-10-18T10:00:01.000Z');

      const page = await copy.products(cashier(), {});

      expect(page.items.map((item) => item.id)).toEqual([mine]);
    });

    it('never gives more than the page, and says there is more by the cursor', async () => {
      for (let n = 1; n <= 5; n += 1) await productAt(`2026-10-18T10:00:0${String(n)}.000Z`);

      const page = await copy.products(cashier(), { limit: '2' });

      expect(page.items).toHaveLength(2);
      expect(page.nextCursor).not.toBeNull();
    });
  });

  describe('the stock', () => {
    /** Un movimiento de un producto con la hora que se diga (con microsegundos). */
    async function movement(productId: string, delta: number, at: string, businessId = BUSINESS_A) {
      const operationId = randomUUID();
      // Con el rol y el contexto de la aplicacion: el saldo lo mantiene un disparador, que corre bajo la seguridad por fila.
      await asApplication(admin, businessId, async (client) => {
        await client.query(
          `INSERT INTO operation (id_negocio, operation_id, kind, user_id)
           VALUES ($1, $2, 'adjustment', (SELECT id FROM app_user WHERE id_negocio = $1))`,
          [businessId, operationId],
        );
        await client.query(
          `INSERT INTO stock_movement (id_negocio, operation_id, warehouse_id, product_id, delta, reason, created_at)
           VALUES ($1, $2, (SELECT id FROM warehouse WHERE id_negocio = $1), $3, $4, 'adjustment', $5::timestamptz)`,
          [businessId, operationId, productId, delta, at],
        );
      });
    }

    it('gives the stock of each product that ever moved, as it is now, and nothing for one that never moved', async () => {
      const moved = await seedProduct(admin, BUSINESS_A, idOf(1));
      const negative = await seedProduct(admin, BUSINESS_A, idOf(2));
      await seedProduct(admin, BUSINESS_A, idOf(3));
      await movement(moved, 5_000, '2026-10-18T10:00:00.000Z');
      await movement(moved, -1_500, '2026-10-18T10:05:00.000Z');
      await movement(negative, -3_000, '2026-10-18T10:00:00.000Z');

      const page = await copy.stock(cashier(), {});

      expect(page.items).toEqual([
        { productId: moved, quantityMilli: 3_500 },
        { productId: negative, quantityMilli: -3_000 },
      ]);
    });

    it('gives only the products with a movement after since, with the stock of now (and not the one of then)', async () => {
      const old = await seedProduct(admin, BUSINESS_A, idOf(1));
      const recent = await seedProduct(admin, BUSINESS_A, idOf(2));
      await movement(old, 1_000, '2026-10-18T10:00:00.000Z');
      await movement(recent, 2_000, '2026-10-18T10:00:00.000Z');
      await movement(recent, 3_000, '2026-10-18T11:00:00.000Z');

      const page = await copy.stock(cashier(), { since: '2026-10-18T10:30:00.000Z' });

      expect(page.items).toEqual([{ productId: recent, quantityMilli: 5_000 }]);
    });

    it('compares since to the millisecond, like the cursor does', async () => {
      const same = await seedProduct(admin, BUSINESS_A, idOf(1));
      const after = await seedProduct(admin, BUSINESS_A, idOf(2));
      await movement(same, 1_000, '2026-10-18T10:00:00.000900Z');
      await movement(after, 1_000, '2026-10-18T10:00:00.001000Z');

      const page = await copy.stock(cashier(), { since: '2026-10-18T10:00:00.000Z' });

      expect(page.items.map((item) => item.productId)).toEqual([after]);
    });

    it('goes through every product by id, a page at a time, without repeating', async () => {
      const ids: string[] = [];
      for (let n = 1; n <= 5; n += 1) {
        const productId = await seedProduct(admin, BUSINESS_A, idOf(n));
        await movement(productId, 1_000 * n, '2026-10-18T10:00:00.000Z');
        ids.push(productId);
      }

      const seen = await everything((query) => copy.stock(cashier(), { limit: '2', ...query }));

      expect(seen).toEqual(ids);
    });

    it('does not show the stock of another business', async () => {
      const other = await seedProduct(admin, BUSINESS_B);
      await movement(other, 9_000, '2026-10-18T10:00:00.000Z', BUSINESS_B);

      const page = await copy.stock(cashier(), {});

      expect(page.items).toEqual([]);
    });
  });
});
