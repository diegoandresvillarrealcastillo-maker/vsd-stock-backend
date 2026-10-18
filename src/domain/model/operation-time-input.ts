import { resolveOperationTime, type TimeFlag, type TimeSource } from './operation-time.js';
import type { InputReader } from './validation.js';

/** Los campos que toda operacion hecha en un dispositivo lleva para decir cuando ocurrio (ADR 0016). */
export const OPERATION_TIME_FIELDS = ['deviceTime', 'clockOffsetMs'] as const;

/** Un instante en ISO 8601 mide menos de 30 caracteres; mas de 40 no es un reloj. */
const MAX_DEVICE_TIME_LENGTH = 40;
/** Un reloj que se desvia mas de un ano no es un reloj descompuesto: es otro dato. */
const MAX_OFFSET_MS = 366 * 24 * 60 * 60 * 1000;

/** Lo que el dispositivo dice de la hora de la operacion. */
export interface OperationTimeInput {
  /** La hora de su reloj. No se valida aqui: una que no se puede leer se acepta y se marca (ADR 0016). */
  readonly deviceTime: string;
  /** Cuanto adelanta el servidor a su reloj en la ultima medicion confiable; `null` si nunca la hubo. */
  readonly clockOffsetMs: number | null;
}

/** Lo que se guarda de la hora de una operacion (la tabla `operation`). */
export interface ResolvedOperationTimes {
  readonly occurredAt: Date;
  readonly receivedAt: Date;
  /** Lo que el dispositivo dijo, tal cual, por si hay que revisar lo que el servidor decidio. */
  readonly deviceTimeRaw: string;
  readonly source: TimeSource;
  readonly flags: readonly TimeFlag[];
}

/** Lee la hora de una operacion. Los problemas quedan en el lector; el llamador llama a `finish()` antes de usar el resultado. */
export function readOperationTime(reader: InputReader): OperationTimeInput {
  const deviceTime = reader.text('deviceTime', {
    label: 'La hora del dispositivo',
    max: MAX_DEVICE_TIME_LENGTH,
  });
  const absent = reader.raw('clockOffsetMs') === undefined || reader.isNull('clockOffsetMs');
  const clockOffsetMs = absent
    ? null
    : reader.integer('clockOffsetMs', {
        label: 'La diferencia del reloj',
        min: -MAX_OFFSET_MS,
        max: MAX_OFFSET_MS,
      });
  return { deviceTime, clockOffsetMs };
}

/**
 * Decide con que hora se guarda una operacion que llego `receivedAt` (ADR 0016). Nunca la rechaza: lo que no cuadra se
 * marca con una bandera para que alguien lo mire.
 */
export function resolveReceivedOperation(
  time: OperationTimeInput,
  receivedAt: Date,
): ResolvedOperationTimes {
  const resolved = resolveOperationTime({
    deviceTime: time.deviceTime,
    clockOffsetMs: time.clockOffsetMs,
    receivedAt: receivedAt.toISOString(),
  });
  return {
    occurredAt: new Date(resolved.effectiveAt),
    receivedAt,
    deviceTimeRaw: time.deviceTime,
    source: resolved.source,
    flags: resolved.flags,
  };
}
