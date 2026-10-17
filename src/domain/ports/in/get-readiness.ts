import type { ReadinessReport } from '../../model/readiness-report.js';

/** Puerto de entrada: consultar si el servicio puede atender peticiones de negocio. */
export interface GetReadiness {
  execute(): Promise<ReadinessReport>;
}
