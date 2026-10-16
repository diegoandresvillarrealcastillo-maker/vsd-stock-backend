import { Controller, Get, Inject } from '@nestjs/common';
import type { HealthReport } from '../../../domain/model/health-report.js';
import type { GetHealth } from '../../../domain/ports/in/get-health.js';
import { GET_HEALTH } from './tokens.js';

/** Adaptador de entrada HTTP: GET /health. */
@Controller('health')
export class HealthController {
  constructor(@Inject(GET_HEALTH) private readonly getHealth: GetHealth) {}

  @Get()
  check(): HealthReport {
    return this.getHealth.execute();
  }
}
