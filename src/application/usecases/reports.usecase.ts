import {
  REPORT_FIELDS,
  buildMonthlyReport,
  readReportMonth,
  type MonthlyReport,
} from '../../domain/model/monthly-report.js';
import { InputReader } from '../../domain/model/validation.js';
import type { Session } from '../../domain/ports/in/authenticate.js';
import type { Reports } from '../../domain/ports/in/reports.js';
import type { UnitOfWork } from '../../domain/ports/out/unit-of-work.js';
import { ensureCan, requireMember } from '../session-guards.js';

/**
 * Caso de uso de los reportes (C4-R1, ADR 0035). Lee las ventas del mes del negocio de la sesion y las suma en el dominio,
 * venta por venta: el reporte dice lo que dijeron los recibos y no vuelve a calcular el IVA con otra cuenta.
 */
export class ReportsUseCase implements Reports {
  constructor(private readonly work: UnitOfWork) {}

  async monthly(session: Session, query: unknown): Promise<MonthlyReport> {
    const actor = requireMember(session);
    // El reporte es de la gerencia y necesita conexion (ADR 0017).
    ensureCan(actor, 'report:sales');
    const reader = new InputReader(query, REPORT_FIELDS);
    const month = readReportMonth(reader);
    reader.finish();

    const { sold, voided } = await this.work.inBusiness(actor.businessId, (scope) =>
      scope.sales.inPeriod(month.from, month.to),
    );
    return buildMonthlyReport(month, sold, voided);
  }
}
