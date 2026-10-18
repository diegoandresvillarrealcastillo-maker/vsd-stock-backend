import { isUuid } from './uuid.js';
import type { InputReader } from './validation.js';

/** ADR 0019: de 1 a 200 por pagina y 50 si no se dice. */
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/** Un cursor es una posicion corta; uno largo no lo hizo este servidor. */
const MAX_CURSOR_LENGTH = 1024;

const LIMIT_TEXT = /^\d{1,9}$/;

/** Una pagina: sus elementos y, si hay mas, la posicion donde sigue. */
export interface Page<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
}

export interface PageRequest {
  readonly limit: number;
  /** La posicion tras la que sigue esta pagina; `undefined` para la primera. */
  readonly after: string[] | undefined;
}

/**
 * Un cursor opaco: la posicion (los valores por los que se ordena la lista) en texto seguro para una URL. El cliente
 * lo devuelve tal cual y no debe interpretarlo; cada lista decide que valores lleva.
 */
export function encodeCursor(parts: readonly string[]): string {
  return Buffer.from(JSON.stringify(parts), 'utf8').toString('base64url');
}

/** Las `arity` partes que un cursor lleva, o `undefined` si no es uno que este servidor haya hecho. */
export function decodeCursor(cursor: string, arity: number): string[] | undefined {
  if (cursor === '' || cursor.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/u.test(cursor))
    return undefined;
  let parts: unknown;
  try {
    parts = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (!Array.isArray(parts) || parts.length !== arity) return undefined;
  if (!parts.every((part): part is string => typeof part === 'string')) return undefined;
  return parts;
}

/** Si la posicion de un cursor termina en un UUID: la ultima parte de toda lista es el id de la fila, y la base lo compara. */
export function endsInUuid(position: readonly string[]): boolean {
  return isUuid(position[position.length - 1]);
}

const ISO_MOMENT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

/**
 * Si la posicion es (un instante como lo escribe `toISOString()`, un id): la de las listas que van de lo mas nuevo a lo
 * mas viejo. Un instante que no existe (el 30 de febrero) no pasa: la base no sabria compararlo.
 */
export function timeThenUuid(position: readonly string[]): boolean {
  if (position.length !== 2) return false;
  const [moment, id] = position as [string, string];
  if (!ISO_MOMENT.test(moment) || !isUuid(id)) return false;
  const parsed = new Date(moment);
  // Fecha invalida es NaN; una que JavaScript corrige (30 de febrero -> 2 de marzo) no escribe lo mismo al volver.
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === moment;
}

/**
 * Lee `limit` y `cursor` de los parametros de una URL (siempre texto). Anota los problemas en el lector, junto con los
 * de los demas parametros, en vez de lanzar por su cuenta. `fits` deja a cada lista rechazar una posicion que la base
 * no podria comparar (un id que no es UUID): un cursor que este servidor no hizo es un 400, no un error de la base.
 */
export function readPageRequest(
  reader: InputReader,
  arity: number,
  fits: (position: readonly string[]) => boolean = () => true,
): PageRequest {
  let limit = DEFAULT_PAGE_SIZE;
  const rawLimit = reader.raw('limit');
  if (rawLimit !== undefined) {
    if (typeof rawLimit !== 'string' || !LIMIT_TEXT.test(rawLimit)) {
      reader.fail('/limit', 'invalid-type', 'El límite debe ser un número entero.');
    } else {
      const value = Number(rawLimit);
      if (value < 1 || value > MAX_PAGE_SIZE) {
        reader.fail('/limit', 'out-of-range', `El límite debe estar entre 1 y ${MAX_PAGE_SIZE}.`);
      } else {
        limit = value;
      }
    }
  }

  let after: string[] | undefined;
  const rawCursor = reader.raw('cursor');
  if (rawCursor !== undefined) {
    after = typeof rawCursor === 'string' ? decodeCursor(rawCursor, arity) : undefined;
    if (after === undefined || !fits(after)) {
      after = undefined;
      // No se dice que tenia mal: un cursor propio es opaco y uno ajeno no es asunto del cliente.
      reader.fail(
        '/cursor',
        'invalid-cursor',
        'El cursor no es válido. Pide la lista desde el principio.',
      );
    }
  }
  return { limit, after };
}

/**
 * Corta una pagina de las filas leidas. Se leen `limit + 1` filas: si llega la de mas, hay otra pagina y el cursor
 * apunta tras la ultima fila que SI se entrega.
 */
export function pageOf<T>(
  rows: readonly T[],
  limit: number,
  cursorOf: (row: T) => readonly string[],
): Page<T> {
  if (rows.length <= limit) return { items: [...rows], nextCursor: null };
  const items = rows.slice(0, limit);
  const last = items[items.length - 1] as T;
  return { items, nextCursor: encodeCursor(cursorOf(last)) };
}
