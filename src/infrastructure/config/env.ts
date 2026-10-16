/** Configuracion que la aplicacion lee del entorno al arrancar. */
export interface AppConfig {
  readonly port: number;
}

const DEFAULT_PORT = 3000;
const MAX_PORT = 65535;

/**
 * Lee y valida el entorno. Si algo esta mal, falla al arrancar con un mensaje
 * que nombra la variable: es mejor caer de inmediato que arrancar con un
 * valor que nadie penso.
 */
export function readConfig(env: Readonly<Record<string, string | undefined>>): AppConfig {
  const raw = env['PORT'];
  if (raw === undefined) {
    return { port: DEFAULT_PORT };
  }

  const port = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    throw new Error(
      `PORT debe ser un entero entre 1 y ${MAX_PORT} (recibido: ${JSON.stringify(raw)})`,
    );
  }
  return { port };
}
