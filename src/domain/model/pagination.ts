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

/**
 * Lee `limit` y `cursor` de los parametros de una URL (siempre texto). Anota los problemas en el lector, junto con los
 * de los demas parametros, en vez de lanzar por su cuenta.
 */
export function readPageRequest(reader: InputReader, arity: number): PageRequest {
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
    if (after === undefined) {
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
