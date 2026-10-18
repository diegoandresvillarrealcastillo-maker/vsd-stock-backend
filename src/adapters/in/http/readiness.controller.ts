import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { ReadinessReport } from '../../../domain/model/readiness-report.js';
import type { GetReadiness } from '../../../domain/ports/in/get-readiness.js';
import { ApiProblemResponse } from './api-problem-response.decorator.js';
import { ApiProblem } from './problem-details.filter.js';
import { ReadinessReportDto } from './readiness-report.dto.js';
import { GET_READINESS } from './tokens.js';

/**
 * Adaptador de entrada HTTP: GET /v1/ready. Aparte de GET /health (el proceso esta en pie, sin tocar la base, y por
 * eso sin version: es lo que usa el contenedor y el cliente para saber si hay conexion), este si comprueba lo que
 * el servicio necesita para atender peticiones de negocio.
 */
@ApiTags('health')
@Controller('v1/ready')
export class ReadinessController {
  constructor(@Inject(GET_READINESS) private readonly getReadiness: GetReadiness) {}

  @Get()
  @ApiProblemResponse()
  @ApiOperation({
    summary: 'Comprueba que el servicio puede atender peticiones de negocio',
    description:
      'No requiere sesión. Comprueba lo que el servicio necesita para trabajar: hoy, la base de datos. Responde 503 con `database-unavailable` si la base no responde y con `database-not-configured` si nunca se configuró.',
  })
  @ApiOkResponse({ type: ReadinessReportDto, description: 'El servicio está listo.' })
  async ready(): Promise<ReadinessReport> {
    const report = await this.getReadiness.execute();
    if (report.status === 'ok') return report;
    throw report.database === 'not-configured'
      ? new ApiProblem(503, 'database-not-configured', 'La base de datos no está configurada.')
      : new ApiProblem(503, 'database-unavailable', 'La base de datos no responde.');
  }
}
