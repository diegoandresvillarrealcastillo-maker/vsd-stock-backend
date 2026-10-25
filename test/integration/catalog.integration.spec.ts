import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Barcode } from '../../src/domain/model/barcode.js';
import { createProduct, type Product, type ProductInput } from '../../src/domain/model/product.js';
import { Sku } from '../../src/domain/model/sku.js';
import { asApplication, createAdminPool } from './support/database.js';
import { BUSINESS_A, BUSINESS_B, resetData, seedBusiness } from './support/seed.js';

/**
 * Demuestra, contra un PostgreSQL real, lo que el ADR 0015 pide a la base de datos del catalogo:
 * que los codigos sean unicos por negocio (el SKU sin distinguir mayusculas, el codigo de barras en
 * su forma de 14 digitos), que un producto archivado siga reservando los suyos, y que la forma de
 * cada campo coincida con la que valida el dominio.
 */
describe('catalog: codes and shape in the database (ADR 0015)', () => {
  let admin: pg.Pool;

  beforeAll(() => {
    admin = createAdminPool(4);
  });

  beforeEach(async () => {
    await resetData(admin);
    await seedBusiness(admin, BUSINESS_A);
    await seedBusiness(admin, BUSINESS_B);
  });

  afterAll(async () => {
    await admin.end();
  });

  const input = (overrides: Partial<ProductInput> = {}): ProductInput => ({
    name: 'Arroz 500 g',
    sku: 'ARROZ-500',
    barcode: '4006381333931',
    unit: 'unit',
    unitPrice: 4500,
    rateBp: 0,
    ...overrides,
  });

  /** Guarda un producto ya validado por el dominio, como lo hara la aplicacion. */
  const save = (product: Product, businessId = BUSINESS_A, active = true) =>
    asApplication(admin, businessId, (client) =>
      client.query<{ sku_key: string; barcode_key: string | null }>(
        `INSERT INTO product
           (id_negocio, name, sku, barcode, unit, unit_price, tax_rate_bp, tax_kind, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING sku_key, barcode_key`,
        [
          businessId,
          product.name,
          product.sku.value,
          product.barcode?.value ?? null,
          product.unit,
          product.unitPrice.amount,
          product.rateBp,
          product.rateBp > 0 ? 'taxed' : 'exempt',
          active,
        ],
      ),
    );

  /** Lo mismo pero sin pasar por el dominio, para probar lo que la base rechaza por si sola. */
  const saveRaw = (columns: Record<string, unknown>, businessId = BUSINESS_A) => {
    const row = {
      name: 'Arroz',
      sku: 'A1',
      unit: 'unit',
      unit_price: 1000,
      tax_rate_bp: 0,
      tax_kind: 'exempt',
      ...columns,
    };
    const names = Object.keys(row);
    return asApplication(admin, businessId, (client) =>
      client.query(
        `INSERT INTO product (id_negocio, ${names.join(', ')})
         VALUES ($1, ${names.map((_, index) => `$${index + 2}`).join(', ')})`,
        [businessId, ...names.map((name) => (row as Record<string, unknown>)[name])],
      ),
    );
  };

  it('stores a product the domain accepted, and its keys are the ones the domain computes', async () => {
    const samples: ProductInput[] = [
      input(),
      input({ sku: 'gas_350.ml', barcode: '036000291452', unit: 'liter', rateBp: 1900 }),
      input({ sku: 'Cod 12/B', barcode: '96385074', unit: 'kilogram', rateBp: 500 }),
      input({ sku: 'x'.repeat(40), barcode: '10614141000415', unit: 'gram' }),
      input({ sku: 'sin-codigo', barcode: null, unit: 'pound' }),
      input({ sku: 'Gratis', barcode: '5901234123457', unitPrice: 0, unit: 'milliliter' }),
    ];

    for (const sample of samples) {
      const product = createProduct(sample);
      const { rows } = await save(product);

      expect(rows[0]?.sku_key, sample.sku).toBe(product.sku.key);
      expect(rows[0]?.barcode_key ?? null, sample.sku).toBe(product.barcode?.key ?? null);
    }
  });

  describe('SKU', () => {
    it('is unique in a business, and capitals do not make it a different code', async () => {
      await save(createProduct(input({ sku: 'Arroz-500', barcode: null })));

      await expect(
        save(createProduct(input({ sku: 'ARROZ-500', barcode: null, name: 'Otro' }))),
      ).rejects.toMatchObject({ code: '23505', constraint: expect.stringContaining('sku') });
    });

    it('can be the same in another business', async () => {
      await save(createProduct(input({ barcode: null })), BUSINESS_A);

      await expect(
        save(createProduct(input({ barcode: null })), BUSINESS_B),
      ).resolves.toBeDefined();
    });
  });

  describe('barcode', () => {
    it('is unique in a business', async () => {
      await save(createProduct(input({ sku: 'A1' })));

      await expect(save(createProduct(input({ sku: 'A2' })))).rejects.toMatchObject({
        code: '23505',
        constraint: expect.stringContaining('barcode'),
      });
    });

    it('is the same product whether it is written as UPC-A or as EAN-13 with a leading zero', async () => {
      await save(createProduct(input({ sku: 'A1', barcode: '036000291452' })));

      await expect(
        save(createProduct(input({ sku: 'A2', barcode: '0036000291452' }))),
      ).rejects.toMatchObject({ code: '23505' });
    });

    it('can be the same in another business', async () => {
      await save(createProduct(input({ sku: 'A1' })), BUSINESS_A);

      await expect(save(createProduct(input({ sku: 'A1' })), BUSINESS_B)).resolves.toBeDefined();
    });

    it('is optional, and any number of products can go without one', async () => {
      for (const sku of ['A1', 'A2', 'A3']) {
        await save(createProduct(input({ sku, barcode: null })));
      }

      const { rows } = await admin.query<{ n: string }>(
        `SELECT count(*) AS n FROM product WHERE barcode IS NULL`,
      );
      expect(rows[0]?.n).toBe('3');
    });
  });

  describe('archived products', () => {
    it('keep their SKU reserved, so a report never finds two products with one code', async () => {
      await save(createProduct(input({ sku: 'VIEJO', barcode: null })), BUSINESS_A, false);

      await expect(
        save(createProduct(input({ sku: 'viejo', barcode: null, name: 'Nuevo' }))),
      ).rejects.toMatchObject({ code: '23505' });
    });

    it('keep their barcode reserved', async () => {
      await save(createProduct(input({ sku: 'VIEJO' })), BUSINESS_A, false);

      await expect(save(createProduct(input({ sku: 'NUEVO' })))).rejects.toMatchObject({
        code: '23505',
      });
    });
  });

  describe('shape', () => {
    it.each([
      ['a unit that does not exist (a box)', { unit: 'box' }],
      ['a tax rate outside the catalogue', { tax_rate_bp: 800 }],
      ['a taxed product at 0 %', { tax_kind: 'taxed', tax_rate_bp: 0 }],
      ['an exempt product at 5 %', { tax_kind: 'exempt', tax_rate_bp: 500 }],
      ['an exempt product at 19 %', { tax_kind: 'exempt', tax_rate_bp: 1900 }],
      ['an excluded product at 5 %', { tax_kind: 'excluded', tax_rate_bp: 500 }],
      ['an excluded product at 19 %', { tax_kind: 'excluded', tax_rate_bp: 1900 }],
      ['a tax kind that does not exist', { tax_kind: 'gravado' }],
      ['a negative price', { unit_price: -1 }],
      ['a price above the maximum', { unit_price: 1_000_000_000_001 }],
      ['an empty name', { name: '' }],
      ['a name with spaces around it', { name: ' Arroz ' }],
      ['a name longer than 120 characters', { name: 'x'.repeat(121) }],
      ['an empty SKU', { sku: '' }],
      ['a SKU with a forbidden character', { sku: 'A#1' }],
      ['a SKU with two spaces in a row', { sku: 'A  1' }],
      ['a SKU longer than 40 characters', { sku: 'x'.repeat(41) }],
      ['a barcode with letters', { barcode: '40063813339AB' }],
      ['a barcode of 11 digits', { barcode: '40063813339' }],
      ['a barcode of 15 digits', { barcode: '400638133393100' }],
      ['a barcode of all zeros', { barcode: '0000000000000' }],
    ])('rejects %s', async (_label, columns) => {
      await expect(saveRaw(columns)).rejects.toMatchObject({ code: '23514' });
    });

    it.each([
      ['taxed', 500],
      ['taxed', 1900],
      ['exempt', 0],
      ['excluded', 0],
    ])('accepts a product that is %s at %i basis points', async (kind, rate) => {
      await expect(saveRaw({ tax_kind: kind, tax_rate_bp: rate })).resolves.toBeDefined();
    });

    it('does not fill the tax kind by itself: a product written without it is refused, not classified (ADR 0034)', async () => {
      await expect(saveRaw({ tax_kind: null })).rejects.toMatchObject({ code: '23502' });
    });

    it('accepts the largest price and the smallest', async () => {
      await expect(saveRaw({ sku: 'A1', unit_price: 1_000_000_000_000 })).resolves.toBeDefined();
      await expect(saveRaw({ sku: 'A2', unit_price: 0 })).resolves.toBeDefined();
    });

    it('does not accept a code written in lower case where the domain would not (digits only)', async () => {
      await expect(saveRaw({ barcode: '4006381333931'.replace('3', 'a') })).rejects.toMatchObject({
        code: '23514',
      });
    });
  });

  it('shows a business only its own catalogue', async () => {
    await save(createProduct(input({ sku: 'A1', barcode: null })), BUSINESS_A);
    await save(createProduct(input({ sku: 'B1', barcode: null })), BUSINESS_B);

    const seenByA = await asApplication(admin, BUSINESS_A, (client) =>
      client.query<{ sku: string }>(`SELECT sku FROM product`),
    );

    expect(seenByA.rows.map((row) => row.sku)).toEqual(['A1']);
  });

  it('agrees with the domain about which codes are the same product', () => {
    expect(Sku.parse('Arroz-500').key).toBe('ARROZ-500');
    expect(Barcode.parse('036000291452').key).toBe(Barcode.parse('0036000291452').key);
  });
});
