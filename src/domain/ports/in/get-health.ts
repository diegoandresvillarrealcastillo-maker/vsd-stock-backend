import type { HealthReport } from '../../model/health-report.js';

/** Puerto de entrada: consultar si el servicio esta sano. */
export interface GetHealth {
  execute(): HealthReport;
}
