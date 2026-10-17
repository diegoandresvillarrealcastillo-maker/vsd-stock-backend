/** Configuracion que la aplicacion lee del entorno al arrancar. */
export interface AppConfig {
  readonly port: number;
  /** Origenes (esquema://host[:puerto]) a los que se les permite leer las respuestas desde un navegador. */
  readonly corsOrigins: readonly string[];
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
