import { Money } from './money.js';
import { PAYMENT_METHODS, type PaymentMethod } from './sale-input.js';
import { lineTotal } from './sale-totals.js';
import { splitTaxIncluded, type TaxKind } from './tax.js';
import type { InputReader } from './validation.js';

/** Lo que se pide del reporte mensual. */
export const REPORT_FIELDS = ['month'] as const;

/** Bogota esta en UTC−5 todo el ano y no cambia de hora (ADR 0035): su medianoche son las 05:00 UTC. */
const BOGOTA_MIDNIGHT_UTC_HOUR = 5;
const MONTH_SHAPE = /^(2\d{3})-(0[1-9]|1[0-2])$/;
const MAX_MONTH_TEXT = 20;

/** Un mes del calendario de Bogota: de su primera medianoche (incluida) a la del mes siguiente (excluida). */
export interface ReportMonth {
  /** `AAAA-MM`, como se pidio. */
  readonly key: string;
  readonly from: Date;
  readonly to: Date;
}

/** Lanza `RangeError` si el texto no es un mes `AAAA-MM` de este siglo. */
export function parseReportMonth(text: string): ReportMonth {
  const match = MONTH_SHAPE.exec(text);
  if (match === null) throw new RangeError(`A month is written AAAA-MM, like 2026-10: ${text}`);
  const [, year = '', month = ''] = match;
  const y = Number(year);
  const m = Number(month);
  return {
    key: text,
    from: new Date(Date.UTC(y, m - 1, 1, BOGOTA_MIDNIGHT_UTC_HOUR)),
    // `Date.UTC` pasa de diciembre (mes 12) a enero del ano siguiente por si solo.
    to: new Date(Date.UTC(y, m, 1, BOGOTA_MIDNIGHT_UTC_HOUR)),
  };
}

const PLACEHOLDER = parseReportMonth('2000-01');

/** Lee el mes del reporte. Los problemas quedan en el lector; el llamador llama a `finish()` antes de usarlo. */
export function readReportMonth(reader: InputReader): ReportMonth {
  const before = reader.errorCount();
  const text = reader.text('month', { label: 'El mes', max: MAX_MONTH_TEXT });
  // Un mes que falta o esta en blanco ya tiene su problema; no se le suma el de «no es un mes».
  if (reader.errorCount() > before) return PLACEHOLDER;
  return reader.convert(
    'month',
    { code: 'invalid-month', detail: 'El mes se escribe año-mes, como 2026-10.' },
    () => parseReportMonth(text),
    PLACEHOLDER,
  );
}

/** Los renglones de la declaracion, en su orden y siempre los cuatro, aunque el mes no tenga ventas (ADR 0035). */
const ROWS = [
  { taxKind: 'taxed', rateBp: 1900 },
  { taxKind: 'taxed', rateBp: 500 },
  { taxKind: 'exempt', rateBp: 0 },
  { taxKind: 'excluded', rateBp: 0 },
] as const satisfies readonly { taxKind: TaxKind; rateBp: number }[];

/** De una venta, lo que el reporte necesita: sus lineas y sus cobros. */
export interface ReportSale {
  readonly lines: readonly {
    readonly unitPrice: number;
    readonly quantityMilli: number;
    readonly discount: number;
    readonly taxRateBp: number;
    readonly taxKind: TaxKind;
  }[];
  readonly payments: readonly { readonly method: PaymentMethod; readonly amount: number }[];
}

export interface ReportRow {
  readonly taxKind: TaxKind;
  readonly rateBp: number;
  /** Con el IVA incluido. */
  readonly total: number;
  readonly base: number;
  readonly tax: number;
}

export interface ReportSection {
  /** Cuantas ventas entran. */
  readonly count: number;
  readonly total: number;
  readonly base: number;
  readonly tax: number;
  readonly rows: readonly ReportRow[];
  /** Lo cobrado por medio de pago, sin el vuelto; siempre los tres medios. */
  readonly payments: readonly { readonly method: PaymentMethod; readonly amount: number }[];
}

export interface MonthlyReport {
  readonly month: string;
  readonly from: Date;
  readonly to: Date;
  /** Las ventas hechas en el mes, aunque despues se anularan. */
  readonly sales: ReportSection;
  /** Las ventas anuladas en el mes, con los montos de la venta que se anulo: aparte, no restadas (ADR 0032). */
  readonly voids: ReportSection;
}

/**
 * Suma un grupo de ventas venta por venta (ADR 0035): las lineas de una misma tarifa y tipo se suman ANTES de sacar el IVA, una
 * vez por venta, igual que el recibo (ADR 0014). El reporte suma entonces lo que dijo cada recibo y no saca el IVA del total del mes.
 */
function sectionOf(sales: readonly ReportSale[]): ReportSection {
  const rows = ROWS.map((row) => ({ ...row, total: 0, base: 0, tax: 0 }));
  const paid = new Map<PaymentMethod, number>(PAYMENT_METHODS.map((method) => [method, 0]));
  for (const sale of sales) {
    const totals = rows.map(() => 0);
    for (const line of sale.lines) {
      const index = ROWS.findIndex(
        (row) => row.taxKind === line.taxKind && row.rateBp === line.taxRateBp,
      );
      if (index < 0) {
        throw new Error(
          `The report has no row for ${line.taxKind} at ${String(line.taxRateBp)} bp`,
        );
      }
      totals[index] =
        (totals[index] ?? 0) +
        lineTotal({
          unitPrice: Money.of(line.unitPrice),
          quantityMilli: line.quantityMilli,
          discount: Money.of(line.discount),
          rateBp: line.taxRateBp,
        }).amount;
    }
    rows.forEach((row, index) => {
      const total = totals[index] ?? 0;
      const { base, tax } = splitTaxIncluded(Money.of(total), row.rateBp);
      row.total += total;
      row.base += base.amount;
      row.tax += tax.amount;
    });
    for (const payment of sale.payments) {
      paid.set(payment.method, (paid.get(payment.method) ?? 0) + payment.amount);
    }
  }
  const sum = (pick: (row: ReportRow) => number): number =>
    rows.reduce((accumulated, row) => accumulated + pick(row), 0);
  return {
    count: sales.length,
    total: sum((row) => row.total),
    base: sum((row) => row.base),
    tax: sum((row) => row.tax),
    rows,
    payments: PAYMENT_METHODS.map((method) => ({ method, amount: paid.get(method) ?? 0 })),
  };
}

/** El reporte del mes: las ventas hechas en el y, aparte, las anuladas en el. */
export function buildMonthlyReport(
  month: ReportMonth,
  sold: readonly ReportSale[],
  voided: readonly ReportSale[],
): MonthlyReport {
  return {
    month: month.key,
    from: month.from,
    to: month.to,
    sales: sectionOf(sold),
    voids: sectionOf(voided),
  };
}
