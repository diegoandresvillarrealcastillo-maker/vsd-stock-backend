import { randomUUID } from 'node:crypto';

export const REQUEST_ID_HEADER = 'X-Request-Id';

/** Lo minimo que se usa de la peticion y la respuesta de Express: asi no hace falta depender de sus tipos. */
export interface RequestLike {
  header(name: string): string | undefined;
}

export interface ResponseLike {
  locals: Record<string, unknown>;
  setHeader(name: string, value: string): unknown;
}

/** De 8 a 64 caracteres seguros. Lo que no encaje se reemplaza: el identificador acaba en los registros. */
const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** Conserva el identificador que mando quien llama, si es seguro, y si no genera un UUID. */
export function resolveRequestId(received: string | undefined): string {
  return received !== undefined && VALID_REQUEST_ID.test(received) ? received : randomUUID();
}

/**
 * Pone a cada peticion un identificador (ADR 0019), lo devuelve en `X-Request-Id` y lo deja en
 * `res.locals.requestId` para el resto del recorrido: el mismo numero une el dispositivo, la respuesta y el
 * registro del servidor.
 */
export function requestIdMiddleware(req: RequestLike, res: ResponseLike, next: () => void): void {
  const id = resolveRequestId(req.header(REQUEST_ID_HEADER));
  res.setHeader(REQUEST_ID_HEADER, id);
  res.locals['requestId'] = id;
  next();
}
