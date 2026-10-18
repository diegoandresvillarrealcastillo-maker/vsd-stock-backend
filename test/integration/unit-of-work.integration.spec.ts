import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applicationUrlOf } from '../../scripts/prepare-database.ts';
import { createPrismaClient } from '../../src/adapters/out/persistence/create-prisma-client.js';
import { PrismaDatabaseHealth } from '../../src/adapters/out/persistence/prisma-database-health.js';
import { PrismaUnitOfWork } from '../../src/adapters/out/persistence/prisma-unit-of-work.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { createAdminPool } from './support/database.js';
import { BUSINESS_A, BUSINESS_B, resetData, seedBusiness } from './support/seed.js';

/**
 * El acceso a datos de la aplicacion (ADR 0021): toda lectura y escritura pasa por una transaccion con el negocio
 * fijado (ADR 0005), con el rol REAL de la aplicacion y a traves de Prisma. Lo que aqui se prueba es lo que hasta ahora
 * solo se habia probado a mano con SQL: que el contexto del negocio llegue, no se filtre y deshaga lo que falla.
 */
describe('the unit of work against PostgreSQL (ADR 0021)', () => {
  let admin: pg.Pool;
  let prisma: PrismaClient;
  let unitOfWork: PrismaUnitOfWork;
  const applicationUrl = (): string => applicationUrlOf(process.env['TEST_DATABASE_URL']!);

  beforeAll(() => {
    admin = createAdminPool(2);
    // Pocas conexiones a proposito: asi las transacciones de negocios distintos se turnan la misma conexion.
    prisma = createPrismaClient(applicationUrl(), { max: 3 });
    unitOfWork = new PrismaUnitOfWork(prisma);
  });

  beforeEach(async () => {
    await resetData(admin);
    await seedBusiness(admin, BUSINESS_A, 'Tienda A');
    await seedBusiness(admin, BUSINESS_B, 'Tienda B');
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await admin.end();
  });

  describe('inBusiness', () => {
    it('shows each business its own row and nothing else', async () => {
      const a = await unitOfWork.inBusiness(BUSINESS_A, (scope) => scope.business.current());
      const b = await unitOfWork.inBusiness(BUSINESS_B, (scope) => scope.business.current());

      expect(a).toEqual({ id: BUSINESS_A, name: 'Tienda A' });
      expect(b).toEqual({ id: BUSINESS_B, name: 'Tienda B' });
    });

    it('tells the work which business it runs for', async () => {
      const seen = await unitOfWork.inBusiness(BUSINESS_A, (scope) =>
        Promise.resolve(scope.businessId),
      );

      expect(seen).toBe(BUSINESS_A);
    });

    it('returns null for a business that does not exist, instead of leaking another one', async () => {
      const ghost = await unitOfWork.inBusiness(randomUUID(), (scope) => scope.business.current());

      expect(ghost).toBeNull();
    });

    it('returns what the work returns', async () => {
      expect(await unitOfWork.inBusiness(BUSINESS_A, () => Promise.resolve(42))).toBe(42);
    });

    it.each([
      '',
      'no-es-un-uuid',
      "'; DROP TABLE business; --",
      '11111111-1111-4111-8111-11111111111',
    ])('rejects the business identifier %j before touching the database', async (businessId) => {
      const untouched = new PrismaUnitOfWork({
        $transaction: () => {
          throw new Error('the database was touched');
        },
      } as unknown as PrismaClient);

      await expect(untouched.inBusiness(businessId, () => Promise.resolve(1))).rejects.toThrow(
        'not a valid business identifier',
      );
    });
  });

  describe('the business context', () => {
    it('is not there without it: the application sees zero rows, not all of them', async () => {
      expect(await prisma.business.findMany()).toEqual([]);
      expect(await prisma.category.count()).toBe(0);
    });

    it('does not leak into the next use of the same connection', async () => {
      const single = createPrismaClient(applicationUrl(), { max: 1 });
      try {
        const inside = new PrismaUnitOfWork(single);
        expect(
          await inside.inBusiness(BUSINESS_A, (scope) => scope.business.current()),
        ).not.toBeNull();

        // La misma conexion, sin transaccion de negocio: el contexto se fue con la transaccion.
        expect(await single.business.findMany()).toEqual([]);
      } finally {
        await single.$disconnect();
      }
    });

    it('never mixes two businesses when many transactions share few connections', async () => {
      const businesses = [BUSINESS_A, BUSINESS_B];
      const outcomes = await Promise.all(
        Array.from({ length: 80 }, async (_, index) => {
          const expected = businesses[index % 2]!;
          const seen = await unitOfWork.transaction(expected, async (tx) => {
            const setting = await tx.$queryRaw<{ id: string }[]>`
              SELECT current_setting('app.id_negocio', true) AS id`;
            const rows = await tx.business.findMany();
            return { setting: setting[0]?.id, visible: rows.map((row) => row.id) };
          });
          return { expected, ...seen };
        }),
      );

      for (const outcome of outcomes) {
        expect(outcome.setting).toBe(outcome.expected);
        expect(outcome.visible).toEqual([outcome.expected]);
      }
    });

    it('lets a new business be created inside a transaction that already carries its identifier', async () => {
      const fresh = randomUUID();

      await unitOfWork.transaction(fresh, (tx) =>
        tx.business.create({ data: { id: fresh, name: 'Nuevo' } }),
      );

      expect(await unitOfWork.inBusiness(fresh, (scope) => scope.business.current())).toEqual({
        id: fresh,
        name: 'Nuevo',
      });
    });

    it('does not let a transaction write a row of another business', async () => {
      await expect(
        unitOfWork.transaction(BUSINESS_A, (tx) =>
          tx.category.create({ data: { idNegocio: BUSINESS_B, name: 'Intrusa' } }),
        ),
      ).rejects.toThrow();

      expect(await unitOfWork.transaction(BUSINESS_B, (tx) => tx.category.count())).toBe(0);
    });
  });

  describe('atomicity', () => {
    it('keeps everything the work wrote when it finishes', async () => {
      await unitOfWork.transaction(BUSINESS_A, async (tx) => {
        await tx.category.create({ data: { idNegocio: BUSINESS_A, name: 'Bebidas' } });
        await tx.category.create({ data: { idNegocio: BUSINESS_A, name: 'Aseo' } });
      });

      expect(await unitOfWork.transaction(BUSINESS_A, (tx) => tx.category.count())).toBe(2);
    });

    it('undoes everything the work wrote when it fails halfway', async () => {
      await expect(
        unitOfWork.transaction(BUSINESS_A, async (tx) => {
          await tx.category.create({ data: { idNegocio: BUSINESS_A, name: 'Bebidas' } });
          throw new Error('se cayo a la mitad');
        }),
      ).rejects.toThrow('se cayo a la mitad');

      expect(await unitOfWork.transaction(BUSINESS_A, (tx) => tx.category.count())).toBe(0);
    });

    it('undoes the first write when the second one is rejected by the database', async () => {
      await expect(
        unitOfWork.transaction(BUSINESS_A, async (tx) => {
          await tx.category.create({ data: { idNegocio: BUSINESS_A, name: 'Bebidas' } });
          // El mismo nombre sin importar mayusculas: la clave unica de la base lo rechaza.
          await tx.category.create({ data: { idNegocio: BUSINESS_A, name: 'BEBIDAS' } });
        }),
      ).rejects.toThrow();

      expect(await unitOfWork.transaction(BUSINESS_A, (tx) => tx.category.count())).toBe(0);
    });
  });

  describe('database health', () => {
    it('says up when the database answers', async () => {
      expect(await new PrismaDatabaseHealth(prisma).check()).toBe('up');
    });

    it('says down, quickly and without throwing, when nobody listens on the port', async () => {
      const unreachable = createPrismaClient('postgresql://stock_app@127.0.0.1:1/stock_test', {
        max: 1,
      });
      try {
        const started = Date.now();
        const status = await new PrismaDatabaseHealth(unreachable, 1500).check();

        expect(status).toBe('down');
        expect(Date.now() - started).toBeLessThan(5000);
      } finally {
        await unreachable.$disconnect().catch(() => undefined);
      }
    });
  });
});
