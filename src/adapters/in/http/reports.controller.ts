import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { MonthlyReport } from '../../../domain/model/monthly-report.js';
import type { Session } from '../../../domain/ports/in/authenticate.js';
import type { Reports } from '../../../domain/ports/in/reports.js';
import { ApiProblemResponse } from './api-problem-response.decorator.js';
import { BearerAuthGuard, CurrentSession } from './bearer-auth.guard.js';
import { MonthlyReportDto } from './reports.dto.js';
import { REPORTS } from './tokens.js';

/** Adaptador de entrada HTTP: los reportes (C4-R1, ADR 0035). */
@ApiTags('reports')
@ApiBearerAuth()
@Controller('v1/reports')
@UseGuards(BearerAuthGuard)
export class ReportsController {
  constructor(@Inject(REPORTS) private readonly reports: Reports) {}

  @Get('monthly')
  @ApiProblemResponse()
  @ApiOperation({
    summary: 'El reporte mensual',
    description:
      'Lo que el contador pidió (ADR 0032): las ventas del mes por tarifa y tipo tributario (gravado al 19 %, gravado al 5 %, exento y excluido, siempre los cuatro renglones), las ventas anuladas en el mes en renglón aparte —no se restan— y lo cobrado por medio de pago. El IVA se saca venta por venta, como en cada recibo (ADR 0014), y no del total del mes. Una venta es del mes en que ocurrió (su hora efectiva, ADR 0016); una anulación es del mes en que se hizo. Los meses empiezan y terminan a medianoche de Bogotá. Es de la gerencia (`report:sales`) y necesita conexión: un cajero recibe 403. No es la declaración de impuestos ni reemplaza la factura electrónica.',
  })
  @ApiQuery({
    name: 'month',
    required: true,
    schema: { type: 'string', pattern: '^2[0-9]{3}-(0[1-9]|1[0-2])$', example: '2026-10' },
    description: 'El mes, año-mes (`AAAA-MM`).',
  })
  @ApiOkResponse({ type: MonthlyReportDto })
  monthly(@CurrentSession() session: Session, @Query() query: unknown): Promise<MonthlyReport> {
    return this.reports.monthly(session, query);
  }
}
