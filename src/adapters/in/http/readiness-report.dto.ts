import { ApiProperty } from '@nestjs/swagger';
import type { ReadinessReport } from '../../../domain/model/readiness-report.js';

/**
 * Forma HTTP del informe de «listo para trabajar», tal como aparece en el contrato OpenAPI. Solo existe la
 * respuesta 200: cuando algo falta, la respuesta es un error 503 (`application/problem+json`, ADR 0019).
 */
export class ReadinessReportDto implements ReadinessReport {
  @ApiProperty({
    type: String,
    enum: ['ok'],
    example: 'ok',
    description: 'Siempre «ok» en una respuesta 200: si el servicio no está listo, responde 503.',
  })
  readonly status!: 'ok' | 'unavailable';

  @ApiProperty({
    type: String,
    enum: ['up'],
    example: 'up',
    description: 'La base de datos responde.',
  })
  readonly database!: 'up' | 'down' | 'not-configured';

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-10-17T15:30:00.000Z',
    description: 'Instante en que se comprobó, en ISO 8601 y en UTC.',
  })
  readonly timestamp!: string;
}
