import { describe, expect, it } from 'vitest';
import {
  exitCodeOf,
  formatReport,
  redact,
  runPreChecks,
  secretsOf,
  type Check,
  type DatabaseFacts,
  type JwksFacts,
  type PreProbes,
  type TransactionFacts,
} from '../../scripts/pre-verification.ts';

// La verificacion de PRE la corre una persona contra el Supabase real (ADR 0025). Estas pruebas la ejercitan con
// respuestas de mentira y vigilan lo mas importante: lo que imprime nunca lleva una contrasena, una clave ni la cadena
// de conexion, ni siquiera dentro del mensaje de un error.

const PASSWORD = 'S3cretoLargo123';
const REF = 'abcdefghijklmnop';
const KEY = 'sb_publishable_FALSA1234567890';
const DATABASE_URL = `postgresql://stock_app.${REF}:${PASSWORD}@aws-0-sa-east-1.pooler.supabase.com:5432/postgres`;
const MIGRATION_URL = `postgresql://postgres.${REF}:${PASSWORD}-otra@aws-0-sa-east-1.pooler.supabase.com:5432/postgres`;
const ISSUER = `https://${REF}.supabase.co/auth/v1`;
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;

const ENV = {
  DATABASE_URL,
  DATABASE_MIGRATION_URL: MIGRATION_URL,
  AUTH_ISSUER: ISSUER,
  AUTH_JWKS_URL: JWKS_URL,
  AUTH_AUDIENCE: 'authenticated',
  VITE_AUTH_PUBLISHABLE_KEY: KEY,
};

const TABLES = ['business', 'product', 'stock_movement'];
const MIGRATIONS = ['20261017120000_modelo_inicial', '20261017130000_invitaciones'];

const goodDatabase: DatabaseFacts = {
  currentUser: 'stock_app',
  isSuperuser: false,
  tables: [...TABLES, '_prisma_migrations'],
  migrationsApplied: [...MIGRATIONS],
  tablesWithoutRowSecurity: [],
  rowsVisibleWithoutBusiness: 0,
  apiRolePrivileges: [],
  ledgerWritable: [],
};
const goodTransactions: TransactionFacts = { roundTrips: 25, leakedBusiness: false };
const goodJwks: JwksFacts = {
  keys: [{ kty: 'EC', alg: 'ES256', kid: 'k1' }],
};

function probes(overrides: Partial<PreProbes> = {}): PreProbes & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    inspectDatabase: (url) => {
      calls.push(`inspectDatabase ${url === DATABASE_URL ? 'app' : 'otra'}`);
      return Promise.resolve(goodDatabase);
    },
    exerciseTransactions: () => {
      calls.push('exerciseTransactions');
      return Promise.resolve(goodTransactions);
    },
    fetchJwks: (url) => {
      calls.push(`fetchJwks ${url === JWKS_URL ? 'jwks' : 'otra'}`);
      return Promise.resolve(goodJwks);
    },
    ...overrides,
  };
}

const run = (env: Record<string, string | undefined>, p: PreProbes = probes()) =>
  runPreChecks({ env, probes: p, migrations: MIGRATIONS, tables: TABLES });

const byId = (checks: Check[], id: string) => {
  const check = checks.find((candidate) => candidate.id === id);
  if (check === undefined) throw new Error(`falta la comprobacion ${id}`);
  return check;
};

describe('runPreChecks', () => {
  it('passes every check against a well configured PRE, in a fixed order', async () => {
    const checks = await run(ENV);

    expect(checks.map((check) => [check.id, check.status])).toEqual([
      ['env', 'pass'],
      ['database-target', 'pass'],
      ['database-connection', 'pass'],
      ['database-schema', 'pass'],
      ['row-security', 'pass'],
      ['api-roles-closed', 'pass'],
      ['ledger-append-only', 'pass'],
      ['transactions', 'pass'],
      ['jwks', 'pass'],
    ]);
    expect(exitCodeOf(checks)).toBe(0);
  });

  describe('the environment', () => {
    it('says which variables are missing, by name, and skips what needs them', async () => {
      const { calls, ...p } = probes();

      const checks = await run({ AUTH_AUDIENCE: 'authenticated' }, { ...p });

      expect(byId(checks, 'env')).toMatchObject({ status: 'fail' });
      expect(byId(checks, 'env').detail).toContain('DATABASE_URL');
      expect(byId(checks, 'env').detail).toContain('AUTH_ISSUER');
      expect(byId(checks, 'env').detail).toContain('AUTH_JWKS_URL');
      expect(
        checks.filter((check) => check.id !== 'env').every((check) => check.status === 'skip'),
      ).toBe(true);
      expect(checks).toHaveLength(9);
      expect(calls).toEqual([]);
      expect(exitCodeOf(checks)).toBe(1);
    });

    it('takes an empty variable for a missing one', async () => {
      const checks = await run({ ...ENV, AUTH_ISSUER: '   ' });

      expect(byId(checks, 'env').status).toBe('fail');
      expect(byId(checks, 'env').detail).toContain('AUTH_ISSUER');
    });

    it('does not need the migration connection or the audience', async () => {
      const { DATABASE_MIGRATION_URL: _a, AUTH_AUDIENCE: _b, ...rest } = ENV;

      const checks = await run(rest);

      expect(byId(checks, 'env').status).toBe('pass');
    });
  });

  describe('the database address', () => {
    it('describes it without the password, the project reference or the full host', async () => {
      const checks = await run(ENV);

      const detail = byId(checks, 'database-target').detail;
      expect(detail).toContain('stock_app');
      expect(detail).toContain('5432');
      expect(detail).toContain('pooler.supabase.com');
      expect(detail).not.toContain(PASSWORD);
      expect(detail).not.toContain(REF);
      expect(detail).not.toContain('aws-0-sa-east-1');
    });

    it('refuses to run as the owner of the database: the app must run with its own role', async () => {
      const checks = await run({
        ...ENV,
        DATABASE_URL: `postgresql://postgres.${REF}:${PASSWORD}@aws-0-sa-east-1.pooler.supabase.com:5432/postgres`,
      });

      expect(byId(checks, 'database-target').status).toBe('fail');
      expect(byId(checks, 'database-target').detail).toContain('stock_app');
    });

    it('refuses the transaction pooler (6543): it has no prepared statements', async () => {
      const checks = await run({
        ...ENV,
        DATABASE_URL: `postgresql://stock_app.${REF}:${PASSWORD}@aws-0-sa-east-1.pooler.supabase.com:6543/postgres`,
      });

      expect(byId(checks, 'database-target').status).toBe('fail');
      expect(byId(checks, 'database-target').detail).toContain('5432');
    });

    it('refuses a host that is not the pooler of Supabase, unless it is this machine', async () => {
      const elsewhere = await run({
        ...ENV,
        DATABASE_URL: `postgresql://stock_app:${PASSWORD}@db.ejemplo.com:5432/postgres`,
      });
      const local = await run({
        ...ENV,
        DATABASE_URL: `postgresql://stock_app:${PASSWORD}@127.0.0.1:5433/stock`,
      });

      expect(byId(elsewhere, 'database-target').status).toBe('fail');
      expect(byId(local, 'database-target').status).toBe('pass');
      expect(byId(local, 'database-target').detail).toContain('esta máquina');
    });

    it('says the address is not valid without repeating it', async () => {
      const checks = await run({ ...ENV, DATABASE_URL: `no-es-una-url-${PASSWORD}` });

      expect(byId(checks, 'database-target').status).toBe('fail');
      expect(byId(checks, 'database-target').detail).not.toContain(PASSWORD);
    });

    it('does not touch the database when the address is wrong', async () => {
      const p = probes();

      await run(
        {
          ...ENV,
          DATABASE_URL: `postgresql://postgres.${REF}:${PASSWORD}@aws-0.pooler.supabase.com:5432/x`,
        },
        p,
      );

      expect(p.calls.filter((call) => call.startsWith('inspectDatabase'))).toEqual([]);
      expect(p.calls).not.toContain('exerciseTransactions');
    });
  });

  describe('the connection and the role', () => {
    it('connects with the connection string of the app, and only that one', async () => {
      const p = probes();

      await run(ENV, p);

      expect(p.calls).toEqual(['inspectDatabase app', 'exerciseTransactions', 'fetchJwks jwks']);
    });

    it('fails when the database does not answer, and skips what depends on it', async () => {
      const checks = await run(
        ENV,
        probes({ inspectDatabase: () => Promise.reject(new Error('connect ECONNREFUSED')) }),
      );

      expect(byId(checks, 'database-connection').status).toBe('fail');
      expect(byId(checks, 'database-connection').detail).toContain('ECONNREFUSED');
      for (const id of [
        'database-schema',
        'row-security',
        'api-roles-closed',
        'ledger-append-only',
      ]) {
        expect(byId(checks, id).status).toBe('skip');
      }
      expect(byId(checks, 'jwks').status).toBe('pass');
    });

    it('fails when the app connects as a superuser or as another role', async () => {
      const superuser = await run(
        ENV,
        probes({ inspectDatabase: () => Promise.resolve({ ...goodDatabase, isSuperuser: true }) }),
      );
      const other = await run(
        ENV,
        probes({
          inspectDatabase: () => Promise.resolve({ ...goodDatabase, currentUser: 'postgres' }),
        }),
      );

      expect(byId(superuser, 'database-connection').status).toBe('fail');
      expect(byId(superuser, 'database-connection').detail).toContain('superusuario');
      expect(byId(other, 'database-connection').status).toBe('fail');
      expect(byId(other, 'database-connection').detail).toContain('postgres');
    });
  });

  describe('the schema', () => {
    it('names the tables that are missing', async () => {
      const checks = await run(
        ENV,
        probes({
          inspectDatabase: () =>
            Promise.resolve({ ...goodDatabase, tables: ['business', '_prisma_migrations'] }),
        }),
      );

      expect(byId(checks, 'database-schema').status).toBe('fail');
      expect(byId(checks, 'database-schema').detail).toContain('product');
      expect(byId(checks, 'database-schema').detail).toContain('stock_movement');
    });

    it('names the migrations that were not applied', async () => {
      const checks = await run(
        ENV,
        probes({
          inspectDatabase: () =>
            Promise.resolve({ ...goodDatabase, migrationsApplied: [MIGRATIONS[0] ?? ''] }),
        }),
      );

      expect(byId(checks, 'database-schema').status).toBe('fail');
      expect(byId(checks, 'database-schema').detail).toContain('20261017130000_invitaciones');
    });

    it('says the migrations could not be read when the migration connection is missing', async () => {
      const checks = await run(
        ENV,
        probes({
          inspectDatabase: () => Promise.resolve({ ...goodDatabase, migrationsApplied: null }),
        }),
      );

      expect(byId(checks, 'database-schema').status).toBe('fail');
      expect(byId(checks, 'database-schema').detail).toContain('DATABASE_MIGRATION_URL');
    });

    it('fails when the database has migrations this version does not know', async () => {
      const checks = await run(
        ENV,
        probes({
          inspectDatabase: () =>
            Promise.resolve({
              ...goodDatabase,
              migrationsApplied: [...MIGRATIONS, '20270101000000_futura'],
            }),
        }),
      );

      expect(byId(checks, 'database-schema').status).toBe('fail');
      expect(byId(checks, 'database-schema').detail).toContain('20270101000000_futura');
    });
  });

  describe('what keeps one business from seeing another', () => {
    it('names the tables without row security', async () => {
      const checks = await run(
        ENV,
        probes({
          inspectDatabase: () =>
            Promise.resolve({ ...goodDatabase, tablesWithoutRowSecurity: ['product'] }),
        }),
      );

      expect(byId(checks, 'row-security').status).toBe('fail');
      expect(byId(checks, 'row-security').detail).toContain('product');
    });

    it('fails when rows are visible without saying which business is asking', async () => {
      const checks = await run(
        ENV,
        probes({
          inspectDatabase: () =>
            Promise.resolve({ ...goodDatabase, rowsVisibleWithoutBusiness: 3 }),
        }),
      );

      expect(byId(checks, 'row-security').status).toBe('fail');
      expect(byId(checks, 'row-security').detail).toContain('3');
    });

    it('fails when the data API of Supabase can read tables, naming the role', async () => {
      const checks = await run(
        ENV,
        probes({
          inspectDatabase: () =>
            Promise.resolve({ ...goodDatabase, apiRolePrivileges: ['anon: product'] }),
        }),
      );

      expect(byId(checks, 'api-roles-closed').status).toBe('fail');
      expect(byId(checks, 'api-roles-closed').detail).toContain('anon');
    });

    it('fails with a single row visible: one is already too many', async () => {
      const checks = await run(
        ENV,
        probes({
          inspectDatabase: () =>
            Promise.resolve({ ...goodDatabase, rowsVisibleWithoutBusiness: 1 }),
        }),
      );

      expect(byId(checks, 'row-security').status).toBe('fail');
    });

    it('fails when the app can change the history of movements', async () => {
      const checks = await run(
        ENV,
        probes({
          inspectDatabase: () =>
            Promise.resolve({ ...goodDatabase, ledgerWritable: ['stock_movement: UPDATE'] }),
        }),
      );

      expect(byId(checks, 'ledger-append-only').status).toBe('fail');
      expect(byId(checks, 'ledger-append-only').detail).toContain('stock_movement');
    });
  });

  describe('transactions through the pooler', () => {
    it('fails when the business of one transaction is still there for the next', async () => {
      const checks = await run(
        ENV,
        probes({
          exerciseTransactions: () => Promise.resolve({ roundTrips: 25, leakedBusiness: true }),
        }),
      );

      expect(byId(checks, 'transactions').status).toBe('fail');
      expect(byId(checks, 'transactions').detail).toContain('se filtró');
    });

    it('fails when too few transactions finished', async () => {
      const checks = await run(
        ENV,
        probes({
          exerciseTransactions: () => Promise.resolve({ roundTrips: 3, leakedBusiness: false }),
        }),
      );

      expect(byId(checks, 'transactions').status).toBe('fail');
    });

    it.each([
      [19, 'fail'],
      [20, 'pass'],
      [24, 'pass'],
    ])('with %i transactions finished it %s', async (roundTrips, status) => {
      const checks = await run(
        ENV,
        probes({
          exerciseTransactions: () => Promise.resolve({ roundTrips, leakedBusiness: false }),
        }),
      );

      expect(byId(checks, 'transactions').status).toBe(status);
    });

    it('reports what the adapter said when a transaction fails', async () => {
      const checks = await run(
        ENV,
        probes({
          exerciseTransactions: () =>
            Promise.reject(new Error('prepared statement "s0" already exists')),
        }),
      );

      expect(byId(checks, 'transactions').status).toBe('fail');
      expect(byId(checks, 'transactions').detail).toContain('prepared statement');
    });
  });

  describe('the identity keys', () => {
    it('fails when the project publishes no keys: it still signs with a shared secret', async () => {
      const checks = await run(ENV, probes({ fetchJwks: () => Promise.resolve({ keys: [] }) }));

      expect(byId(checks, 'jwks').status).toBe('fail');
      expect(byId(checks, 'jwks').detail).toContain('secreto compartido');
    });

    it('fails when a key is symmetric', async () => {
      const checks = await run(
        ENV,
        probes({
          fetchJwks: () => Promise.resolve({ keys: [{ kty: 'oct', alg: 'HS256', kid: 'k' }] }),
        }),
      );

      expect(byId(checks, 'jwks').status).toBe('fail');
      expect(byId(checks, 'jwks').detail).toContain('simétrica');
    });

    it.each([
      ['EC', 'ES256'],
      ['RSA', 'RS256'],
      ['OKP', 'EdDSA'],
    ])('accepts a %s key signed with %s', async (kty, alg) => {
      const checks = await run(
        ENV,
        probes({ fetchJwks: () => Promise.resolve({ keys: [{ kty, alg, kid: 'k' }] }) }),
      );

      expect(byId(checks, 'jwks').status).toBe('pass');
    });

    it('says how many keys and with which algorithms, never the keys themselves', async () => {
      const checks = await run(ENV);

      expect(byId(checks, 'jwks').detail).toBe('1 clave asimétrica (ES256).');
      expect(byId(checks, 'jwks').detail).toContain('ES256');
      expect(byId(checks, 'jwks').detail).not.toContain('k1');
    });

    it('fails when the keys come from another place than the issuer', async () => {
      const checks = await run({
        ...ENV,
        AUTH_JWKS_URL: 'https://otro.supabase.co/auth/v1/.well-known/jwks.json',
      });

      expect(byId(checks, 'jwks').status).toBe('fail');
      expect(byId(checks, 'jwks').detail).toContain('emisor');
    });

    it('refuses plain http unless the keys are on this machine', async () => {
      const remote = await run({
        ...ENV,
        AUTH_ISSUER: 'http://x.supabase.co/auth/v1',
        AUTH_JWKS_URL: 'http://x.supabase.co/auth/v1/.well-known/jwks.json',
      });
      const local = await run({
        ...ENV,
        AUTH_ISSUER: 'http://127.0.0.1:54321/auth/v1',
        AUTH_JWKS_URL: 'http://127.0.0.1:54321/auth/v1/.well-known/jwks.json',
      });

      expect(byId(remote, 'jwks').status).toBe('fail');
      expect(byId(remote, 'jwks').detail).toContain('https');
      expect(byId(local, 'jwks').status).toBe('pass');
    });

    it('judges a key by its type and by its algorithm, each on its own', async () => {
      const noAlgorithm = await run(
        ENV,
        probes({
          fetchJwks: () => Promise.resolve({ keys: [{ kty: 'oct', alg: null, kid: 'k' }] }),
        }),
      );
      const symmetricAlgorithm = await run(
        ENV,
        probes({
          fetchJwks: () => Promise.resolve({ keys: [{ kty: 'EC', alg: 'HS256', kid: 'k' }] }),
        }),
      );

      expect(byId(noAlgorithm, 'jwks').status).toBe('fail');
      expect(byId(symmetricAlgorithm, 'jwks').status).toBe('fail');
    });

    it('says «claves» for more than one, and each algorithm once', async () => {
      const checks = await run(
        ENV,
        probes({
          fetchJwks: () =>
            Promise.resolve({
              keys: [
                { kty: 'EC', alg: 'ES256', kid: 'a' },
                { kty: 'EC', alg: 'ES256', kid: 'b' },
              ],
            }),
        }),
      );

      expect(byId(checks, 'jwks').detail).toBe('2 claves asimétricas (ES256).');
    });

    it('requires https of the issuer and of the keys, each on its own', async () => {
      const plainKeys = await run({
        ...ENV,
        AUTH_JWKS_URL: `http://${REF}.supabase.co/auth/v1/.well-known/jwks.json`,
      });
      const plainIssuer = await run({
        ...ENV,
        AUTH_ISSUER: `http://${REF}.supabase.co/auth/v1`,
      });

      expect(byId(plainKeys, 'jwks').detail).toContain('https');
      expect(byId(plainIssuer, 'jwks').detail).toContain('https');
    });

    it('does not take the keys for local when only the issuer is on this machine', async () => {
      const checks = await run({
        ...ENV,
        AUTH_ISSUER: 'http://127.0.0.1:54321/auth/v1',
        AUTH_JWKS_URL: 'http://otro.ejemplo.com/auth/v1/.well-known/jwks.json',
      });

      expect(byId(checks, 'jwks').status).toBe('fail');
      expect(byId(checks, 'jwks').detail).toContain('https');
    });

    it('fails when the keys can not be fetched', async () => {
      const checks = await run(
        ENV,
        probes({ fetchJwks: () => Promise.reject(new Error('fetch failed')) }),
      );

      expect(byId(checks, 'jwks').status).toBe('fail');
      expect(byId(checks, 'jwks').detail).toContain('fetch failed');
    });

    it('does not fetch anything when the address of the keys is not an address', async () => {
      const p = probes();

      const checks = await run({ ...ENV, AUTH_JWKS_URL: 'no-es-una-url' }, p);

      expect(byId(checks, 'jwks').status).toBe('fail');
      expect(p.calls.filter((call) => call.startsWith('fetchJwks'))).toEqual([]);
    });
  });
});

describe('what is printed never carries a secret', () => {
  const secrets = secretsOf(ENV);

  it('knows the secrets: the passwords, the connection strings and the publishable key', () => {
    expect(secrets).toEqual(
      expect.arrayContaining([PASSWORD, `${PASSWORD}-otra`, DATABASE_URL, MIGRATION_URL, KEY]),
    );
  });

  it('redacts them wherever they appear, every time', () => {
    const text = `falló ${DATABASE_URL} con ${PASSWORD} y otra vez ${PASSWORD} y la clave ${KEY}`;

    const clean = redact(text, secrets);

    for (const secret of secrets) expect(clean).not.toContain(secret);
    expect(clean).toContain('***');
  });

  it('redacts the longer secret first, so no piece of it is left', () => {
    expect(redact(`${PASSWORD}-otra`, secrets)).toBe('***');
  });

  it('does not break on a secret that is empty or has symbols that mean something to a regular expression', () => {
    expect(redact('hola', ['', 'a+b'])).toBe('hola');
    expect(redact('x a+b y', ['a+b'])).toBe('x *** y');
  });

  it('knows the key of the PRE variable too, and the reference of the project from either address', () => {
    expect(secretsOf({ PRE_AUTH_PUBLISHABLE_KEY: KEY })).toEqual([KEY]);
    expect(secretsOf({ DATABASE_URL })).toContain(REF);
    expect(secretsOf({ AUTH_ISSUER: ISSUER })).toEqual([REF]);
  });

  it('does not take for a secret what is not one: a user without a reference, a host that is not Supabase', () => {
    const local = 'postgresql://stock_app@127.0.0.1:5433/stock';

    expect(secretsOf({ DATABASE_URL: local })).toEqual([local]);
    expect(secretsOf({ AUTH_ISSUER: 'https://auth.ejemplo.com/v1' })).toEqual([]);
  });

  it('knows a password written with percent signs both ways, as typed and as it really is', () => {
    const secrets = secretsOf({
      DATABASE_URL: 'postgresql://stock_app.abc:p%40ss@h.pooler.supabase.com:5432/postgres',
    });

    expect(secrets).toEqual(expect.arrayContaining(['p%40ss', 'p@ss']));
  });

  it('shows only the first line of an error that has several', async () => {
    const checks = await run(
      ENV,
      probes({
        inspectDatabase: () => Promise.reject(new Error('primera línea\nsegunda con detalle')),
      }),
    );

    expect(byId(checks, 'database-connection').detail).toContain('primera línea');
    expect(byId(checks, 'database-connection').detail).not.toContain('segunda');
  });

  it('ignores a connection string that is not an address instead of failing', () => {
    expect(secretsOf({ DATABASE_URL: 'no-es-una-url' })).toEqual(['no-es-una-url']);
  });

  it('keeps every secret out of the report, even when the failing error carries them', async () => {
    const noisy = (what: string) =>
      new Error(`${what}: ${DATABASE_URL} ${PASSWORD} ${KEY} ${MIGRATION_URL}`);
    const checks = await run(
      ENV,
      probes({
        inspectDatabase: () => Promise.reject(noisy('conexión')),
        exerciseTransactions: () => Promise.reject(noisy('transacción')),
        fetchJwks: () => Promise.reject(noisy('claves')),
      }),
    );

    const report = formatReport(checks);

    expect(report).toContain('conexión');
    for (const secret of secretsOf(ENV)) expect(report).not.toContain(secret);
    expect(report).not.toContain(REF);
  });

  it('keeps every secret out of the report when everything passes, too', async () => {
    const report = formatReport(await run(ENV));

    for (const secret of secretsOf(ENV)) expect(report).not.toContain(secret);
    expect(report).not.toContain(REF);
    expect(report).not.toContain('aws-0-sa-east-1');
  });

  it('keeps an overlong error short', async () => {
    const checks = await run(
      ENV,
      probes({ inspectDatabase: () => Promise.reject(new Error('x'.repeat(5000))) }),
    );

    expect(byId(checks, 'database-connection').detail.length).toBeLessThan(400);
  });

  it('says something general when what was thrown is not an error', async () => {
    const checks = await run(
      ENV,
      probes({
        // Una biblioteca puede lanzar cualquier cosa: lo que no es un error no se repite.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        inspectDatabase: () => Promise.reject('texto suelto'),
      }),
    );

    expect(byId(checks, 'database-connection').detail).toContain('error desconocido');
  });
});

describe('formatReport and exitCodeOf', () => {
  const sample: Check[] = [
    { id: 'env', title: 'Variables de entorno', status: 'pass', detail: 'Están las tres.' },
    { id: 'jwks', title: 'Claves de identidad', status: 'fail', detail: 'No publica claves.' },
    { id: 'transactions', title: 'Transacciones', status: 'skip', detail: 'Sin base.' },
  ];

  it('writes one line per check with its state, and a summary', () => {
    const report = formatReport(sample);

    expect(report).toContain('[PASA]');
    expect(report).toContain('[FALLA]');
    expect(report).toContain('[OMITIDA]');
    expect(report).toContain('Variables de entorno');
    expect(report).toContain('No publica claves.');
    expect(report.split('\n').pop()).toBe('Resultado: 1 pasa, 1 falla, 1 omitida');
  });

  it('says it all passed when it did', () => {
    const report = formatReport([sample[0] as Check]);

    expect(report.split('\n').pop()).toBe('Resultado: 1 pasa, 0 fallan, 0 omitidas');
  });

  it('exits with 0 only when nothing failed, skipped checks included', () => {
    expect(exitCodeOf([])).toBe(0);
    expect(exitCodeOf([sample[0] as Check, sample[2] as Check])).toBe(0);
    expect(exitCodeOf(sample)).toBe(1);
  });
});
