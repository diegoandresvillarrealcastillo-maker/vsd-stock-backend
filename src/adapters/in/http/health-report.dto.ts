import { ApiProperty } from '@nestjs/swagger';
import type { HealthReport } from '../../../domain/model/health-report.js';

/**
 * Forma HTTP del informe de salud, tal como aparece en el contrato OpenAPI.
 * Es un DTO del adaptador: el dominio solo conoce la interfaz HealthReport y
 * nunca los decoradores de Swagger.
 */
export class HealthReportDto implements HealthReport {
  @ApiProperty({
    type: String,
    enum: ['ok'],
    example: 'ok',
    description: 'Estado del servicio. Hoy solo existe «ok»: si no responde, está caído.',
  })
  readonly status!: 'ok';

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-10-16T15:30:00.000Z',
    description: 'Instante en que se comprobó el servicio, en ISO 8601 y en UTC.',
  })
  readonly timestamp!: string;
}
