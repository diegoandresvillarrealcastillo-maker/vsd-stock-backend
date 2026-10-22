import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import {
  exitCodeOf,
  formatReport,
  runPreChecks,
  type DatabaseFacts,
  type JwksFacts,
  type PreProbes,
  type TransactionFacts,
} from './pre-verification.ts';

// npm run verify:pre: comprueba PRE, el Supabase real, antes de fiarse de el (ADR 0025). Lo corre UNA PERSONA en su
// maquina, con las variables en el entorno o en `.env.pre` (que no se versiona). Imprime un informe y ningun secreto.
// Sale con 0 solo si todo paso.

/** Las tablas que la aplicacion solo escribe una vez: quien tiene historia no se edita ni se borra (ADR 0005). */
const HISTORY_TABLES = [
  'purchase',
  'purchase_line',
  'stock_movement',
  'operation',
  'cash_movement',
  'sale',
  'sale_line',
  'payment',
  'sale_void',
];
const API_ROLES = ['anon', 'authenticated', 'service_role'];
const TRANSACTIONS = 25;
const PARALLEL = 5;
const JWKS_TIMEOUT_MS = 8_000;

async function withClient<T>(
  connectionString: string,
  work: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

async function readMigrations(migrationUrl: string | undefined): Promise<string[] | null> {
  if (migrationUrl === undefined || migrationUrl.trim() === '') return null;
  return withClient(migrationUrl, async (client) => {
    const result = await client.query<{ migration_name: string }>(
      'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
    );
    return result.rows.map((row) => row.migration_name);
  });
}

function inspectDatabase(migrationUrl: string | undefined): PreProbes['inspectDatabase'] {
  return async (connectionString): Promise<DatabaseFacts> => {
    const migrationsApplied = await readMigrations(migrationUrl);
    return withClient(connectionString, async (client) => {
      const who = await client.query<{ u: string; su: string }>(
        "SELECT current_user AS u, current_setting('is_superuser') AS su",
      );
      const tables = await client.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
      );
      const names = tables.rows.map((row) => row.table_name);
      const rowSecurity = await client.query<{ relname: string }>(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> '_prisma_migrations'
            AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity
                 OR NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname))`,
      );
      let visible = 0;
      for (const table of names.filter((name) => name !== '_prisma_migrations')) {
        // Sin fijar `app.id_negocio`, la seguridad por fila no deja ver ni una fila.
        const count = await client.query<{ n: string }>(
          `SELECT count(*) AS n FROM public."${table}"`,
        );
        visible += Number(count.rows[0]?.n ?? 0);
      }
      const api = await client.query<{ rolname: string; relname: string }>(
        `SELECT r.rolname, c.relname FROM pg_roles r CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE r.rolname = ANY($1) AND n.nspname = 'public' AND c.relkind IN ('r', 'v', 'm')
            AND (has_table_privilege(r.rolname, c.oid, 'SELECT') OR has_table_privilege(r.rolname, c.oid, 'INSERT')
              OR has_table_privilege(r.rolname, c.oid, 'UPDATE') OR has_table_privilege(r.rolname, c.oid, 'DELETE'))
          ORDER BY r.rolname, c.relname LIMIT 10`,
        [API_ROLES],
      );
      const ledger = await client.query<{ relname: string; privilege: string }>(
        `SELECT t AS relname, p AS privilege FROM unnest($1::text[]) AS t CROSS JOIN unnest(ARRAY['UPDATE', 'DELETE']) AS p
          WHERE to_regclass('public.' || quote_ident(t)) IS NOT NULL AND has_table_privilege(current_user, 'public.' || quote_ident(t), p)`,
        [HISTORY_TABLES],
      );
      return {
        currentUser: who.rows[0]?.u ?? '',
        isSuperuser: who.rows[0]?.su === 'on',
        tables: names,
        migrationsApplied,
        tablesWithoutRowSecurity: rowSecurity.rows.map((row) => row.relname),
        rowsVisibleWithoutBusiness: visible,
        apiRolePrivileges: api.rows.map((row) => `${row.rolname}: ${row.relname}`),
        ledgerWritable: ledger.rows.map((row) => `${row.relname}: ${row.privilege}`),
      };
    });
  };
}

interface PrismaLike {
  $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
  $disconnect: () => Promise<void>;
}
interface UnitOfWorkLike {
  inBusiness: <T>(
    businessId: string,
    work: (scope: { business: { current: () => Promise<unknown> } }) => Promise<T>,
  ) => Promise<T>;
}

/** El codigo de la aplicacion, ya compilado (`npm run build`): se prueba lo que de verdad corre, no una copia. */
async function loadApplicationCode(): Promise<{
  createPrismaClient: (url: string, options?: { max?: number }) => PrismaLike;
  PrismaUnitOfWork: new (prisma: PrismaLike) => UnitOfWorkLike;
}> {
  const dist = (path: string) => pathToFileURL(resolve('dist', path)).href;
  const client = (await import(dist('adapters/out/persistence/create-prisma-client.js'))) as {
    createPrismaClient: (url: string, options?: { max?: number }) => PrismaLike;
  };
  const unit = (await import(dist('adapters/out/persistence/prisma-unit-of-work.js'))) as {
    PrismaUnitOfWork: new (prisma: PrismaLike) => UnitOfWorkLike;
  };
  return { createPrismaClient: client.createPrismaClient, PrismaUnitOfWork: unit.PrismaUnitOfWork };
}

async function exerciseTransactions(connectionString: string): Promise<TransactionFacts> {
  const { createPrismaClient, PrismaUnitOfWork } = await loadApplicationCode();
  const prisma = createPrismaClient(connectionString, { max: PARALLEL });
  try {
    const unit = new PrismaUnitOfWork(prisma);
    let roundTrips = 0;
    const one = async () => {
      // Cada transaccion fija un negocio inventado y pregunta por el: sin filas, `current()` da null.
      await unit.inBusiness(randomUUID(), (scope) => scope.business.current());
      roundTrips += 1;
    };
    for (let index = 0; index < TRANSACTIONS - PARALLEL; index += 1) await one();
    await Promise.all(Array.from({ length: PARALLEL }, one));
    let leakedBusiness = false;
    for (let index = 0; index < PARALLEL * 2; index += 1) {
      const rows =
        (await prisma.$queryRaw`SELECT current_setting('app.id_negocio', true) AS value`) as {
          value: string | null;
        }[];
      if ((rows[0]?.value ?? '') !== '') leakedBusiness = true;
    }
    return { roundTrips, leakedBusiness };
  } finally {
    await prisma.$disconnect();
  }
}

async function fetchJwks(url: string): Promise<JwksFacts> {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(JWKS_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`el servicio respondió HTTP ${String(response.status)}`);
  const body = (await response.json()) as { keys?: unknown };
  const keys = Array.isArray(body.keys) ? (body.keys as Record<string, unknown>[]) : [];
  return {
    keys: keys.map((key) => ({
      kty: typeof key['kty'] === 'string' ? key['kty'] : 'desconocido',
      alg: typeof key['alg'] === 'string' ? key['alg'] : null,
      kid: typeof key['kid'] === 'string' ? key['kid'] : null,
    })),
  };
}

function knownMigrations(): string[] {
  return readdirSync('prisma/migrations', { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function knownTables(migrations: readonly string[]): string[] {
  const tables = new Set<string>();
  for (const name of migrations) {
    const sql = readFileSync(join('prisma/migrations', name, 'migration.sql'), 'utf8');
    for (const match of sql.matchAll(/CREATE TABLE "([a-z_]+)"/g)) tables.add(match[1] ?? '');
  }
  return [...tables];
}

const migrations = knownMigrations();
const probes: PreProbes = {
  inspectDatabase: inspectDatabase(process.env['DATABASE_MIGRATION_URL']),
  exerciseTransactions,
  fetchJwks,
};
const checks = await runPreChecks({
  env: process.env,
  probes,
  migrations,
  tables: knownTables(migrations),
});
console.log(formatReport(checks));
process.exitCode = exitCodeOf(checks);
