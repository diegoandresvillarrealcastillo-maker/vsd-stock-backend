import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { Problem, ProblemError } from './problem-details.js';

/** Un campo invalido, tal como aparece en el contrato OpenAPI. */
export class ProblemErrorDto implements ProblemError {
  @ApiProperty({
    type: String,
    example: '/lines/0/quantityMilli',
    description: 'Puntero JSON (RFC 6901) al campo de la peticion que no sirve.',
  })
  readonly pointer!: string;

  @ApiProperty({
    type: String,
    example: 'out-of-range',
    description:
      'Código estable del problema de ese campo, para que el cliente decida qué mostrar.',
  })
  readonly code!: string;

  @ApiProperty({
    type: String,
    description: 'Explicación para quien programa. No es un texto para la persona usuaria.',
  })
  readonly detail!: string;
}

/**
 * La forma HTTP de todo error de la API (RFC 9457, ADR 0019), tal como aparece en el contrato OpenAPI. El
 * dominio no la conoce: es un DTO del adaptador, como HealthReportDto.
 */
export class ProblemDetailsDto implements Problem {
  @ApiProperty({
    type: String,
    example: 'urn:vsd-stock:problem:not-found',
    description:
      'Identifica el tipo de error. Siempre `urn:vsd-stock:problem:` seguido del `code`.',
  })
  readonly type!: string;

  @ApiProperty({
    type: String,
    example: 'No encontrado',
    description: 'Resumen corto del tipo de error.',
  })
  readonly title!: string;

  @ApiProperty({ type: 'integer', example: 404, description: 'El estado HTTP de la respuesta.' })
  readonly status!: number;

  @ApiProperty({
    type: String,
    description:
      'Explicación de esta ocurrencia, para quien programa. Un error inesperado no revela su causa: solo trae el `traceId`.',
  })
  readonly detail!: string;

  @ApiProperty({
    type: String,
    example: '/v1/products/3f0c9d58-8f6e-4f0a-9f0e-0d1d2a6b7c11',
    description: 'La ruta que falló, sin cadena de consulta (puede llevar datos).',
  })
  readonly instance!: string;

  @ApiProperty({
    type: String,
    example: 'not-found',
    description:
      'Código estable con que el cliente reconoce el error. Es lo único en lo que debe apoyarse para decidir qué hacer; `title` y `detail` pueden cambiar.',
  })
  readonly code!: string;

  @ApiProperty({
    type: String,
    example: '3f0c9d58-8f6e-4f0a-9f0e-0d1d2a6b7c11',
    description:
      'Identificador de seguimiento. Es el `X-Request-Id` de la petición, que el cliente puede haber enviado, y aparece en el registro del servidor.',
  })
  readonly traceId!: string;

  @ApiPropertyOptional({
    type: [ProblemErrorDto],
    description: 'Los campos inválidos, cuando el error es de validación.',
  })
  readonly errors?: ProblemErrorDto[];
}
