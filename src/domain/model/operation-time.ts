/** Un viaje de ida y vuelta mas lento que esto no sirve para medir el reloj: el error pasaria de 2,5 s. */
export const MAX_ROUND_TRIP_MS = 5000;

/** Un reloj que se desvia mas de esto necesita que alguien lo arregle: se avisa. */
export const SKEW_WARNING_MS = 5 * 60 * 1000;

/** Una operacion que espero mas de esto en el dispositivo se acepta, pero se marca. */
export const STALE_AFTER_MS = 72 * 60 * 60 * 1000;

/** Lo que el dispositivo ve al preguntar `GET /health`: cuando pregunto, cuando oyo la respuesta y la hora del servidor. */
export interface ClockMeasurement {
  readonly sentAtMs: number;
  readonly receivedAtMs: number;
  readonly serverTimeMs: number;
}

/** De donde sale la hora que se guarda: el reloj del dispositivo, ese reloj corregido, o el momento en que el servidor se entero. */
export type TimeSource = 'device' | 'corrected' | 'received';

export type TimeFlag = 'clock-skew' | 'clock-unverified' | 'future' | 'stale' | 'unreadable';

export interface OperationTimeInput {
  /** La hora del reloj del dispositivo al hacer la operacion, en ISO 8601 UTC con `Z`. */
  readonly deviceTime: string;
  /** Cuanto adelanta el servidor al reloj del dispositivo en su ultima medicion confiable; `null` si nunca la hubo. */
  readonly clockOffsetMs: number | null;
  /** El momento en que el servidor recibio la operacion. */
  readonly receivedAt: string;
}

export interface ResolvedOperationTime {
  readonly effectiveAt: string;
  readonly source: TimeSource;
  readonly flags: readonly TimeFlag[];
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** Los milisegundos de un instante en ISO 8601 UTC con `Z`, o NaN si no lo es: no se adivinan otros formatos. */
function parseInstant(text: string): number {
  return typeof text === 'string' && ISO_UTC.test(text) ? Date.parse(text) : Number.NaN;
}

/**
 * Cuanto adelanta el reloj del servidor al del dispositivo, medido como se mide en NTP: se supone que el
 * servidor contesto a la mitad del viaje (ADR 0016). Devuelve `null` si la medicion no sirve (un viaje de mas
 * de 5 s, uno que llega antes de salir, o un numero que no es finito), en cuyo caso no se corrige nada.
 */
export function estimateClockOffset(measurement: ClockMeasurement): number | null {
  const { sentAtMs, receivedAtMs, serverTimeMs } = measurement;
  if (![sentAtMs, receivedAtMs, serverTimeMs].every(Number.isFinite)) {
    return null;
  }
  const roundTrip = receivedAtMs - sentAtMs;
  if (roundTrip < 0 || roundTrip > MAX_ROUND_TRIP_MS) {
    return null;
  }
  return Math.round(serverTimeMs - (sentAtMs + roundTrip / 2));
}

/**
 * La hora con que se guarda una operacion hecha sin conexion (ADR 0016). NUNCA la rechaza: una venta que ya
 * ocurrio en el mostrador siempre se acepta; si algo en su hora no cuadra, se marca para que alguien lo mire.
 *
 * La hora del dispositivo se corrige con la diferencia medida contra el servidor; no puede ser posterior al
 * momento en que el servidor se entero; y si no se puede leer, vale ese momento. Lanza RangeError solo si
 * `receivedAt`, que pone el servidor, no es una hora valida.
 */
export function resolveOperationTime(input: OperationTimeInput): ResolvedOperationTime {
  const received = parseInstant(input.receivedAt);
  if (Number.isNaN(received)) {
    throw new RangeError(
      `The time the server received the operation is not valid: ${String(input.receivedAt)}`,
    );
  }
  const device = parseInstant(input.deviceTime);
  if (Number.isNaN(device)) {
    return {
      effectiveAt: new Date(received).toISOString(),
      source: 'received',
      flags: ['unreadable'],
    };
  }

  const flags = new Set<TimeFlag>();
  let effective = device;
  let source: TimeSource;
  const offset = input.clockOffsetMs;
  if (typeof offset === 'number' && Number.isFinite(offset)) {
    effective = device + offset;
    source = 'corrected';
    if (Math.abs(offset) > SKEW_WARNING_MS) flags.add('clock-skew');
  } else {
    source = 'device';
    flags.add('clock-unverified');
  }

  if (effective > received) {
    effective = received;
    source = 'received';
    flags.add('future');
  }
  if (received - effective > STALE_AFTER_MS) flags.add('stale');

  return { effectiveAt: new Date(effective).toISOString(), source, flags: [...flags].sort() };
}
