/** Cuantas veces se intenta una transaccion que pierde contra otra, contando la primera. */
const MAX_ATTEMPTS = 3;
/** Cuanto se espera antes del intento n: crece con cada uno, y un poco de azar evita que dos se reintenten a la par. */
const BACKOFF_STEP_MS = 25;
const BACKOFF_JITTER_MS = 25;

/** Los codigos de PostgreSQL de «no se pudo serializar» y «interbloqueo»; Prisma los reune en P2034. */
const CONFLICT_CODES = new Set(['P2034', '40001', '40P01']);
const CONFLICT_TEXT = /could not serialize|deadlock detected/iu;
const MAX_CAUSE_DEPTH = 5;

/**
 * Si el error es una transaccion que perdio contra otra (interbloqueo o fallo de serializacion) y por tanto sirve
 * volver a intentarla (ADR 0013). El adaptador del controlador a veces solo lo dice en el mensaje o un nivel mas abajo.
 */
export function isConflict(error: unknown, depth = 0): boolean {
  if (typeof error !== 'object' || error === null || depth > MAX_CAUSE_DEPTH) return false;
  const { code, message, cause } = error as { code?: unknown; message?: unknown; cause?: unknown };
  if (typeof code === 'string' && CONFLICT_CODES.has(code)) return true;
  if (typeof message === 'string' && CONFLICT_TEXT.test(message)) return true;
  return isConflict(cause, depth + 1);
}

const sleepFor = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Corre `work` y, si pierde contra otra transaccion, lo corre de nuevo (hasta tres veces en total). Sirve porque lo que
 * `work` hizo se deshizo con su transaccion: no queda nada a medias. Cualquier otro error sale a la primera.
 */
export async function retryOnConflict<T>(
  work: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = sleepFor,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (!isConflict(error) || attempt >= MAX_ATTEMPTS) throw error;
      await sleep(attempt * BACKOFF_STEP_MS + Math.floor(Math.random() * BACKOFF_JITTER_MS));
    }
  }
}
