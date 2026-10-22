import { HttpException } from '@nestjs/common';
import type { ProblemError } from './problem-details.js';

/**
 * Un error de la API con un codigo propio del caso (`shift-closed`), un detalle para quien programa y, si hace
 * falta, los campos invalidos, cuanto esperar para reintentar y cabeceras de la respuesta. El filtro lo convierte en
 * `application/problem+json`.
 */
export class ApiProblem extends HttpException {
  readonly detail: string;

  constructor(
    status: number,
    readonly code: string,
    detail: string,
    readonly extras: {
      errors?: ProblemError[];
      retryAfterSeconds?: number;
      /** Cabeceras que viajan con el error, por ejemplo `WWW-Authenticate` en un 401. */
      headers?: Record<string, string>;
    } = {},
  ) {
    super(detail, status);
    this.detail = detail;
  }
}
