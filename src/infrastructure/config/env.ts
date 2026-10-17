/** Configuracion que la aplicacion lee del entorno al arrancar. */
export interface AppConfig {
  readonly port: number;
  /** Origenes (esquema://host[:puerto]) a los que se les permite leer las respuestas desde un navegador. */
  readonly corsOrigins: readonly string[];
  /** La base de datos de la aplicacion; sin ella la API arranca, pero no atiende nada de negocio. */
  readonly database: DatabaseConfig | undefined;
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
