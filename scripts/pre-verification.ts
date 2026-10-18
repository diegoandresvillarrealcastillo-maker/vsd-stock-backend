import { describeDatabaseTarget, isLocalHost } from './database-target.ts';

/**
 * Lo que se comprueba de PRE, el Supabase real, antes de fiarse de el (ADR 0025). Este modulo solo decide: lo que toca la red
 * y la base lo traen las sondas (`PreProbes`), para poder ejercitarlo con respuestas de mentira. Y no imprime NADA que sea
 * un secreto: ni contrasenas, ni cadenas de conexion, ni claves, ni la referencia del proyecto, ni dentro del mensaje de un
 * error de otra biblioteca.
 */

export type CheckStatus = 'pass' | 'fail' | 'skip';

export interface Check {
  readonly id: string;
  readonly title: string;
  readonly status: CheckStatus;
  /** Lo que se le dice a la persona. Ya sin secretos. */
  readonly detail: string;
}

/** Lo que se lee de la base cuando la aplicacion se conecta con su propio rol. */
export interface DatabaseFacts {
  readonly currentUser: string;
  readonly isSuperuser: boolean;
  /** Las tablas del esquema `public`. */
  readonly tables: readonly string[];
  /**
   * Las migraciones que la base dice haber terminado de aplicar, o `null` si no se pudieron leer: la tabla de migraciones es del
   * rol de migraciones y la aplicacion no tiene permiso sobre ella.
   */
  readonly migrationsApplied: readonly string[] | null;
  /** Las tablas del negocio que no tienen la seguridad por fila activa y forzada. */
  readonly tablesWithoutRowSecurity: readonly string[];
  /** Cuantas filas ve la aplicacion sin decir de que negocio pregunta: tiene que ser cero. */
  readonly rowsVisibleWithoutBusiness: number;
  /** Los privilegios que la API de datos de Supabase (anon, authenticated, service_role) tiene sobre tablas: ninguno. */
  readonly apiRolePrivileges: readonly string[];
  /** Los privilegios de cambiar o borrar que la aplicacion tiene sobre las tablas de historial: ninguno. */
  readonly ledgerWritable: readonly string[];
}

/** Lo que se ve al abrir y cerrar transacciones por el adaptador de Prisma a traves del pooler. */
export interface TransactionFacts {
  /** Cuantas transacciones terminaron bien. */
  readonly roundTrips: number;
  /** `true` si el negocio fijado en una transaccion seguia ahi en otra que no lo fijo. */
  readonly leakedBusiness: boolean;
}

export interface JwksKey {
  readonly kty: string;
  readonly alg: string | null;
  readonly kid: string | null;
}

export interface JwksFacts {
  readonly keys: readonly JwksKey[];
}

export interface PreProbes {
  inspectDatabase(connectionString: string): Promise<DatabaseFacts>;
  exerciseTransactions(connectionString: string): Promise<TransactionFacts>;
  fetchJwks(url: string): Promise<JwksFacts>;
}

export interface PreInputs {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly probes: PreProbes;
  /** Las migraciones que este codigo conoce, en orden. */
  readonly migrations: readonly string[];
  /** Las tablas que las migraciones crean. */
  readonly tables: readonly string[];
}

const APP_ROLE = 'stock_app';
const POOLER_SUFFIX = '.pooler.supabase.com';
const SESSION_POOLER_PORT = '5432';
const MIN_TRANSACTIONS = 20;
const MAX_DETAIL = 240;
const ASYMMETRIC_KEY_TYPES = new Set(['EC', 'RSA', 'OKP']);
const REQUIRED = ['DATABASE_URL', 'AUTH_ISSUER', 'AUTH_JWKS_URL'] as const;
/** Las variables que pueden llevar una clave. */
const KEY_VARIABLES = ['VITE_AUTH_PUBLISHABLE_KEY', 'PRE_AUTH_PUBLISHABLE_KEY'] as const;

function present(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
}

function passwordOf(connectionString: string): string[] {
  try {
    const { password } = new URL(connectionString);
    if (password === '') return [];
    return [password, decodeURIComponent(password)];
  } catch {
    return [];
  }
}

/** La referencia del proyecto de Supabase: no es un secreto, pero tampoco hace falta mostrarla. */
function referencesOf(env: Readonly<Record<string, string | undefined>>): string[] {
  const found: string[] = [];
  try {
    const user = decodeURIComponent(new URL(env['DATABASE_URL'] ?? '').username);
    const dot = user.indexOf('.');
    if (dot > 0) found.push(user.slice(dot + 1));
  } catch {
    // Una cadena que no es una direccion no tiene referencia.
  }
  try {
    const host = new URL(env['AUTH_ISSUER'] ?? '').hostname;
    if (host.endsWith('.supabase.co')) found.push(host.slice(0, host.indexOf('.')));
  } catch {
    // Igual.
  }
  return found;
}

/**
 * Todo lo que no puede aparecer en lo que se imprime: las cadenas de conexion enteras, sus contrasenas, las claves y la
 * referencia del proyecto.
 */
export function secretsOf(env: Readonly<Record<string, string | undefined>>): string[] {
  const secrets = new Set<string>();
  for (const name of ['DATABASE_URL', 'DATABASE_MIGRATION_URL'] as const) {
    const value = env[name];
    if (!present(value)) continue;
    secrets.add(value);
    for (const password of passwordOf(value)) secrets.add(password);
  }
  for (const name of KEY_VARIABLES) {
    const value = env[name];
    if (present(value)) secrets.add(value);
  }
  for (const reference of referencesOf(env)) secrets.add(reference);
  return [...secrets].filter((secret) => secret !== '');
}

/** Cambia cada secreto por `***`. Primero los mas largos, para no dejar un pedazo de uno que contiene a otro. */
export function redact(text: string, secrets: readonly string[]): string {
  return [...secrets]
    .filter((secret) => secret !== '')
    .sort((a, b) => b.length - a.length)
    .reduce((clean, secret) => clean.split(secret).join('***'), text);
}

/** Lo que dice un error sin llevar secretos: su primera linea, sin los secretos y corta. */
function describeError(error: unknown, secrets: readonly string[]): string {
  if (!(error instanceof Error)) return 'error desconocido';
  const first = redact(error.message.split('\n')[0] ?? '', secrets);
  return first.length > MAX_DETAIL ? `${first.slice(0, MAX_DETAIL)}…` : first;
}

const check = (id: string, title: string, status: CheckStatus, detail: string): Check => ({
  id,
  title,
  status,
  detail,
});

function checkEnvironment(env: PreInputs['env']): Check {
  const missing = REQUIRED.filter((name) => !present(env[name]));
  return missing.length === 0
    ? check('env', 'Variables de entorno', 'pass', `Están ${REQUIRED.join(', ')}.`)
    : check(
        'env',
        'Variables de entorno',
        'fail',
        `Faltan ${missing.join(', ')}. PRE todavía no está configurado en esta máquina.`,
      );
}

interface ParsedTarget {
  readonly check: Check;
  readonly ok: boolean;
}

function checkDatabaseTarget(connectionString: string): ParsedTarget {
  const title = 'Dirección de la base';
  let target: ReturnType<typeof describeDatabaseTarget>;
  try {
    target = describeDatabaseTarget(connectionString);
  } catch {
    // No se repite lo recibido: puede llevar una contrasena.
    return {
      ok: false,
      check: check(
        'database-target',
        title,
        'fail',
        'DATABASE_URL no es una dirección de PostgreSQL válida.',
      ),
    };
  }
  const role = target.user.split('.')[0] ?? '';
  const local = isLocalHost(target.host);
  const shown = `${role}@${local ? 'esta máquina' : `*${POOLER_SUFFIX}`}:${target.port}/${target.database}`;
  const fail = (why: string): ParsedTarget => ({
    ok: false,
    check: check('database-target', title, 'fail', `${why} (${shown})`),
  });
  if (role !== APP_ROLE) {
    return fail(
      `Se conecta como «${role}»: la aplicación debe usar su propio rol, ${APP_ROLE}.<referencia del proyecto>`,
    );
  }
  if (!local && !target.host.endsWith(POOLER_SUFFIX)) {
    return fail(`El host no es el pooler de Supabase (*${POOLER_SUFFIX})`);
  }
  if (!local && target.port !== SESSION_POOLER_PORT) {
    return fail(
      `El puerto ${target.port} no es el del pooler de sesión: usa el ${SESSION_POOLER_PORT} (el transaccional no admite sentencias preparadas)`,
    );
  }
  return { ok: true, check: check('database-target', title, 'pass', shown) };
}

function names(list: readonly string[]): string {
  return list.map((name) => `«${name}»`).join(', ');
}

function checkConnection(facts: DatabaseFacts): Check {
  const title = 'Conexión con el rol de la aplicación';
  if (facts.isSuperuser) {
    return check(
      'database-connection',
      title,
      'fail',
      `Conecta como «${facts.currentUser}», que es superusuario: se saltaría la seguridad por fila.`,
    );
  }
  if (facts.currentUser !== APP_ROLE) {
    return check(
      'database-connection',
      title,
      'fail',
      `Conecta como «${facts.currentUser}» y debería ser ${APP_ROLE}.`,
    );
  }
  return check(
    'database-connection',
    title,
    'pass',
    `Conecta como ${APP_ROLE}, sin privilegios de superusuario.`,
  );
}

function checkSchema(facts: DatabaseFacts, inputs: PreInputs): Check {
  const title = 'Esquema y migraciones';
  const missingTables = inputs.tables.filter((table) => !facts.tables.includes(table));
  const applied = facts.migrationsApplied;
  const problems: string[] = [];
  if (missingTables.length > 0) problems.push(`Faltan las tablas ${names(missingTables)}.`);
  if (applied === null) {
    problems.push(
      'No se pudo leer la tabla de migraciones: falta DATABASE_MIGRATION_URL (la aplicación no tiene permiso sobre ella).',
    );
  } else {
    const missingMigrations = inputs.migrations.filter((name) => !applied.includes(name));
    const unknownMigrations = applied.filter((name) => !inputs.migrations.includes(name));
    if (missingMigrations.length > 0) {
      problems.push(`Sin aplicar: ${names(missingMigrations)} (las aplica una persona, ADR 0010).`);
    }
    if (unknownMigrations.length > 0) {
      problems.push(
        `La base tiene migraciones que este código no conoce: ${names(unknownMigrations)}.`,
      );
    }
  }
  return problems.length === 0
    ? check(
        'database-schema',
        title,
        'pass',
        `${String(inputs.tables.length)} tablas y ${String(inputs.migrations.length)} migraciones aplicadas.`,
      )
    : check('database-schema', title, 'fail', problems.join(' '));
}

function checkRowSecurity(facts: DatabaseFacts): Check {
  const title = 'Seguridad por fila';
  const problems: string[] = [];
  if (facts.tablesWithoutRowSecurity.length > 0) {
    problems.push(`Sin seguridad por fila forzada: ${names(facts.tablesWithoutRowSecurity)}.`);
  }
  if (facts.rowsVisibleWithoutBusiness > 0) {
    problems.push(
      `Sin decir de qué negocio pregunta, la aplicación ve ${String(facts.rowsVisibleWithoutBusiness)} filas.`,
    );
  }
  return problems.length === 0
    ? check(
        'row-security',
        title,
        'pass',
        'Todas las tablas del negocio la tienen forzada y sin negocio no se ve nada.',
      )
    : check('row-security', title, 'fail', problems.join(' '));
}

function checkApiRoles(facts: DatabaseFacts): Check {
  const title = 'Roles de la API de Supabase cerrados';
  return facts.apiRolePrivileges.length === 0
    ? check(
        'api-roles-closed',
        title,
        'pass',
        'anon, authenticated y service_role no tienen privilegios sobre las tablas.',
      )
    : check(
        'api-roles-closed',
        title,
        'fail',
        `La API de datos de Supabase podría leer o escribir: ${facts.apiRolePrivileges.join(', ')}. Hay que revocar y apagar la Data API.`,
      );
}

function checkLedger(facts: DatabaseFacts): Check {
  const title = 'Historial solo de añadir';
  return facts.ledgerWritable.length === 0
    ? check(
        'ledger-append-only',
        title,
        'pass',
        'La aplicación no puede cambiar ni borrar el historial.',
      )
    : check(
        'ledger-append-only',
        title,
        'fail',
        `La aplicación puede cambiar el historial: ${facts.ledgerWritable.join(', ')}.`,
      );
}

function checkTransactions(facts: TransactionFacts): Check {
  const title = 'Transacciones a través del pooler';
  if (facts.leakedBusiness) {
    return check(
      'transactions',
      title,
      'fail',
      'El negocio fijado en una transacción se filtró a otra: no se puede usar este pooler.',
    );
  }
  if (facts.roundTrips < MIN_TRANSACTIONS) {
    return check(
      'transactions',
      title,
      'fail',
      `Solo terminaron ${String(facts.roundTrips)} transacciones de las ${String(MIN_TRANSACTIONS)} que se intentaron.`,
    );
  }
  return check(
    'transactions',
    title,
    'pass',
    `${String(facts.roundTrips)} transacciones terminaron bien y el negocio nunca se filtró a otra.`,
  );
}

function parseAddress(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function checkJwksAddress(env: PreInputs['env']): { check: Check; url: string | null } {
  const title = 'Claves de identidad (JWKS)';
  const issuer = parseAddress(env['AUTH_ISSUER'] ?? '');
  const jwks = parseAddress(env['AUTH_JWKS_URL'] ?? '');
  const fail = (why: string) => ({ check: check('jwks', title, 'fail', why), url: null });
  if (issuer === null || jwks === null) {
    return fail('AUTH_ISSUER y AUTH_JWKS_URL tienen que ser direcciones.');
  }
  const local = isLocalHost(jwks.hostname) && isLocalHost(issuer.hostname);
  if (!local && (issuer.protocol !== 'https:' || jwks.protocol !== 'https:')) {
    return fail('Las claves y el emisor tienen que usar https (http solo en esta máquina).');
  }
  if (!jwks.href.startsWith(issuer.href.replace(/\/+$/, '') + '/')) {
    return fail('Las claves no están bajo la dirección del emisor.');
  }
  return { check: check('jwks', title, 'pass', ''), url: jwks.href };
}

function checkJwks(facts: JwksFacts): Check {
  const title = 'Claves de identidad (JWKS)';
  if (facts.keys.length === 0) {
    return check(
      'jwks',
      title,
      'fail',
      'El proyecto no publica claves: todavía firma con un secreto compartido y la API no lo acepta.',
    );
  }
  const symmetric = facts.keys.filter(
    (key) => !ASYMMETRIC_KEY_TYPES.has(key.kty) || (key.alg ?? '').startsWith('HS'),
  );
  if (symmetric.length > 0) {
    return check(
      'jwks',
      title,
      'fail',
      'Hay una clave simétrica: solo se aceptan firmas asimétricas (ES256, RS256, EdDSA).',
    );
  }
  const algorithms = [...new Set(facts.keys.map((key) => key.alg ?? key.kty))].join(', ');
  const count = facts.keys.length;
  return check(
    'jwks',
    title,
    'pass',
    `${String(count)} ${count === 1 ? 'clave asimétrica' : 'claves asimétricas'} (${algorithms}).`,
  );
}

const SKIPPED_NO_ENV = 'No se hizo: falta configurar el entorno.';
const SKIPPED_NO_TARGET = 'No se hizo: la dirección de la base no es la correcta.';
const SKIPPED_NO_DATABASE = 'No se hizo: no hubo conexión con la base.';

/** Corre las comprobaciones en un orden fijo. Ninguna lanza: lo que falla se dice como una comprobacion que falla. */
export async function runPreChecks(inputs: PreInputs): Promise<Check[]> {
  const { env, probes } = inputs;
  const secrets = secretsOf(env);
  const envCheck = checkEnvironment(env);
  const pending = [
    ['database-target', 'Dirección de la base'],
    ['database-connection', 'Conexión con el rol de la aplicación'],
    ['database-schema', 'Esquema y migraciones'],
    ['row-security', 'Seguridad por fila'],
    ['api-roles-closed', 'Roles de la API de Supabase cerrados'],
    ['ledger-append-only', 'Historial solo de añadir'],
    ['transactions', 'Transacciones a través del pooler'],
    ['jwks', 'Claves de identidad (JWKS)'],
  ] as const;
  if (envCheck.status === 'fail') {
    return [envCheck, ...pending.map(([id, title]) => check(id, title, 'skip', SKIPPED_NO_ENV))];
  }

  const databaseUrl = env['DATABASE_URL'] ?? '';
  const target = checkDatabaseTarget(databaseUrl);
  const checks: Check[] = [envCheck, target.check];
  const skip = (id: string, title: string, why: string) =>
    checks.push(check(id, title, 'skip', why));

  if (!target.ok) {
    for (const [id, title] of pending.slice(1, 7)) skip(id, title, SKIPPED_NO_TARGET);
  } else {
    let facts: DatabaseFacts | null = null;
    try {
      facts = await probes.inspectDatabase(databaseUrl);
      checks.push(checkConnection(facts));
    } catch (error) {
      checks.push(
        check(
          'database-connection',
          'Conexión con el rol de la aplicación',
          'fail',
          `No se pudo conectar: ${describeError(error, secrets)}`,
        ),
      );
    }
    if (facts === null) {
      for (const [id, title] of pending.slice(2, 7)) skip(id, title, SKIPPED_NO_DATABASE);
    } else {
      checks.push(
        checkSchema(facts, inputs),
        checkRowSecurity(facts),
        checkApiRoles(facts),
        checkLedger(facts),
      );
      try {
        checks.push(checkTransactions(await probes.exerciseTransactions(databaseUrl)));
      } catch (error) {
        checks.push(
          check(
            'transactions',
            'Transacciones a través del pooler',
            'fail',
            describeError(error, secrets),
          ),
        );
      }
    }
  }

  const address = checkJwksAddress(env);
  if (address.url === null) {
    checks.push(address.check);
  } else {
    try {
      checks.push(checkJwks(await probes.fetchJwks(address.url)));
    } catch (error) {
      checks.push(
        check(
          'jwks',
          'Claves de identidad (JWKS)',
          'fail',
          `No se pudieron pedir: ${describeError(error, secrets)}`,
        ),
      );
    }
  }
  return checks;
}

const LABELS: Readonly<Record<CheckStatus, string>> = {
  pass: '[PASA]    ',
  fail: '[FALLA]   ',
  skip: '[OMITIDA] ',
};

function count(total: number, one: string, many: string): string {
  return `${String(total)} ${total === 1 ? one : many}`;
}

/** El informe que se le muestra a la persona, una linea por comprobacion y un resumen. */
export function formatReport(checks: readonly Check[]): string {
  const total = (status: CheckStatus) =>
    checks.filter((candidate) => candidate.status === status).length;
  const lines = checks.map((item) => `${LABELS[item.status]}${item.title} — ${item.detail}`);
  const summary = `Resultado: ${count(total('pass'), 'pasa', 'pasan')}, ${count(total('fail'), 'falla', 'fallan')}, ${count(total('skip'), 'omitida', 'omitidas')}`;
  return ['Verificación de PRE', '', ...lines, '', summary].join('\n');
}

/** 0 solo si nada fallo. Una comprobacion omitida no es un fallo: el informe ya dice por que se omitio. */
export function exitCodeOf(checks: readonly Check[]): 0 | 1 {
  return checks.some((item) => item.status === 'fail') ? 1 : 0;
}
