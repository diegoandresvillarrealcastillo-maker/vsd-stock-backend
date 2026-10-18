import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applicationUrlOf } from '../../scripts/prepare-database.ts';
import { createPrismaClient } from '../../src/adapters/out/persistence/create-prisma-client.js';
import { PrismaUnitOfWork } from '../../src/adapters/out/persistence/prisma-unit-of-work.js';
import {
  BarcodeTakenError,
  CategoryInUseError,
  CategoryNameTakenError,
  SkuTakenError,
} from '../../src/domain/model/catalog-errors.js';
import { Barcode } from '../../src/domain/model/barcode.js';
import type { NewProduct } from '../../src/domain/model/product-input.js';
import { Sku } from '../../src/domain/model/sku.js';
import type { ProductFilter } from '../../src/domain/ports/out/catalog.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { createAdminPool } from './support/database.js';
import { recordStockEntry } from './support/ledger-design.js';
import { BUSINESS_A, BUSINESS_B, resetData, seedBusiness } from './support/seed.js';

const UPC_A = '036000291452';
const EAN_13_OF_THE_UPC_A = '0036000291452';

const product = (
  overrides: Partial<{
    name: string;
    sku: string;
    barcode: string | null;
    unit: NewProduct['unit'];
    unitPrice: number;
    taxRateBp: number;
    categoryId: string | null;
    minStockMilli: number | null;
  }> = {},
): NewProduct => ({
  name: overrides.name ?? 'Arroz 500 g',
  sku: Sku.parse(overrides.sku ?? 'ARR-500'),
  barcode: overrides.barcode == null ? null : Barcode.parse(overrides.barcode),
  unit: overrides.unit ?? 'unit',
  unitPrice: overrides.unitPrice ?? 3200,
  taxRateBp: overrides.taxRateBp ?? 0,
  categoryId: overrides.categoryId ?? null,
  minStockMilli: overrides.minStockMilli ?? null,
});

/**
 * El catalogo de un negocio contra PostgreSQL (ADR 0015), con el rol real de la aplicacion: las claves de comparacion las
 * calcula la base, lo unico es por negocio, un negocio no ve el catalogo de otro y la unidad se queda con la historia.
 */
describe('the catalog against PostgreSQL (ADR 0015)', () => {
  let admin: pg.Pool;
  let prisma: PrismaClient;
  let unitOfWork: PrismaUnitOfWork;

  beforeAll(() => {
    admin = createAdminPool(3);
    prisma = createPrismaClient(applicationUrlOf(process.env['TEST_DATABASE_URL']!), { max: 3 });
    unitOfWork = new PrismaUnitOfWork(prisma);
  });

  beforeEach(async () => {
    await resetData(admin);
    await seedBusiness(admin, BUSINESS_A);
    await seedBusiness(admin, BUSINESS_B);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await admin.end();
  });

  describe('categories', () => {
    it('creates, finds, lists, renames and deletes a category', async () => {
      const created = await unitOfWork.inBusiness(BUSINESS_A, (s) =>
        s.catalog.createCategory('Granos'),
      );
      expect(created).toMatchObject({ name: 'Granos' });
      expect(created.createdAt).toBeInstanceOf(Date);

      expect(
        await unitOfWork.inBusiness(BUSINESS_A, (s) => s.catalog.findCategory(created.id)),
      ).toEqual(created);
      expect(
        await unitOfWork.inBusiness(BUSINESS_A, (s) => s.catalog.listCategories({ limit: 10 })),
      ).toEqual([created]);

      const renamed = await unitOfWork.inBusiness(BUSINESS_A, (s) =>
        s.catalog.renameCategory(created.id, 'Cereales'),
      );
      expect(renamed).toMatchObject({ id: created.id, name: 'Cereales' });

      await unitOfWork.inBusiness(BUSINESS_A, (s) => s.catalog.deleteCategory(created.id));
      expect(
        await unitOfWork.inBusiness(BUSINESS_A, (s) => s.catalog.findCategory(created.id)),
      ).toBeNull();
    });

    it('lists by name, in pages with no repeats and no gaps', async () => {
      for (const name of ['Bebidas', 'Aseo', 'Granos', 'Lácteos', 'Dulces']) {
        await unitOfWork.inBusiness(BUSINESS_A, (s) => s.catalog.createCategory(name));
      }

      const seen: string[] = [];
      let position: readonly [string, string] | undefined;
      for (let pages = 0; pages < 10; pages += 1) {
        const rows = await unitOfWork.inBusiness(BUSINESS_A, (s) =>
          s.catalog.listCategories({ limit: 2, ...(position ? { after: position } : {}) }),
        );
        if (rows.length === 0) break;
        seen.push(...rows.map((r) => r.name));
        const last = rows[rows.length - 1]!;
        position = [last.name, last.id];
      }

      expect(seen).toEqual(['Aseo', 'Bebidas', 'Dulces', 'Granos', 'Lácteos']);
    });

    it('keeps the name unique in a business whatever its case, but not across businesses', async () => {
      await unitOfWork.inBusiness(BUSINESS_A, (s) => s.catalog.createCategory('Granos'));

      await expect(
        unitOfWork.inBusiness(BUSINESS_A, (s) => s.catalog.createCategory('GRANOS')),
      ).rejects.toBeInstanceOf(CategoryNameTakenError);
      await expect(
        unitOfWork.inBusiness(BUSINESS_B, (s) => s.catalog.createCategory('Granos')),
      ).resolves.toBeDefined();
    });

    it('refuses to rename to the name of another category, and to delete one with products', async () => {
      const granos = await unitOfWork.inBusiness(BUSINESS_A, (s) =>
        s.catalog.createCategory('Granos'),
      );
      await unitOfWork.inBusiness(BUSINESS_A, (s) => s.catalog.createCategory('Aseo'));
      await unitOfWork.inBusiness(BUSINESS_A, (s) =>
        s.catalog.createProduct(product({ categoryId: granos.id })),
      );

      await expect(
        unitOfWork.inBusiness(BUSINESS_A, (s) => s.catalog.renameCategory(granos.id, 'aseo')),
      ).rejects.toBeInstanceOf(CategoryNameTakenError);
      await expect(
        unitOfWork.inBusiness(BUSINESS_A, (s) => s.catalog.deleteCategory(granos.id)),
      ).rejects.toBeInstanceOf(CategoryInUseError);
    });

    it('does not show, rename or delete the category of another business', async () => {
      const foreign = await unitOfWork.inBusiness(BUSINESS_B, (s) =>
        s.catalog.createCategory('Ajena'),
      );

      expect(
        await unitOfWork.inBusiness(BUSINESS_A, (s) => s.catalog.findCategory(foreign.id)),
      ).toBeNull();
      expect(
        await unitOfWork.inBusiness(BUSINESS_A, (s) => s.catalog.listCategories({ limit: 10 })),
      ).toEqual([]);
      await expect(
        unitOfWork.inBusiness(BUSINESS_A, (s) => s.catalog.renameCategory(foreign.id, 'X')),
      ).rejects.toThrow();
      expect(
        await unitOfWork.inBusiness(BUSINESS_B, (s) => s.catalog.findCategory(foreign.id)),
      ).toMatchObject({ name: 'Ajena' });
    });
  });

  describe('creating products', () => {
    it('stores a product and gives it back with the price as a number of pesos', async () => {
      const created = await unitOfWork.inBusiness(BUSINESS_A, (s) =>
        s.catalog.createProduct(
          product({ barcode: UPC_A, minStockMilli: 2500, unitPrice: 1_000_000_000_000 }),
        ),
      );

      expect(created).toMatchObject({
        name: 'Arroz 500 g',
        sku: 'ARR-500',
        barcode: UPC_A,
        unit: 'unit',
        unitPrice: 1_000_000_000_000,
        taxRateBp: 0,
        active: true,
        categoryId: null,
        minStockMilli: 2500,
      });
      expect(typeof created.unitPrice).toBe('number');
      expect(created.createdAt).toBeInstanceOf(Date);
      expect(created.updatedAt).toBeInstanceOf(Date);
    });

    it('keeps the SKU unique per business, whatever its case', async () => {
      await unitOfWork.inBusiness(BUSINESS_A, (s) => s.catalog.createProduct(product()));

      await expect(
        unitOfWork.inBusiness(BUSINESS_A, (s) =>
          s.catalog.createProduct(product({ sku: 'arr-500' })),
        ),
      ).rejects.toBeInstanceOf(SkuTakenError);
      await expect(
        unitOfWork.inBusiness(BUSINESS_B, (s) =>
          s.catalog.createProduct(product({ sku: 'arr-500' })),
        ),
      ).resolves.toBeDefined();
    });

    it('keeps the barcode unique per business: a UPC-A and its EAN-13 are the same product', async () => {
      await unitOfWork.inBusiness(BUSINESS_A, (s) =>
        s.catalog.createProduct(product({ barcode: UPC_A })),
      );

      await expect(
        unitOfWork.inBusiness(BUSINESS_A, (s) =>
          s.catalog.createProduct(product({ sku: 'OTRO', barcode: EAN_13_OF_THE_UPC_A })),
        ),
      ).rejects.toBeInstanceOf(BarcodeTakenError);
      await expect(
        unitOfWork.inBusiness(BUSINESS_B, (s) =>
          s.catalog.createProduct(product({ barcode: UPC_A })),
        ),
      ).resolves.toBeDefined();
    });

    it('lets many products have no barcode', async () => {
      for (const sku of ['A', 'B', 'C']) {
        await unitOfWork.inBusiness(BUSINESS_A, (s) => s.catalog.createProduct(product({ sku })));
      }

      expect(
        await unitOfWork.inBusiness(BUSINESS_A, (s) =>
          s.catalog.listProducts({ limit: 10, filter: {} }),
        ),
      ).toHaveLength(3);
    });

    it('rolls back everything when the work fails after creating', async () => {
      await expect(
        unitOfWork.inBusiness(BUSINESS_A, async (s) => {
          await s.catalog.createProduct(product());
          throw new Error('fallo despues de crear');
        }),
      ).rejects.toThrow('fallo despues');

      expect(
        await unitOfWork.inBusiness(BUSINESS_A, (s) =>
          s.catalog.listProducts({ limit: 10, filter: {} }),
        ),
      ).toEqual([]);
    });
  });

  describe('changing products', () => {
    it('changes only what is given and moves the moment of the last change', async () => {
      const created = await unitOfWork.inBusiness(BUSINESS_A, (s) =>
        s.catalog.createProduct(product({ barcode: UPC_A, minStockMilli: 1000 })),
      );
      await new Promise((resolve) => setTimeout(resolve, 15));

      const updated = await unitOfWork.inBusiness(BUSINESS_A, (s) =>
        s.catalog.updateProduct(created.id, {
          name: 'Arroz blanco',
          unitPrice: 3500,
          active: false,
        }),
      );

      expect(updated).toMatchObject({
        name: 'Arroz blanco',
        unitPrice: 3500,
        active: false,
        sku: 'ARR-500',
        barcode: UPC_A,
        minStockMilli: 1000,
      });
      expect(updated.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime());
      expect(updated.createdAt).toEqual(created.createdAt);
    });

    it('clears the barcode, the category and the minimum stock with null', async () => {
      const granos = await unitOfWork.inBusiness(BUSINESS_A, (s) =>
        s.catalog.createCategory('Granos'),
      );
      const created = await unitOfWork.inBusiness(BUSINESS_A, (s) =>
        s.catalog.createProduct(
          product({ barcode: UPC_A, categoryId: granos.id, minStockMilli: 1000 }),
        ),
      );

      const updated = await unitOfWork.inBusiness(BUSINESS_A, (s) =>
        s.catalog.updateProduct(created.id, {
          barcode: null,
          categoryId: null,
          minStockMilli: null,
        }),
      );

      expect(updated).toMatchObject({ barcode: null, categoryId: null, minStockMilli: null });
    });

    it('sets a new SKU and a new barcode, and refuses those of another product', async () => {
      await unitOfWork.inBusiness(BUSINESS_A, (s) =>
        s.catalog.createProduct(product({ barcode: UPC_A })),
      );
      const other = await unitOfWork.inBusiness(BUSINESS_A, (s) =>
        s.catalog.createProduct(product({ sku: 'OTRO' })),
      );

      await expect(
        unitOfWork.inBusiness(BUSINESS_A, (s) =>
          s.catalog.updateProduct(other.id, { sku: Sku.parse('arr-500') }),
        ),
      ).rejects.toBeInstanceOf(SkuTakenError);
      await expect(
        unitOfWork.inBusiness(BUSINESS_A, (s) =>
          s.catalog.updateProduct(other.id, { barcode: Barcode.parse(EAN_13_OF_THE_UPC_A) }),
        ),
      ).rejects.toBeInstanceOf(BarcodeTakenError);
      const renamed = await unitOfWork.inBusiness(BUSINESS_A, (s) =>
        s.catalog.updateProduct(other.id, { sku: Sku.parse('NUEVO') }),
      );
      expect(renamed.sku).toBe('NUEVO');
    });

    it('can not change the product of another business', async () => {
      const foreign = await unitOfWork.inBusiness(BUSINESS_B, (s) =>
        s.catalog.createProduct(product()),
      );

      await expect(
        unitOfWork.inBusiness(BUSINESS_A, (s) =>
          s.catalog.updateProduct(foreign.id, { name: 'Pirata' }),
        ),
      ).rejects.toThrow();
      expect(
        await unitOfWork.inBusiness(BUSINESS_B, (s) => s.catalog.findProduct(foreign.id)),
      ).toMatchObject({ name: 'Arroz 500 g' });
      expect(
        await unitOfWork.inBusiness(BUSINESS_A, (s) => s.catalog.findProduct(foreign.id)),
      ).toBeNull();
    });
  });

  describe('the unit and the history', () => {
    it('knows whether a product has stock movements, and the database keeps its unit after that', async () => {
      const created = await unitOfWork.inBusiness(BUSINESS_A, (s) =>
        s.catalog.createProduct(product()),
      );
      expect(
        await unitOfWork.inBusiness(BUSINESS_A, (s) => s.catalog.hasStockMovements(created.id)),
      ).toBe(false);
      await unitOfWork.inBusiness(BUSINESS_A, (s) =>
        s.catalog.updateProduct(created.id, { unit: 'kilogram' }),
      );

      await recordStockEntry(admin, {
        businessId: BUSINESS_A,
        operationId: randomUUID(),
        productId: created.id,
        delta: 5000,
        reason: 'purchase',
      });

      expect(
        await unitOfWork.inBusiness(BUSINESS_A, (s) => s.catalog.hasStockMovements(created.id)),
      ).toBe(true);
      await expect(
        unitOfWork.inBusiness(BUSINESS_A, (s) =>
          s.catalog.updateProduct(created.id, { unit: 'gram' }),
        ),
      ).rejects.toThrow();
    });

    it('does not count the movements of another business', async () => {
      const mine = await unitOfWork.inBusiness(BUSINESS_A, (s) =>
        s.catalog.createProduct(product()),
      );
      const theirs = await unitOfWork.inBusiness(BUSINESS_B, (s) =>
        s.catalog.createProduct(product()),
      );
      await recordStockEntry(admin, {
        businessId: BUSINESS_B,
        operationId: randomUUID(),
        productId: theirs.id,
        delta: 1000,
        reason: 'purchase',
      });

      expect(
        await unitOfWork.inBusiness(BUSINESS_A, (s) => s.catalog.hasStockMovements(mine.id)),
      ).toBe(false);
      expect(
        await unitOfWork.inBusiness(BUSINESS_A, (s) => s.catalog.hasStockMovements(theirs.id)),
      ).toBe(false);
    });
  });

  describe('looking for products', () => {
    const fill = async () => {
      const granos = await unitOfWork.inBusiness(BUSINESS_A, (s) =>
        s.catalog.createCategory('Granos'),
      );
      const make = (p: NewProduct) =>
        unitOfWork.inBusiness(BUSINESS_A, (s) => s.catalog.createProduct(p));
      await make(
        product({ name: 'Arroz 500 g', sku: 'ARR-500', categoryId: granos.id, barcode: UPC_A }),
      );
      await make(product({ name: 'Azúcar 1 kg', sku: 'AZU-1K' }));
      await make(product({ name: 'Leche 100% entera', sku: 'LEC_1L' }));
      const archived = await make(product({ name: 'Aceite', sku: 'ACE-1L' }));
      await unitOfWork.inBusiness(BUSINESS_A, (s) =>
        s.catalog.updateProduct(archived.id, { active: false }),
      );
      return { granos, archived };
    };
    const skus = async (filter: ProductFilter) =>
      (
        await unitOfWork.inBusiness(BUSINESS_A, (s) =>
          s.catalog.listProducts({ limit: 50, filter }),
        )
      ).map((p) => p.sku);

    it('lists by name', async () => {
      await fill();

      expect(await skus({})).toEqual(['ACE-1L', 'ARR-500', 'AZU-1K', 'LEC_1L']);
    });

    it('searches a part of the name or the SKU, whatever the case', async () => {
      await fill();

      expect(await skus({ search: 'arr' })).toEqual(['ARR-500']);
      expect(await skus({ search: 'zúcar' })).toEqual(['AZU-1K']);
      expect(await skus({ search: 'azú' })).toEqual(['AZU-1K']);
      expect(await skus({ search: '-1l' })).toEqual(['ACE-1L']);
    });

    it('finds a product by its whole barcode, and only whole', async () => {
      await fill();

      expect(await skus({ search: UPC_A })).toEqual(['ARR-500']);
      expect(await skus({ search: UPC_A.slice(0, 8) })).toEqual([]);
    });

    it('takes % and _ in the search as the characters they are, not as wildcards', async () => {
      await fill();

      expect(await skus({ search: '100%' })).toEqual(['LEC_1L']);
      expect(await skus({ search: '%' })).toEqual(['LEC_1L']);
      expect(await skus({ search: 'LEC_' })).toEqual(['LEC_1L']);
      expect(await skus({ search: '_' })).toEqual(['LEC_1L']);
      expect(await skus({ search: 'A_R' })).toEqual([]);
    });

    it('filters by category and by whether it is active', async () => {
      const { granos } = await fill();

      expect(await skus({ categoryId: granos.id })).toEqual(['ARR-500']);
      expect(await skus({ active: false })).toEqual(['ACE-1L']);
      expect(await skus({ active: true })).toEqual(['ARR-500', 'AZU-1K', 'LEC_1L']);
      expect(await skus({ categoryId: granos.id, active: false })).toEqual([]);
    });

    it('walks the list in pages with no repeats and no gaps, even with equal names', async () => {
      for (const sku of ['A1', 'A2', 'A3']) {
        await unitOfWork.inBusiness(BUSINESS_A, (s) =>
          s.catalog.createProduct(product({ name: 'Igual', sku })),
        );
      }
      await unitOfWork.inBusiness(BUSINESS_A, (s) =>
        s.catalog.createProduct(product({ name: 'Otro', sku: 'B1' })),
      );
      const everyone = await unitOfWork.inBusiness(BUSINESS_A, (s) =>
        s.catalog.listProducts({ limit: 50, filter: {} }),
      );

      const seen: string[] = [];
      let position: readonly [string, string] | undefined;
      for (let pages = 0; pages < 10; pages += 1) {
        const rows = await unitOfWork.inBusiness(BUSINESS_A, (s) =>
          s.catalog.listProducts({
            limit: 2,
            filter: {},
            ...(position ? { after: position } : {}),
          }),
        );
        if (rows.length === 0) break;
        seen.push(...rows.map((p) => p.id));
        const last = rows[rows.length - 1]!;
        position = [last.name, last.id];
      }

      expect(seen).toEqual(everyone.map((p) => p.id));
      expect(new Set(seen).size).toBe(4);
    });

    it('orders products with the same name by id, so a page never repeats or skips one', async () => {
      // Insertados en un orden que NO es el del id: si el orden no desempata, la pagina siguiente repite a uno.
      const ids = [
        'ffffffff-ffff-4fff-8fff-ffffffffffff',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      ];
      for (const [index, id] of ids.entries()) {
        await admin.query(
          `INSERT INTO product (id, id_negocio, name, sku, unit, unit_price, tax_rate_bp)
           VALUES ($1, $2, 'Igual', $3, 'unit', 1000, 0)`,
          [id, BUSINESS_A, `IGUAL-${index}`],
        );
      }

      const first = await unitOfWork.inBusiness(BUSINESS_A, (s) =>
        s.catalog.listProducts({ limit: 2, filter: {} }),
      );
      const second = await unitOfWork.inBusiness(BUSINESS_A, (s) =>
        s.catalog.listProducts({ limit: 2, filter: {}, after: ['Igual', first[1]!.id] }),
      );

      expect(first.map((p) => p.id)).toEqual([ids[1], ids[2]]);
      expect(second.map((p) => p.id)).toEqual([ids[0]]);
    });

    it('never shows the products of another business', async () => {
      await unitOfWork.inBusiness(BUSINESS_B, (s) =>
        s.catalog.createProduct(product({ sku: 'AJENO', name: 'Ajeno' })),
      );
      await fill();

      expect(await skus({})).not.toContain('AJENO');
      expect(await skus({ search: 'ajeno' })).toEqual([]);
    });
  });
});
