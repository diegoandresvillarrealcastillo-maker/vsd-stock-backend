import { createHealthReport, type HealthReport } from '../../domain/model/health-report.js';
import type { GetHealth } from '../../domain/ports/in/get-health.js';
import type { Clock } from '../../domain/ports/out/clock.js';

/** Caso de uso: informa que el servicio esta sano y a que hora lo comprobo. */
export class GetHealthUseCase implements GetHealth {
  constructor(private readonly clock: Clock) {}

  execute(): HealthReport {
    return createHealthReport(this.clock.now());
  }
}
