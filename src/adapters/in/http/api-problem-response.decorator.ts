import { ApiDefaultResponse, getSchemaPath } from '@nestjs/swagger';
import { PROBLEM_CONTENT_TYPE } from './problem-details.js';
import { ProblemDetailsDto } from './problem-details.dto.js';

/**
 * Declara en el contrato que cualquier otra respuesta de la operacion es un error con la forma de
 * ProblemDetailsDto (ADR 0019). Toda operacion lo lleva: una prueba del contrato lo exige.
 */
export const ApiProblemResponse = () =>
  ApiDefaultResponse({
    description:
      'Cualquier error. El cuerpo es un `application/problem+json` (RFC 9457): el cliente se guía por `code` y por el estado HTTP, no por el texto.',
    content: {
      [PROBLEM_CONTENT_TYPE]: { schema: { $ref: getSchemaPath(ProblemDetailsDto) } },
    },
  });
