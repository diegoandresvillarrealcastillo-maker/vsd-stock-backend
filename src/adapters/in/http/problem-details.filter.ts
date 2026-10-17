import { randomUUID } from 'node:crypto';
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import { buildProblem, PROBLEM_CONTENT_TYPE, type ProblemError } from './problem-details.js';
import { REQUEST_ID_HEADER } from './request-id.js';

interface RequestWithPath {
  originalUrl?: string;
  url?: string;
}

interface ProblemResponse {
  locals?: Record<string, unknown>;
  headersSent?: boolean;
  getHeader(name: string): unknown;
  setHeader(name: string, value: string): unknown;
  status(code: number): ProblemResponse;
  type(contentType: string): ProblemResponse;
  json(body: unknown): unknown;
}

/**
 * Un error de la API con un codigo propio del caso (`shift-closed`), un detalle para quien programa y, si hace
 * falta, los campos invalidos y cuanto esperar para reintentar. El filtro lo convierte en `application/problem+json`.
 */
export class ApiProblem extends HttpException {
  readonly detail: string;

  constructor(
    status: number,
    readonly code: string,
    detail: string,
    readonly extras: { errors?: ProblemError[]; retryAfterSeconds?: number } = {},
  ) {
    super(detail, status);
    this.detail = detail;
  }
}

/** Lo que dijo la excepcion de Nest, como texto. */
function messageOf(exception: HttpException): string {
  const response = exception.getResponse();
  if (typeof response === 'string') return response;
  const message = (response as { message?: unknown }).message;
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) return message.map(String).join('; ');
  return exception.message;
}

/**
 * Convierte TODO error en un `application/problem+json` (RFC 9457, ADR 0019): el mismo cuerpo, el mismo tipo de
 * contenido y un identificador de seguimiento que tambien viaja en `X-Request-Id`. Lo inesperado se registra con
 * su causa en el servidor y se contesta sin ella.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Problem');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<RequestWithPath>();
    const response = http.getResponse<ProblemResponse>();
    if (response.headersSent === true) return;

    const traceId =
      (typeof response.locals?.['requestId'] === 'string'
        ? response.locals['requestId']
        : undefined) ??
      (typeof response.getHeader(REQUEST_ID_HEADER) === 'string'
        ? (response.getHeader(REQUEST_ID_HEADER) as string)
        : undefined) ??
      randomUUID();

    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    if (status >= 500) {
      const reason = exception instanceof Error ? exception.message : String(exception);
      this.logger.error(
        `${traceId} ${reason}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    const own = exception instanceof ApiProblem ? exception : undefined;
    const target = request.originalUrl ?? request.url ?? '';
    // Nest dice «Cannot GET /ruta?telefono=300...»: la cadena de consulta puede llevar datos y no sale de aqui.
    const withoutQuery = (text: string): string =>
      text.split(target).join(target.split(/[?#]/)[0] ?? '');
    const problem = buildProblem({
      status,
      ...(own === undefined ? {} : { code: own.code }),
      ...(exception instanceof HttpException
        ? { detail: withoutQuery(own?.detail ?? messageOf(exception)) }
        : {}),
      instance: target,
      traceId,
      ...(own?.extras.errors === undefined ? {} : { errors: own.extras.errors }),
    });

    if (own?.extras.retryAfterSeconds !== undefined) {
      response.setHeader('Retry-After', String(own.extras.retryAfterSeconds));
    }
    response.status(problem.status).type(PROBLEM_CONTENT_TYPE).json(problem);
  }
}
