import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { HealthReport } from '../../../domain/model/health-report.js';
import type { GetHealth } from '../../../domain/ports/in/get-health.js';
import { ApiProblemResponse } from './api-problem-response.decorator.js';
import { HealthReportDto } from './health-report.dto.js';
import { GET_HEALTH } from './tokens.js';

/** Adaptador de entrada HTTP: GET /health. */
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(@Inject(GET_HEALTH) private readonly getHealth: GetHealth) {}

  @Get()
  @ApiProblemResponse()
  @ApiOperation({
    summary: 'Comprueba que el servicio está en pie',
    description:
      'No requiere sesión y no toca la base de datos. El cliente lo usa para confirmar que hay conexión de verdad: navigator.onLine solo es una pista.',
  })
  @ApiOkResponse({ type: HealthReportDto, description: 'El servicio responde.' })
  check(): HealthReport {
    return this.getHealth.execute();
  }
}
