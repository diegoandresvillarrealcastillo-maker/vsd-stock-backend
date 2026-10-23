import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownerUrlOf } from '../../scripts/prepare-database.ts';
import { asApplication } from './support/database.js';
import { BUSINESS_A, seedBusiness } from './support/seed.js';
import { select } from './support/sql.js';

// La migracion del tipo tributario (ADR 0034) sobre una base que YA tiene datos, aplicada como la aplicara una persona: con el rol dueno
// de las tablas, que aqui no es superusuario ni tiene BYPASSRLS. Prueba lo que el ADR promete: los 5 % y 19 % quedan gravados, el 0 % queda
// exento como valor de arranque, no se pierde ni se cambia ninguna otra columna, las lineas de venta (historia inmutable) siguen siendo
// inmutables y la seguridad por fila sigue forzada.
//
// Trabaja en una base aparte, creada y borrada aqui: las demas especificaciones usan el esquema ya migrado de `stock_test`.

const MIGRATIONS = resolve(import.meta.dirname, '../../prisma/migrations');
const TAX_KIND_MIGRATION = '20261023120000_tipo_tributario';
const SCRATCH = 'stock_migration_tax_kind';

const urlOfDatabase = (adminUrl: string, database: string): string => {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
};

const OPERATION = '7a000000-0000-4000-8000-000000000001';
const SHIFT = '7b000000-0000-4000-8000-000000000001';
const SALE = '7c000000-0000-4000-8000-000000000001';
const GASEOSA = '7d000000-0000-4000-8000-000000000001';
const LECHE = '7d000000-0000-4000-8000-000000000002';
const PAN = '7d000000-0000-4000-8000-000000000003';

describe('the migration of the tax kind, applied to a database that already has data (ADR 0034)', () => {
  let server: pg.Pool;
  let scratch: pg.Pool;
  let owner: pg.Client;
  let productsBefore: Record<string, unknown>[];
  let linesBefore: Record<string, unknown>[];

  const PRODUCT_COLUMNS =
    'id, id_negocio, name, sku, barcode, unit, unit_price, tax_rate_bp, active, category_id, min_stock_milli, created_at';
  const LINE_COLUMNS =
    'id, id_negocio, sale_id, product_id, quantity_milli, unit_price, tax_rate_bp, discount, position';

  beforeAll(async () => {
    const adminUrl = process.env['TEST_DATABASE_URL'];
    if (adminUrl === undefined) throw new Error('Falta TEST_DATABASE_URL.');
    server = new pg.Pool({ connectionString: adminUrl, max: 1 });
    await server.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
    await server.query(`CREATE DATABASE ${SCRATCH}`);

    const scratchUrl = urlOfDatabase(adminUrl, SCRATCH);
    scratch = new pg.Pool({ connectionString: scratchUrl, max: 2 });
    await scratch.query(`
      DROP SCHEMA IF EXISTS public CASCADE;
      CREATE SCHEMA public AUTHORIZATION stock_owner_test;
    `);

    // Las migraciones de antes, con el rol dueno: la base queda como esta hoy en PRE.
    owner = new pg.Client({ connectionString: ownerUrlOf(scratchUrl) });
    await owner.connect();
    const before = readdirSync(MIGRATIONS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name < TAX_KIND_MIGRATION)
      .map((entry) => entry.name)
      .sort();
    for (const name of before) {
      await owner.query(readFileSync(join(MIGRATIONS, name, 'migration.sql'), 'utf8'));
    }

    // Datos de antes: tres productos (19 %, 5 % y 0 %) y una venta con una linea de cada uno.
    const seeded = await seedBusiness(scratch, BUSINESS_A);
    for (const [id, sku, rate] of [
      [GASEOSA, 'GAS-1', 1900],
      [LECHE, 'LEC-1', 500],
      [PAN, 'PAN-1', 0],
    ] as const) {
      await scratch.query(
        `INSERT INTO product (id, id_negocio, name, sku, unit, unit_price, tax_rate_bp, updated_at)
         VALUES ($1, $2, $3, $4, 'unit', 3500, $5, '2026-10-01T00:00:00Z')`,
        [id, BUSINESS_A, `Producto ${sku}`, sku, rate],
      );
    }
    await scratch.query(
      `INSERT INTO operation (id_negocio, operation_id, kind, user_id) VALUES ($1, $2, 'sale', $3)`,
      [BUSINESS_A, OPERATION, seeded.ownerId],
    );
    await scratch.query(
      `INSERT INTO cash_shift (id, id_negocio, device_id, user_id) VALUES ($1, $2, $3, $4)`,
      [SHIFT, BUSINESS_A, seeded.deviceId, seeded.ownerId],
    );
    await scratch.query(
      `INSERT INTO sale (id, id_negocio, operation_id, shift_id, folio, folio_reported, total, needs_adjustment)
       VALUES ($1, $2, $3, $4, 'ZZ-000001', 'ZZ-000001', 10500, false)`,
      [SALE, BUSINESS_A, OPERATION, SHIFT],
    );
    for (const [position, product, rate] of [
      [0, GASEOSA, 1900],
      [1, LECHE, 500],
      [2, PAN, 0],
    ] as const) {
      await scratch.query(
        `INSERT INTO sale_line (id_negocio, sale_id, product_id, quantity_milli, unit_price, tax_rate_bp, discount, position)
         VALUES ($1, $2, $3, 1000, 3500, $4, 0, $5)`,
        [BUSINESS_A, SALE, product, rate, position],
      );
    }
    productsBefore = await select(scratch, `SELECT ${PRODUCT_COLUMNS} FROM product ORDER BY sku`);
    linesBefore = await select(scratch, `SELECT ${LINE_COLUMNS} FROM sale_line ORDER BY position`);

    // La migracion, aplicada como la aplicara una persona.
    await owner.query(readFileSync(join(MIGRATIONS, TAX_KIND_MIGRATION, 'migration.sql'), 'utf8'));
  }, 120_000);

  afterAll(async () => {
    await owner.end();
    await scratch.end();
    await server.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
    await server.end();
  });

  it('starts from data that is really there: three products and three lines', () => {
    expect(productsBefore).toHaveLength(3);
    expect(linesBefore).toHaveLength(3);
  });

  it('marks the 5 % and the 19 % as taxed and the 0 % as exempt, in the products', async () => {
    const rows = await select(
      scratch,
      'SELECT sku, tax_rate_bp, tax_kind FROM product ORDER BY sku',
    );

    expect(rows).toEqual([
      { sku: 'GAS-1', tax_rate_bp: 1900, tax_kind: 'taxed' },
      { sku: 'LEC-1', tax_rate_bp: 500, tax_kind: 'taxed' },
      { sku: 'PAN-1', tax_rate_bp: 0, tax_kind: 'exempt' },
    ]);
  });

  it('marks the lines the same way', async () => {
    const rows = await select(
      scratch,
      'SELECT position, tax_rate_bp, tax_kind FROM sale_line ORDER BY position',
    );

    expect(rows).toEqual([
      { position: 0, tax_rate_bp: 1900, tax_kind: 'taxed' },
      { position: 1, tax_rate_bp: 500, tax_kind: 'taxed' },
      { position: 2, tax_rate_bp: 0, tax_kind: 'exempt' },
    ]);
  });

  it('loses nothing and changes nothing else in the products and in the lines', async () => {
    const products = await select(scratch, `SELECT ${PRODUCT_COLUMNS} FROM product ORDER BY sku`);
    const lines = await select(scratch, `SELECT ${LINE_COLUMNS} FROM sale_line ORDER BY position`);

    expect(products).toEqual(productsBefore);
    expect(lines).toEqual(linesBefore);
  });

  it('moves the change time of every product, so the read copies of the devices download them again (ADR 0028)', async () => {
    const rows = await select(
      scratch,
      `SELECT sku, updated_at > '2026-10-01T00:00:00Z' AS moved FROM product ORDER BY sku`,
    );

    expect(rows).toEqual([
      { sku: 'GAS-1', moved: true },
      { sku: 'LEC-1', moved: true },
      { sku: 'PAN-1', moved: true },
    ]);
  });

  it.each(['product', 'sale_line'])(
    'leaves the column of %s as a plain required column with no default',
    async (table) => {
      const rows = await select(
        scratch,
        `SELECT is_nullable, column_default, is_generated, data_type
           FROM information_schema.columns WHERE table_name = $1 AND column_name = 'tax_kind'`,
        [table],
      );

      expect(rows).toEqual([
        { is_nullable: 'NO', column_default: null, is_generated: 'NEVER', data_type: 'text' },
      ]);
    },
  );

  it.each(['product', 'sale_line'])(
    'leaves the row security of %s enabled and forced, as it was',
    async (table) => {
      const rows = await select(
        scratch,
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = $1::regclass`,
        [table],
      );

      expect(rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    },
  );

  it('keeps the sale lines immutable: the trigger is still there and still refuses an UPDATE', async () => {
    const triggers = await select(
      scratch,
      `SELECT tgenabled FROM pg_trigger WHERE tgrelid = 'sale_line'::regclass AND tgname = 'refuse_history_change'`,
    );

    expect(triggers).toEqual([{ tgenabled: 'O' }]);
    await expect(
      scratch.query(`UPDATE sale_line SET tax_kind = 'excluded' WHERE position = 2`),
    ).rejects.toThrow();
  });

  it('keeps the application able to read the new column under the row security of its business', async () => {
    const rows = await asApplication(scratch, BUSINESS_A, (client) =>
      client.query<{ sku: string; tax_kind: string }>(
        'SELECT sku, tax_kind FROM product ORDER BY sku',
      ),
    );

    expect(rows.rows.map((row) => `${row.sku}:${row.tax_kind}`)).toEqual([
      'GAS-1:taxed',
      'LEC-1:taxed',
      'PAN-1:exempt',
    ]);
  });

  it('refuses from now on a kind that does not fit the rate, in the products and in the lines', async () => {
    const product = (kind: string, rate: number) =>
      scratch.query(
        `INSERT INTO product (id_negocio, name, sku, unit, unit_price, tax_rate_bp, tax_kind)
         VALUES ($1, 'X', $2, 'unit', 1, $3, $4)`,
        [BUSINESS_A, `X-${kind}-${rate}`, rate, kind],
      );
    const line = (kind: string, rate: number) =>
      scratch.query(
        `INSERT INTO sale_line (id_negocio, sale_id, product_id, quantity_milli, unit_price, tax_rate_bp, tax_kind, position)
         VALUES ($1, $2, $3, 1000, 1, $4, $5, 9)`,
        [BUSINESS_A, SALE, PAN, rate, kind],
      );

    await expect(product('taxed', 0)).rejects.toMatchObject({ code: '23514' });
    await expect(product('exempt', 1900)).rejects.toMatchObject({ code: '23514' });
    await expect(product('excluded', 500)).rejects.toMatchObject({ code: '23514' });
    await expect(line('taxed', 0)).rejects.toMatchObject({ code: '23514' });
    await expect(line('exempt', 1900)).rejects.toMatchObject({ code: '23514' });
    await expect(line('excluded', 500)).rejects.toMatchObject({ code: '23514' });
    // Y deja las combinaciones que si caben.
    await expect(product('excluded', 0)).resolves.toBeDefined();
    await expect(line('excluded', 0)).resolves.toBeDefined();
  });

  it('was applied by a role that is neither a superuser nor able to skip the row security, like the real owner', async () => {
    const mine = await owner.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    );

    expect(mine.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });
});
