import { isUuid } from './uuid.js';
import { InputReader, ValidationFailedError, type FieldError } from './validation.js';

/** Los campos de un lote de sincronizacion (ADR 0028). */
export const SYNC_FIELDS = ['operations'] as const;

/** Cuantas operaciones caben en un lote: de 1 a 50. El dispositivo manda hasta 20 o 64 KB, lo que llegue primero. */
export const MAX_SYNC_OPERATIONS = 50;

/** Lo unico que se puede hacer sin conexion y por eso llega en un lote (ADR 0017): abrir un turno, cerrarlo y vender. */
export const SYNC_KINDS = ['shift-open', 'shift-close', 'sale'] as const;
export type SyncKind = (typeof SYNC_KINDS)[number];

/** Los campos de una operacion del lote. `shiftId` solo lo lleva cerrar un turno: en la ruta suelta va en el camino. */
const SYNC_ITEM_FIELDS = ['kind', 'shiftId', 'body'] as const;

/**
 * Una operacion de un lote tal como se leyo. Si no sirve, queda como `valid: false` con sus problemas (con el puntero relativo a
 * la operacion) y NO echa a perder a las demas: el lote responde un resultado por cada una (ADR 0028).
 */
export type SyncItem =
  | {
      readonly valid: true;
      readonly kind: SyncKind;
      /** Solo al cerrar un turno; `null` en las demas. */
      readonly shiftId: string | null;
      /** El cuerpo de la ruta individual de esa clase, SIN validar: lo valida el caso de uso de esa clase. */
      readonly body: Readonly<Record<string, unknown>>;
      readonly operationId: string | null;
    }
  | {
      readonly valid: false;
      readonly errors: readonly FieldError[];
      readonly operationId: string | null;
    };

/** El `operationId` del cuerpo, si es un identificador; `null` si no se puede leer (se dice igual en el resultado). */
function operationIdOf(item: unknown): string | null {
  if (typeof item !== 'object' || item === null) return null;
  const body = (item as { body?: unknown }).body;
  if (typeof body !== 'object' || body === null) return null;
  const operationId = (body as { operationId?: unknown }).operationId;
  return typeof operationId === 'string' && isUuid(operationId) ? operationId.toLowerCase() : null;
}

function readItem(item: unknown): SyncItem {
  const operationId = operationIdOf(item);
  try {
    const reader = new InputReader(item, SYNC_ITEM_FIELDS);
    const kind = reader.oneOf('kind', SYNC_KINDS, { label: 'La clase de operación' });

    const body = reader.raw('body');
    if (body === undefined) {
      reader.fail('/body', 'required', 'Falta el cuerpo de la operación.');
    } else if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      reader.fail('/body', 'invalid-type', 'El cuerpo de la operación debe ser un objeto.');
    }

    let shiftId: string | null = null;
    if (kind === 'shift-close') {
      shiftId = reader.uuid('shiftId', { label: 'El identificador del turno' }).toLowerCase();
    } else if (reader.raw('shiftId') !== undefined) {
      reader.fail(
        '/shiftId',
        'unknown-field',
        'Solo cerrar un turno lleva el identificador del turno.',
      );
    }

    reader.finish();
    return {
      valid: true,
      kind,
      shiftId,
      body: body as Readonly<Record<string, unknown>>,
      operationId,
    };
  } catch (error) {
    if (error instanceof ValidationFailedError) {
      return { valid: false, errors: error.errors, operationId };
    }
    throw error;
  }
}

/**
 * Lee el lote: una lista de 1 a 50 operaciones, en el orden en que llegaron. Los problemas de la lista (falta, no es una lista,
 * muy corta o muy larga) quedan en el lector y echan abajo la peticion; los de cada operacion se quedan en su operacion.
 */
export function readSyncBatch(reader: InputReader): readonly SyncItem[] {
  const items = reader.items('operations', {
    label: 'El lote de operaciones',
    min: 1,
    max: MAX_SYNC_OPERATIONS,
  });
  return items.map(readItem);
}

/** Los parametros de la descarga de la copia de lectura, ademas de `limit` y `cursor`. */
export const COPY_FIELDS = ['since', 'limit', 'cursor'] as const;

const MOMENT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/u;

/**
 * Lee `since`: desde cuando bajar lo que cambio, un instante ISO 8601 UTC con `Z` (con o sin milisegundos). Sin el, baja todo.
 * Un instante que no existe (el 30 de febrero) no pasa.
 */
export function readCopySince(reader: InputReader): Date | undefined {
  const raw = reader.raw('since');
  if (raw === undefined) return undefined;
  const invalid = () => {
    reader.fail(
      '/since',
      'invalid-moment',
      'since debe ser un instante en ISO 8601 UTC, como 2026-10-18T15:00:00.000Z.',
    );
    return undefined;
  };
  if (typeof raw !== 'string' || !MOMENT.test(raw)) return invalid();
  const normal = raw.includes('.') ? raw : raw.replace('Z', '.000Z');
  const date = new Date(normal);
  // Una fecha que JavaScript corrige (30 de febrero -> 2 de marzo) no escribe lo mismo al volver.
  if (Number.isNaN(date.getTime()) || date.toISOString() !== normal) return invalid();
  return date;
}
