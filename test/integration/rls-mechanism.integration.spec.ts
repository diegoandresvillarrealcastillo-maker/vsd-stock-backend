import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { APP_ROLE, asApplication, createAdminPool } from './support/database.js';
import { BUSINESS_A, BUSINESS_B, resetData, seedBusiness } from './support/seed.js';

/**
 * Demuestra, contra un PostgreSQL real y sobre una tabla REAL (`category`), el mecanismo de aislamiento por
 * negocio del ADR 0005: un negocio no ve ni toca las filas de otro, y una consulta sin contexto devuelve cero
 * filas, no todas. Las demas tablas llevan la misma politica y `schema.integration.spec.ts` lo comprueba.
 */
describe('row level security per business (ADR 0005)', () => {
  let admin: pg.Pool;

  beforeAll(() => {
    admin = createAdminPool();
  });

  // Datos nuevos para cada prueba: una que modifica filas no debe afectar a las demas.
  beforeEach(async () => {
    await resetData(admin);
    await seedBusiness(admin, BUSINESS_A);
    await seedBusiness(admin, BUSINESS_B);
    await admin.query(
      `INSERT INTO category (id_negocio, name) VALUES ($1, 'a1'), ($1, 'a2'), ($2, 'b1'), ($2, 'b2')`,
      [BUSINESS_A, BUSINESS_B],
    );
  });

  afterAll(async () => {
    await admin.end();
  });

  const names = async (client: pg.PoolClient) =>
    (await client.query<{ name: string }>(`SELECT name FROM category ORDER BY name`)).rows.map(
      (row) => row.name,
    );

  it('returns zero rows, not all of them, when there is no business context', async () => {
    const seen = await asApplication(admin, null, names);

    expect(seen).toEqual([]);
  });

  it('shows business A only its own rows', async () => {
    expect(await asApplication(admin, BUSINESS_A, names)).toEqual(['a1', 'a2']);
  });

  it('shows business B only its own rows', async () => {
    expect(await asApplication(admin, BUSINESS_B, names)).toEqual(['b1', 'b2']);
  });

  it('rejects a row that belongs to another business (WITH CHECK)', async () => {
    const insertForB = asApplication(admin, BUSINESS_A, (client) =>
      client.query(`INSERT INTO category (id_negocio, name) VALUES ($1, 'intruder')`, [BUSINESS_B]),
    );

    await expect(insertForB).rejects.toThrow(/row-level security/);
  });

  it('lets business A neither update nor delete the rows of business B', async () => {
    const touched = await asApplication(admin, BUSINESS_A, async (client) => {
      const update = await client.query(`UPDATE category SET name = name || 'x'`);
      const remove = await client.query(`DELETE FROM category WHERE name LIKE 'b%'`);
      return { updated: update.rowCount, removed: remove.rowCount };
    });

    // Solo pudo actualizar lo suyo y no pudo borrar nada de B.
    expect(touched).toEqual({ updated: 2, removed: 0 });
    const rowsOfB = await admin.query<{ name: string }>(
      `SELECT name FROM category WHERE id_negocio = $1 ORDER BY name`,
      [BUSINESS_B],
    );
    expect(rowsOfB.rows.map((row) => row.name)).toEqual(['b1', 'b2']);
  });

  it('does not leak the context of one transaction into the next one on the same connection', async () => {
    const onePool = createAdminPool(1);
    try {
      const first = await asApplication(onePool, BUSINESS_A, names);
      const second = await asApplication(onePool, null, names);

      expect(first.length).toBeGreaterThan(0);
      expect(second).toEqual([]);
    } finally {
      await onePool.end();
    }
  });

  it('runs the application as a role that can neither bypass the policies nor own the table', async () => {
    const role = await admin.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1',
      [APP_ROLE],
    );
    const owner = await admin.query<{ tableowner: string }>(
      'SELECT tableowner FROM pg_tables WHERE schemaname = $1 AND tablename = $2',
      ['public', 'category'],
    );

    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    expect(owner.rows[0]?.tableowner).not.toBe(APP_ROLE);
  });
});
