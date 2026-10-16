import type pg from 'pg';
import { APP_ROLE } from './database.js';

export const SCHEMA = 'rls_mechanism';
export const BUSINESS_A = '11111111-1111-4111-8111-111111111111';
export const BUSINESS_B = '22222222-2222-4222-8222-222222222222';

/**
 * Esquema de juguete para demostrar el mecanismo del ADR 0005 en un
 * PostgreSQL real, antes de que exista el esquema de negocio. Cuando exista,
 * las mismas comprobaciones se apuntan a las tablas reales.
 */
export async function createIsolationFixture(admin: pg.Pool): Promise<void> {
  await dropIsolationFixture(admin);
  await admin.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
        CREATE ROLE ${APP_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS;
      END IF;
    END $$;
    CREATE SCHEMA ${SCHEMA};
    CREATE TABLE ${SCHEMA}.product (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      id_negocio uuid NOT NULL,
      name text NOT NULL
    );
    GRANT USAGE ON SCHEMA ${SCHEMA} TO ${APP_ROLE};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ${SCHEMA}.product TO ${APP_ROLE};

    -- ADR 0005: RLS habilitado y FORCE, con una politica que compara el negocio
    -- de la fila con el contexto de la transaccion. Sin contexto, nullif() da
    -- nulo, la comparacion nunca es verdadera y la consulta ve cero filas.
    ALTER TABLE ${SCHEMA}.product ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ${SCHEMA}.product FORCE ROW LEVEL SECURITY;
    CREATE POLICY business_isolation ON ${SCHEMA}.product
      USING (id_negocio = nullif(current_setting('app.id_negocio', true), '')::uuid)
      WITH CHECK (id_negocio = nullif(current_setting('app.id_negocio', true), '')::uuid);
  `);
  await admin.query(
    `INSERT INTO ${SCHEMA}.product (id_negocio, name) VALUES
       ($1, 'a1'), ($1, 'a2'), ($2, 'b1'), ($2, 'b2')`,
    [BUSINESS_A, BUSINESS_B],
  );
}

export async function dropIsolationFixture(admin: pg.Pool): Promise<void> {
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
}
