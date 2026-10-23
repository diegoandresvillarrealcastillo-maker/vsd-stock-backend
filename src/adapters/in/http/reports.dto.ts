import { ApiProperty } from '@nestjs/swagger';
import type {
  MonthlyReport,
  ReportRow,
  ReportSection,
} from '../../../domain/model/monthly-report.js';
import { PAYMENT_METHODS, type PaymentMethod } from '../../../domain/model/sale-input.js';
import { TAX_KINDS, type TaxKind } from '../../../domain/model/tax.js';

export class ReportRowDto implements ReportRow {
  @ApiProperty({
    type: String,
    enum: [...TAX_KINDS],
    description:
      'El tipo tributario del renglón (ADR 0034). Los renglones son siempre cuatro y van en este orden: `taxed` al 19 %, `taxed` al 5 %, `exempt` y `excluded`.',
  })
  readonly taxKind!: TaxKind;

  @ApiProperty({
    type: 'integer',
    enum: [0, 500, 1900],
    description: 'La tarifa, en puntos básicos.',
  })
  readonly rateBp!: number;

  @ApiProperty({ type: 'integer', description: 'Lo vendido en este renglón, con el IVA incluido.' })
  readonly total!: number;

  @ApiProperty({ type: 'integer', description: 'La base gravable.' })
  readonly base!: number;

  @ApiProperty({ type: 'integer', description: 'El IVA: el total menos la base.' })
  readonly tax!: number;
}

export class ReportPaymentDto {
  @ApiProperty({ type: String, enum: [...PAYMENT_METHODS] })
  readonly method!: PaymentMethod;

  @ApiProperty({ type: 'integer', description: 'Pesos cobrados con este medio, sin el vuelto.' })
  readonly amount!: number;
}

export class ReportSectionDto implements ReportSection {
  @ApiProperty({ type: 'integer', description: 'Cuántas ventas entran.' })
  readonly count!: number;

  @ApiProperty({ type: 'integer', description: 'Con el IVA incluido: la suma de los renglones.' })
  readonly total!: number;

  @ApiProperty({ type: 'integer' })
  readonly base!: number;

  @ApiProperty({ type: 'integer' })
  readonly tax!: number;

  @ApiProperty({ type: [ReportRowDto] })
  readonly rows!: ReportRowDto[];

  @ApiProperty({
    type: [ReportPaymentDto],
    description: 'Siempre los tres medios (`cash`, `card` y `transfer`), en ese orden.',
  })
  readonly payments!: ReportPaymentDto[];
}

export class MonthlyReportDto implements MonthlyReport {
  @ApiProperty({ type: String, example: '2026-10' })
  readonly month!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'La medianoche de Bogotá con que empieza el mes (incluida).',
  })
  readonly from!: Date;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'La medianoche de Bogotá con que empieza el mes siguiente (excluida).',
  })
  readonly to!: Date;

  @ApiProperty({
    type: ReportSectionDto,
    description: 'Las ventas hechas en el mes (por su hora efectiva), aunque después se anularan.',
  })
  readonly sales!: ReportSectionDto;

  @ApiProperty({
    type: ReportSectionDto,
    description:
      'Las ventas anuladas en el mes, con los montos de la venta que se anuló, sea cual sea el mes de la venta. Van aparte: no se restan de `sales` (ADR 0032 y 0035).',
  })
  readonly voids!: ReportSectionDto;
}
