/** Configuracion que la aplicacion lee del entorno al arrancar. */
export interface AppConfig {
  readonly port: number;
  /** Origenes (esquema://host[:puerto]) a los que se les permite leer las respuestas desde un navegador. */
  readonly corsOrigins: readonly string[];
  /** La base de datos de la aplicacion; sin ella la API arranca, pero no atiende nada de negocio. */
  readonly database: DatabaseConfig | undefined;
  /** El servicio de identidad; sin el la API arranca, pero ninguna peticion de una persona se puede atender. */
  readonly auth: AuthConfig | undefined;
}

export interface AuthConfig {
  /** Quien firma los tokens (`iss`): `https://REF.supabase.co/auth/v1`. Se compara tal cual, sin normalizar. */
  readonly issuer: string;
  /** Donde el servicio de identidad publica sus claves PUBLICAS. */
  readonly jwksUrl: string;
  /** Para quien son los tokens (`aud`). */
  readonly audience: string;
}

export interface DatabaseConfig {
  /** La cadena de conexion completa: lleva la contrasena, asi que nunca se imprime. */
  readonly url: string;
  /** A donde apunta, sin la contrasena: `usuario@host:puerto/base`. Es lo unico que se registra. */
  readonly target: string;
}

const DEFAULT_PORT = 3000;
const MAX_PORT = 65535;

/**
 * Lee y valida el entorno. Si algo esta mal, falla al arrancar con un mensaje
 * que nombra la variable: es mejor caer de inmediato que arrancar con un
 * valor que nadie penso.
 */
export function readConfig(env: Readonly<Record<string, string | undefined>>): AppConfig {
  return {
    port: readPort(env['PORT']),
    corsOrigins: readCorsOrigins(env['CORS_ORIGINS']),
    database: readDatabase(env['DATABASE_URL']),
    auth: readAuth(env),
  };
}

function readPort(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_PORT;
  }

  const port = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    throw new Error(
      `PORT debe ser un entero entre 1 y ${MAX_PORT} (recibido: ${JSON.stringify(raw)})`,
    );
  }
  return port;
}

/**
 * Sin la variable no se permite ningun origen: el valor por omision es el mas
 * cerrado. No se admite el comodin; cada origen se escribe tal como lo envia
 * el navegador, porque la comparacion es exacta.
 */
function readCorsOrigins(raw: string | undefined): readonly string[] {
  if (raw === undefined) {
    return [];
  }

  const origins = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  for (const origin of origins) {
    if (origin === '*') {
      throw new Error(
        'CORS_ORIGINS no admite el comodin "*": lista cada origen permitido, por ejemplo https://stock.example.com',
      );
    }
    if (!isOrigin(origin)) {
      throw new Error(
        `CORS_ORIGINS debe listar origenes con la forma esquema://host[:puerto], en minusculas, ` +
          `sin ruta ni barra final (recibido: ${JSON.stringify(origin)})`,
      );
    }
  }
  return origins;
}

/** Un origen es exactamente lo que el navegador envia en la cabecera Origin. */
function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value;
  } catch {
    return false;
  }
}

/**
 * La conexion de la aplicacion (rol `stock_app`, ADR 0005). Opcional: sin ella la API arranca y /health responde,
 * que es lo que necesita el contenedor para comprobarse. El mensaje de error nunca repite el valor: lleva la clave.
 */
function readDatabase(raw: string | undefined): DatabaseConfig | undefined {
  if (raw === undefined || raw === '') {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      'DATABASE_URL debe ser una cadena de conexion postgresql://usuario:clave@host:puerto/base',
    );
  }
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new Error(
      'DATABASE_URL debe empezar por postgresql:// (se oculta el valor recibido: lleva la clave)',
    );
  }
  const port = url.port === '' ? '5432' : url.port;
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  return {
    url: raw,
    target: `${decodeURIComponent(url.username)}@${url.hostname}:${port}/${database}`,
  };
}

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);

function readUrl(name: string, raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `${name} debe ser una direccion https://... (recibido: ${JSON.stringify(raw)})`,
    );
  }
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL.has(url.hostname));
  if (!secure) {
    // Las claves publicas que llegan por http desde otra maquina las puede cambiar cualquiera en el camino.
    throw new Error(
      `${name} debe ser https (o http solo para esta maquina) (recibido: ${JSON.stringify(raw)})`,
    );
  }
  return url;
}

/**
 * El servicio de identidad (ADR 0022): se configura entero o no se configura. Una configuracion a medias detiene el
 * arranque nombrando lo que falta, porque la API arrancaria creyendo que verifica tokens y rechazaria a todos.
 */
function readAuth(env: Readonly<Record<string, string | undefined>>): AuthConfig | undefined {
  const issuer = env['AUTH_ISSUER'] ?? '';
  const jwksUrl = env['AUTH_JWKS_URL'] ?? '';
  const audience = env['AUTH_AUDIENCE'];
  if (issuer === '' && jwksUrl === '' && (audience === undefined || audience === '')) {
    return undefined;
  }
  if (issuer === '')
    throw new Error('AUTH_ISSUER falta: el servicio de identidad se configura entero');
  if (jwksUrl === '')
    throw new Error('AUTH_JWKS_URL falta: el servicio de identidad se configura entero');
  const issuerUrl = readUrl('AUTH_ISSUER', issuer);
  if (issuerUrl.search !== '' || issuerUrl.hash !== '') {
    throw new Error(
      `AUTH_ISSUER no lleva consulta ni fragmento (recibido: ${JSON.stringify(issuer)})`,
    );
  }
  readUrl('AUTH_JWKS_URL', jwksUrl);
  if (audience !== undefined && audience.trim() === '') {
    throw new Error(
      'AUTH_AUDIENCE no puede estar en blanco: sin ella se aceptaria un token para cualquier destinatario',
    );
  }
  return { issuer, jwksUrl, audience: audience ?? 'authenticated' };
}
