/** El tipo de contenido de todo error de la API (RFC 9457, ADR 0019). */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/** Un campo de la peticion que no sirve: donde esta (puntero JSON), por que (codigo estable) y una explicacion. */
export interface ProblemError {
  pointer: string;
  code: string;
  detail: string;
}

/** El cuerpo de un error. `code` y `traceId` son extensiones de VSD Stock; el resto es el estandar. */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  code: string;
  traceId: string;
  errors?: ProblemError[];
}

export interface ProblemInput {
  status: number;
  /** Un codigo propio del caso (`shift-closed`); si falta se usa el del estado HTTP. */
  code?: string;
  detail?: string;
  /** La ruta que fallo. Se le quita la cadena de consulta: puede llevar datos. */
  instance: string;
  traceId: string;
  errors?: ProblemError[];
}

const KNOWN: Readonly<Record<number, { code: string; title: string }>> = {
  400: { code: 'validation-failed', title: 'La petición no es válida' },
  401: { code: 'unauthenticated', title: 'Hace falta iniciar sesión' },
  403: { code: 'forbidden', title: 'No tienes permiso para hacer esto' },
  404: { code: 'not-found', title: 'No encontrado' },
  405: { code: 'method-not-allowed', title: 'Método no permitido' },
  408: { code: 'request-timeout', title: 'La petición tardó demasiado' },
  409: { code: 'conflict', title: 'Conflicto' },
  410: { code: 'gone', title: 'Ya no está disponible' },
  413: { code: 'payload-too-large', title: 'La petición es demasiado grande' },
  415: { code: 'unsupported-media-type', title: 'Formato no admitido' },
  425: { code: 'too-early', title: 'Demasiado pronto' },
  429: { code: 'rate-limited', title: 'Demasiadas peticiones' },
  500: { code: 'internal-error', title: 'Error inesperado' },
  502: { code: 'service-unavailable', title: 'Servicio no disponible' },
  503: { code: 'service-unavailable', title: 'Servicio no disponible' },
  504: { code: 'service-unavailable', title: 'Servicio no disponible' },
};

const UNEXPECTED_DETAIL =
  'Ocurrió un error inesperado. Indica este identificador de seguimiento al reportarlo.';

/** Un estado que no es un error HTTP (un 200, un 302, un 600) nunca se presenta como exito: es un error interno. */
function errorStatus(status: number): number {
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
}

/** El codigo estable con que un cliente reconoce el error de un estado HTTP. */
export function codeForStatus(status: number): string {
  const valid = errorStatus(status);
  return KNOWN[valid]?.code ?? (valid < 500 ? 'client-error' : 'server-error');
}

function titleForStatus(status: number): string {
  return KNOWN[status]?.title ?? (status < 500 ? 'Error del cliente' : 'Error del servidor');
}

/** Arma el cuerpo de un error. Un error inesperado nunca revela su causa: solo el identificador de seguimiento. */
export function buildProblem(input: ProblemInput): Problem {
  const status = errorStatus(input.status);
  const code = input.code ?? codeForStatus(status);
  const title = titleForStatus(status);
  const unexpected = status >= 500 && input.code === undefined;
  const problem: Problem = {
    type: `urn:vsd-stock:problem:${code}`,
    title,
    status,
    detail: unexpected ? UNEXPECTED_DETAIL : (input.detail ?? title),
    instance: input.instance.split(/[?#]/)[0] ?? '',
    code,
    traceId: input.traceId,
  };
  if (input.errors !== undefined && input.errors.length > 0) {
    problem.errors = input.errors;
  }
  return problem;
}
