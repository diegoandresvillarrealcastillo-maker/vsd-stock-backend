import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import pg from 'pg';
import { assertDisposableDatabase } from './database-target.ts';

/**
 * Deja la base de pruebas con el esquema REAL: los dos roles, un esquema `public` vacio y las migraciones de
 * `prisma/migrations` aplicadas por Prisma, como las aplicara una persona en un ambiente (ADR 0021).
 *
 * Lo usan `npm run db:prepare` y el arranque de las pruebas de integracion. Borra el esquema `public`: por eso se
 * niega a correr contra cualquier base que no sea local y de pruebas (ver `assertDisposableDatabase`).
 */

/**
 * Dueno de las tablas y de las funciones, como el rol de migraciones real. A proposito NO es superusuario ni tiene
 * BYPASSRLS: si el esquema funciona con un dueno sujeto a RLS, funciona tambien con el `postgres` de Supabase.
 */
export const OWNER_ROLE = 'stock_owner_test';

/** El rol de la aplicacion (ADR 0005): sin privilegios, sin BYPASSRLS y que no es dueno de nada. */
export const APP_ROLE = 'stock_app';

export const DEFAULT_TEST_DATABASE_URL = 'postgresql://stock@127.0.0.1:5433/stock_test';

/** La cadena de conexion del dueno: la misma base, otro usuario. La base de pruebas confia en conexiones locales. */
export function ownerUrlOf(adminUrl: string): string {
  const url = new URL(adminUrl);
  url.username = OWNER_ROLE;
  url.password = '';
  return url.toString();
}

export function applicationUrlOf(adminUrl: string): string {
  const url = new URL(adminUrl);
  url.username = APP_ROLE;
  url.password = '';
  return url.toString();
}

export async function prepareDatabase(
  adminUrl: string = process.env['TEST_DATABASE_URL'] ?? DEFAULT_TEST_DATABASE_URL,
): Promise<void> {
  assertDisposableDatabase(adminUrl);

  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${OWNER_ROLE}') THEN
          CREATE ROLE ${OWNER_ROLE} LOGIN;
        END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
          CREATE ROLE ${APP_ROLE} LOGIN;
        END IF;
      END $$;
      -- Los roles sobreviven a las bases: se vuelven a dejar como deben ser.
      ALTER ROLE ${OWNER_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
      ALTER ROLE ${APP_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;

      DROP SCHEMA IF EXISTS public CASCADE;
      CREATE SCHEMA public AUTHORIZATION ${OWNER_ROLE};
    `);
  } finally {
    await admin.end();
  }

  migrateDeploy(ownerUrlOf(adminUrl));
}

/** Aplica las migraciones con el CLI de Prisma, igual que lo hara una persona. */
export function migrateDeploy(migrationUrl: string): void {
  const prisma = createRequire(import.meta.url).resolve('prisma/build/index.js');
  try {
    execFileSync(process.execPath, [prisma, 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_MIGRATION_URL: migrationUrl },
      stdio: 'pipe',
    });
  } catch (error) {
    const failure = error as { stdout?: Buffer; stderr?: Buffer };
    // La salida de Prisma no lleva la contrasena (la cadena de la base de pruebas no tiene una).
    throw new Error(
      `prisma migrate deploy failed:\n${failure.stdout?.toString() ?? ''}\n${failure.stderr?.toString() ?? ''}`,
      { cause: error },
    );
  }
}

/**
 * Compara `prisma/schema.prisma` con la base ya migrada. Son dos descripciones del mismo modelo (ADR 0020) y esto
 * es lo que impide que se separen: si una cambia sin la otra, devuelve la diferencia como SQL.
 */
export function diffSchema(migrationUrl: string): { identical: boolean; output: string } {
  const prisma = createRequire(import.meta.url).resolve('prisma/build/index.js');
  const result = spawnSync(
    process.execPath,
    [
      prisma,
      'migrate',
      'diff',
      '--from-config-datasource',
      '--to-schema',
      'prisma/schema.prisma',
      '--script',
      '--exit-code',
    ],
    { env: { ...process.env, DATABASE_MIGRATION_URL: migrationUrl }, encoding: 'utf8' },
  );
  // Con --exit-code: 0 = sin diferencias, 2 = hay diferencias, 1 = fallo.
  if (result.status === 0) return { identical: true, output: '' };
  if (result.status === 2) return { identical: false, output: result.stdout };
  throw new Error(`prisma migrate diff failed:
${result.stdout}
${result.stderr}`);
}
