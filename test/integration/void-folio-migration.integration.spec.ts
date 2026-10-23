import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownerUrlOf } from '../../scripts/prepare-database.ts';
import { asApplication } from './support/database.js';
import { BUSINESS_A, BUSINESS_B, seedBusiness } from './support/seed.js';
import { select } from './support/sql.js';

// La migracion del folio de las anulaciones (ADR 0036) sobre una base que YA tiene anulaciones, aplicada como la aplicara una persona: con el
// rol dueno de las tablas, que aqui no es superusuario ni tiene BYPASSRLS. Prueba lo que el ADR promete: las anulaciones que ya existian
// quedan numeradas por negocio, en el orden en que se hicieron, sin perder ni cambiar nada mas; el contador de cada negocio sigue desde
// ahi; y la migracion deja la historia tan inmutable y la seguridad por fila tan forzada como estaban.
//
// Trabaja en una base aparte, creada y borrada aqui: las demas especificaciones usan el esquema ya migrado de `stock_test`.

const MIGRATIONS = resolve(import.meta.dirname, '../../prisma/migrations');
const VOID_FOLIO_MIGRATION = '20261023130000_folio_de_anulaciones';
const SCRATCH = 'stock_migration_void_folio';
const BUSINESS_C = '33333333-3333-4333-8333-333333333333';

const urlOfDatabase = (adminUrl: string, database: string): string => {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
};

/** Un identificador fijo y distinto por cada `(grupo, numero)`: asi la prueba puede decir cual es cual. */
const idOf = (group: number, n: number): string =>
  `${String(group).padStart(2, '0')}000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

interface Seeded {
  readonly ownerId: string;
  readonly deviceId: string;
}

describe('the migration of the void folio, applied to a database that already has voids (ADR 0036)', () => {
  let server: pg.Pool;
  let scratch: pg.Pool;
  let owner: pg.Client;
  let before: Record<string, unknown>[];

  const COLUMNS = 'id, id_negocio, sale_id, operation_id, reason, created_at';
  // Cada anulacion: la venta, la hora en que se anoto y a que negocio pertenece. La hora NO va en el orden en que se insertan, y dos
  // comparten la misma, para que el orden de la numeracion sea el de la hora y, si empatan, el del identificador.
  const VOIDS = [
    { n: 1, business: BUSINESS_A, at: '2026-10-03T10:00:00Z' },
    { n: 2, business: BUSINESS_A, at: '2026-10-01T10:00:00Z' },
    { n: 3, business: BUSINESS_A, at: '2026-10-02T10:00:00Z' },
    { n: 4, business: BUSINESS_A, at: '2026-10-05T10:00:00Z' },
    { n: 5, business: BUSINESS_A, at: '2026-10-05T10:00:00Z' },
    { n: 6, business: BUSINESS_B, at: '2026-10-04T10:00:00Z' },
  ] as const;

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
    const earlier = readdirSync(MIGRATIONS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name < VOID_FOLIO_MIGRATION)
      .map((entry) => entry.name)
      .sort();
    for (const name of earlier) {
      await owner.query(readFileSync(join(MIGRATIONS, name, 'migration.sql'), 'utf8'));
    }

    // Datos de antes: tres negocios, uno sin anulaciones, y seis anulaciones.
    const seeded: Record<string, Seeded> = {};
    for (const business of [BUSINESS_A, BUSINESS_B, BUSINESS_C]) {
      seeded[business] = await seedBusiness(scratch, business);
    }
    for (const [index, business] of [BUSINESS_A, BUSINESS_B].entries()) {
      await scratch.query(
        `INSERT INTO cash_shift (id, id_negocio, device_id, user_id) VALUES ($1, $2, $3, $4)`,
        [idOf(9, index), business, seeded[business]?.deviceId, seeded[business]?.ownerId],
      );
    }
    for (const { n, business, at } of VOIDS) {
      const shift = idOf(9, business === BUSINESS_A ? 0 : 1);
      const user = seeded[business]?.ownerId;
      await scratch.query(
        `INSERT INTO operation (id_negocio, operation_id, kind, user_id) VALUES ($1, $2, 'sale', $3), ($1, $4, 'sale_void', $3)`,
        [business, idOf(1, n), user, idOf(2, n)],
      );
      await scratch.query(
        `INSERT INTO sale (id, id_negocio, operation_id, shift_id, folio, folio_reported, total, needs_adjustment)
         VALUES ($1, $2, $3, $4, $5, $5, 1000, false)`,
        [idOf(3, n), business, idOf(1, n), shift, `ZZ-00000${String(n)}`],
      );
      await scratch.query(
        `INSERT INTO sale_void (id, id_negocio, sale_id, operation_id, reason, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [idOf(4, n), business, idOf(3, n), idOf(2, n), `Motivo ${String(n)}`, at],
      );
    }
    before = await select(scratch, `SELECT ${COLUMNS} FROM sale_void ORDER BY id`);

    // La migracion, aplicada como la aplicara una persona.
    await owner.query(
      readFileSync(join(MIGRATIONS, VOID_FOLIO_MIGRATION, 'migration.sql'), 'utf8'),
    );
  }, 120_000);

  afterAll(async () => {
    await owner.end();
    await scratch.end();
    await server.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
    await server.end();
  });

  it('starts from data that is really there: six voids in two businesses', () => {
    expect(before).toHaveLength(6);
    expect(new Set(before.map((row) => row['id_negocio']))).toEqual(
      new Set([BUSINESS_A, BUSINESS_B]),
    );
  });

  it('numbers the voids of each business from 1, in the order they were made and, if they tie, by identifier', async () => {
    const rows = await select(
      scratch,
      `SELECT id_negocio, reason, number FROM sale_void ORDER BY id_negocio, number`,
    );

    expect(rows).toEqual([
      { id_negocio: BUSINESS_A, reason: 'Motivo 2', number: 1 },
      { id_negocio: BUSINESS_A, reason: 'Motivo 3', number: 2 },
      { id_negocio: BUSINESS_A, reason: 'Motivo 1', number: 3 },
      { id_negocio: BUSINESS_A, reason: 'Motivo 4', number: 4 },
      { id_negocio: BUSINESS_A, reason: 'Motivo 5', number: 5 },
      { id_negocio: BUSINESS_B, reason: 'Motivo 6', number: 1 },
    ]);
  });

  it('loses nothing and changes nothing else in the voids', async () => {
    const after = await select(scratch, `SELECT ${COLUMNS} FROM sale_void ORDER BY id`);

    expect(after).toEqual(before);
  });

  it('starts the counter of each business after the last number it gave, and leaves out the ones that never voided', async () => {
    const rows = await select(
      scratch,
      `SELECT id_negocio, next_number FROM void_counter ORDER BY id_negocio`,
    );

    expect(rows).toEqual([
      { id_negocio: BUSINESS_A, next_number: 6 },
      { id_negocio: BUSINESS_B, next_number: 2 },
    ]);
  });

  it('leaves the number as a plain required column with no default', async () => {
    const rows = await select(
      scratch,
      `SELECT is_nullable, column_default, is_generated, data_type
         FROM information_schema.columns WHERE table_name = 'sale_void' AND column_name = 'number'`,
    );

    expect(rows).toEqual([
      { is_nullable: 'NO', column_default: null, is_generated: 'NEVER', data_type: 'integer' },
    ]);
  });

  it.each(['sale_void', 'void_counter'])(
    'leaves the row security of %s enabled and forced',
    async (table) => {
      const rows = await select(
        scratch,
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = $1::regclass`,
        [table],
      );

      expect(rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    },
  );

  it('keeps the voids immutable: the trigger is back on, and it still refuses an UPDATE and a DELETE', async () => {
    const triggers = await select(
      scratch,
      `SELECT tgname, tgenabled FROM pg_trigger
        WHERE tgrelid = 'sale_void'::regclass AND NOT tgisinternal ORDER BY tgname`,
    );

    expect(triggers).toEqual([
      { tgname: 'refuse_history_change', tgenabled: 'O' },
      { tgname: 'refuse_history_truncate', tgenabled: 'O' },
    ]);
    await expect(scratch.query(`UPDATE sale_void SET number = 99`)).rejects.toThrow();
    await expect(scratch.query(`DELETE FROM sale_void`)).rejects.toThrow();
  });

  it('keeps the application able to read the numbers under the row security of its business, and only its own', async () => {
    const rows = await asApplication(scratch, BUSINESS_B, (client) =>
      client.query<{ number: number }>('SELECT number FROM sale_void'),
    );

    expect(rows.rows).toEqual([{ number: 1 }]);
  });

  it('lets the application give the next number from the counter of its business, and not from another', async () => {
    const given = await asApplication(scratch, BUSINESS_A, (client) =>
      client.query<{ number: number }>(
        `INSERT INTO void_counter (id_negocio, next_number) VALUES ($1::uuid, 2)
         ON CONFLICT (id_negocio) DO UPDATE SET next_number = void_counter.next_number + 1
         RETURNING next_number - 1 AS number`,
        [BUSINESS_A],
      ),
    );

    expect(given.rows).toEqual([{ number: 6 }]);
    await expect(
      asApplication(scratch, BUSINESS_A, (client) =>
        client.query(`INSERT INTO void_counter (id_negocio, next_number) VALUES ($1::uuid, 2)`, [
          BUSINESS_C,
        ]),
      ),
    ).rejects.toThrow();
  });

  it('refuses from now on a repeated number in a business, a number below 1 and a counter below 2', async () => {
    // La venta 6 ya esta anulada con el numero 1 en el negocio B: otra anulacion con ese numero choca con la unicidad por negocio.
    const insertVoid = (number: number) =>
      scratch.query(
        `INSERT INTO sale_void (id_negocio, sale_id, operation_id, reason, number)
         VALUES ($1, $2, $3, 'Otra', $4)`,
        [BUSINESS_B, idOf(3, 6), idOf(2, 6), number],
      );

    await expect(insertVoid(1)).rejects.toMatchObject({ code: '23505' });
    await expect(insertVoid(0)).rejects.toMatchObject({ code: '23514' });
    await expect(
      scratch.query(`UPDATE void_counter SET next_number = 1 WHERE id_negocio = $1`, [BUSINESS_B]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('was applied by a role that is neither a superuser nor able to skip the row security, like the real owner', async () => {
    const mine = await owner.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    );

    expect(mine.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });
});
