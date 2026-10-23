import type { MonthlyReport } from '../../model/monthly-report.js';
import type { Session } from './authenticate.js';

/** Puerto de entrada: los reportes (C4-R1, ADR 0035). */
export interface Reports {
  /**
   * El reporte de un mes (`month=AAAA-MM`, a hora de Bogota): las ventas por tarifa y tipo tributario, las anuladas aparte y lo
   * cobrado por medio de pago. Es de la gerencia (`report:sales`) y necesita conexion. Lanza `ValidationFailedError` si el mes no
   * viene o no sirve.
   */
  monthly(session: Session, query: unknown): Promise<MonthlyReport>;
}
