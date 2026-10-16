import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAdminPool } from './support/database.js';
import {
  SCHEMA,
  createIsolationFixture,
  dropIsolationFixture,
} from './support/isolation-fixture.js';
import { findTablesWithoutForcedRls } from './support/rls-catalog.js';

/**
 * La red de seguridad del ADR 0005: una tabla con `id_negocio` a la que se le
 * olvida RLS no da ningun error, simplemente deja ver los datos de todos.
 * Esta comprobacion recorre el catalogo de PostgreSQL y la delata. Cuando
 * exista el esquema de negocio se apuntara a el.
 */
describe('catalog check: every table with id_negocio has forced RLS (ADR 0005)', () => {
  let admin: pg.Pool;

  beforeAll(() => {
    admin = createAdminPool();
  });

  beforeEach(async () => {
    await createIsolationFixture(admin);
  });

  afterAll(async () => {
    await dropIsolationFixture(admin);
    await admin.end();
  });

  it('reports nothing when every table with id_negocio is protected', async () => {
    expect(await findTablesWithoutForcedRls(admin, SCHEMA)).toEqual([]);
  });

  it('reports a table with id_negocio that has no RLS at all', async () => {
    await admin.query(`CREATE TABLE ${SCHEMA}.unprotected (id_negocio uuid NOT NULL)`);

    expect(await findTablesWithoutForcedRls(admin, SCHEMA)).toEqual(['unprotected']);
  });

  it('reports a table whose RLS is enabled but not forced', async () => {
    await admin.query(`CREATE TABLE ${SCHEMA}.not_forced (id_negocio uuid NOT NULL)`);
    await admin.query(`ALTER TABLE ${SCHEMA}.not_forced ENABLE ROW LEVEL SECURITY`);

    expect(await findTablesWithoutForcedRls(admin, SCHEMA)).toEqual(['not_forced']);
  });

  it('ignores tables that have no id_negocio column', async () => {
    await admin.query(`CREATE TABLE ${SCHEMA}.catalog_of_units (code text PRIMARY KEY)`);

    expect(await findTablesWithoutForcedRls(admin, SCHEMA)).toEqual([]);
  });
});
