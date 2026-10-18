import type pg from 'pg';

export const SCHEMA = 'rls_checker';

/**
 * Un esquema de juguete SOLO para probar a quien revisa los esquemas (rls-catalog.ts): necesita tablas
 * deliberadamente mal protegidas para demostrar que las delata, y el esquema real no puede tenerlas. Las
 * comprobaciones del aislamiento en si corren sobre las tablas reales.
 */
export async function createRlsCheckerFixture(admin: pg.Pool): Promise<void> {
  await dropRlsCheckerFixture(admin);
  await admin.query(`
    CREATE SCHEMA ${SCHEMA};
    CREATE TABLE ${SCHEMA}.protected (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      id_negocio uuid NOT NULL
    );
    ALTER TABLE ${SCHEMA}.protected ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ${SCHEMA}.protected FORCE ROW LEVEL SECURITY;
    CREATE POLICY business_isolation ON ${SCHEMA}.protected
      USING (id_negocio = nullif(current_setting('app.id_negocio', true), '')::uuid);
  `);
}

export async function dropRlsCheckerFixture(admin: pg.Pool): Promise<void> {
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
}
