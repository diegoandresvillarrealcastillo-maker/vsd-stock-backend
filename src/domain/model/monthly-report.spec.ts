import { describe, expect, it } from 'vitest';
import {
  REPORT_FIELDS,
  buildMonthlyReport,
  parseReportMonth,
  readReportMonth,
  type ReportSale,
} from './monthly-report.js';
import { InputReader, ValidationFailedError } from './validation.js';
import type { PaymentRecord, SaleLineRecord } from '../ports/out/sales.js';
import type { TaxKind } from './tax.js';

const OCTOBER = parseReportMonth('2026-10');

/** Una linea de venta: el precio por unidad, la cantidad en unidades enteras y la tarifa con su tipo. */
const line = (
  unitPrice: number,
  rateBp: number,
  taxKind: TaxKind,
  { units = 1, discount = 0 }: { units?: number; discount?: number } = {},
): SaleLineRecord => ({
  productId: 'f0000000-0000-4000-8000-0000000000a1',
  quantityMilli: units * 1000,
  unitPrice,
  discount,
  taxRateBp: rateBp,
  taxKind,
});
const taxed19 = (unitPrice: number, units = 1) => line(unitPrice, 1900, 'taxed', { units });
const taxed5 = (unitPrice: number) => line(unitPrice, 500, 'taxed');
const exempt = (unitPrice: number) => line(unitPrice, 0, 'exempt');
const excluded = (unitPrice: number) => line(unitPrice, 0, 'excluded');

const sale = (
  lines: SaleLineRecord[],
  payments: PaymentRecord[] = [{ method: 'cash', amount: 0, reference: null }],
): ReportSale => ({ lines, payments });
const pay = (method: PaymentRecord['method'], amount: number): PaymentRecord => ({
  method,
  amount,
  reference: null,
});

const build = (sold: ReportSale[], voided: ReportSale[] = []) =>
  buildMonthlyReport(OCTOBER, sold, voided);

describe('parseReportMonth', () => {
  it('takes the month as AAAA-MM and bounds it at midnight in Bogotá, which is 05:00 UTC', () => {
    expect(OCTOBER.key).toBe('2026-10');
    expect(OCTOBER.from.toISOString()).toBe('2026-10-01T05:00:00.000Z');
    expect(OCTOBER.to.toISOString()).toBe('2026-11-01T05:00:00.000Z');
  });

  it('closes December at the start of the next year', () => {
    const december = parseReportMonth('2026-12');

    expect(december.from.toISOString()).toBe('2026-12-01T05:00:00.000Z');
    expect(december.to.toISOString()).toBe('2027-01-01T05:00:00.000Z');
  });

  it('knows the length of February, leap years included', () => {
    expect(parseReportMonth('2028-02').to.toISOString()).toBe('2028-03-01T05:00:00.000Z');
    expect(parseReportMonth('2027-02').to.toISOString()).toBe('2027-03-01T05:00:00.000Z');
  });

  it('leaves the last Bogotá second of the month inside it and the first one of the next outside', () => {
    // 2026-10-31 23:59:59 en Bogotá son las 04:59:59 UTC del 1 de noviembre.
    const lastSecond = new Date('2026-11-01T04:59:59.999Z').getTime();
    const firstOfNext = new Date('2026-11-01T05:00:00.000Z').getTime();

    expect(lastSecond).toBeLessThan(OCTOBER.to.getTime());
    expect(firstOfNext).toBeGreaterThanOrEqual(OCTOBER.to.getTime());
  });

  it.each(['', '2026-1', '2026-13', '2026-00', '1999-12', '2026-10-01', 'octubre', ' 2026-10'])(
    'rejects «%s»',
    (text) => {
      expect(() => parseReportMonth(text)).toThrow(RangeError);
    },
  );
});

describe('readReportMonth', () => {
  const failures = (input: unknown): string[] => {
    const reader = new InputReader(input, REPORT_FIELDS);
    readReportMonth(reader);
    try {
      reader.finish();
    } catch (thrown) {
      return (thrown as ValidationFailedError).errors.map((e) => `${e.pointer}:${e.code}`);
    }
    return [];
  };

  it('reads the month that was asked', () => {
    const reader = new InputReader({ month: '2026-10' }, REPORT_FIELDS);

    expect(readReportMonth(reader).key).toBe('2026-10');
    expect(() => {
      reader.finish();
    }).not.toThrow();
  });

  it('asks for the month: there is no month by default', () => {
    expect(failures({})).toEqual(['/month:required']);
  });

  it('says which part is wrong', () => {
    expect(failures({ month: '2026-13' })).toEqual(['/month:invalid-month']);
    expect(failures({ month: 202610 })).toEqual(['/month:invalid-type']);
    expect(failures({ month: '   ' })).toEqual(['/month:blank']);
  });

  it('rejects what is not a parameter of the report', () => {
    expect(failures({ month: '2026-10', year: '2026' })).toEqual(['/year:unknown-field']);
  });
});

describe('buildMonthlyReport: the rows of the declaration', () => {
  it('has the four rows always, in the order of the declaration, even in a month without sales', () => {
    const report = build([]);

    expect(report.month).toBe('2026-10');
    expect(report.from).toEqual(OCTOBER.from);
    expect(report.to).toEqual(OCTOBER.to);
    expect(report.sales.rows.map((r) => [r.taxKind, r.rateBp])).toEqual([
      ['taxed', 1900],
      ['taxed', 500],
      ['exempt', 0],
      ['excluded', 0],
    ]);
    for (const row of report.sales.rows) {
      expect(row).toMatchObject({ total: 0, base: 0, tax: 0 });
    }
    expect(report.sales).toMatchObject({ count: 0, total: 0, base: 0, tax: 0 });
  });

  it('puts every line in the row of its kind and its rate, whatever the order it was sold in', () => {
    const report = build([sale([excluded(500), taxed5(1050), exempt(700), taxed19(11_900)])]);

    expect(report.sales.rows).toEqual([
      { taxKind: 'taxed', rateBp: 1900, total: 11_900, base: 10_000, tax: 1_900 },
      { taxKind: 'taxed', rateBp: 500, total: 1_050, base: 1_000, tax: 50 },
      { taxKind: 'exempt', rateBp: 0, total: 700, base: 700, tax: 0 },
      { taxKind: 'excluded', rateBp: 0, total: 500, base: 500, tax: 0 },
    ]);
  });

  it('keeps exempt and excluded apart even when they are in the same sale', () => {
    const report = build([sale([exempt(1_000), excluded(2_000), exempt(300)])]);

    const byKind = Object.fromEntries(
      report.sales.rows.map((r) => [r.taxKind + r.rateBp, r.total]),
    );
    expect(byKind).toMatchObject({ exempt0: 1_300, excluded0: 2_000 });
  });

  it('refuses a line that fits none of the four rows instead of leaving it out of the month', () => {
    // Una tarifa que el catalogo no ofrece, o un tipo con la tarifa de otro: el reporte no suma menos en silencio.
    expect(() => build([sale([line(1_000, 700, 'taxed')])])).toThrow(
      'The report has no row for taxed at 700 bp',
    );
    expect(() => build([sale([line(1_000, 1900, 'exempt')])])).toThrow(
      'The report has no row for exempt at 1900 bp',
    );
    expect(() => build([], [sale([line(1_000, 700, 'taxed')])])).toThrow(
      'The report has no row for taxed at 700 bp',
    );
  });

  it('counts the discount and the fractions of a unit, as the receipt does', () => {
    const report = build([
      sale([
        line(3_000, 1900, 'taxed', { units: 1.5, discount: 500 }),
        line(1_000, 0, 'exempt', { discount: 100 }),
      ]),
    ]);

    expect(report.sales.rows[0]).toMatchObject({ total: 4_000 });
    expect(report.sales.rows[2]).toMatchObject({ total: 900 });
  });

  it('totals the section as the sum of its rows, and the total is the base plus the tax', () => {
    const report = build([
      sale([taxed19(11_900), taxed5(1_050), exempt(700), excluded(500)]),
      sale([taxed19(5_000)]),
    ]);

    expect(report.sales.count).toBe(2);
    expect(report.sales.total).toBe(11_900 + 1_050 + 700 + 500 + 5_000);
    expect(report.sales.total).toBe(report.sales.base + report.sales.tax);
    expect(report.sales.total).toBe(report.sales.rows.reduce((sum, r) => sum + r.total, 0));
    expect(report.sales.tax).toBe(report.sales.rows.reduce((sum, r) => sum + r.tax, 0));
  });
});

describe('buildMonthlyReport: the tax is taken out sale by sale, as the receipts say', () => {
  it('adds what each receipt said: two sales of $ 1.000 at 19 % carry $ 320 of tax, not the $ 319 of $ 2.000', () => {
    const report = build([sale([taxed19(1_000)]), sale([taxed19(1_000)])]);

    expect(report.sales.rows[0]).toMatchObject({ total: 2_000, base: 1_680, tax: 320 });
  });

  it('adds the lines of one rate before taking the tax out, as the receipt does: one sale of $ 2.000 carries $ 319', () => {
    const report = build([sale([taxed19(1_000), taxed19(1_000)])]);

    expect(report.sales.rows[0]).toMatchObject({ total: 2_000, base: 1_681, tax: 319 });
  });
});

describe('buildMonthlyReport: how the month was paid', () => {
  it('adds the payments by method, with the three methods always present and in a fixed order', () => {
    const report = build([
      sale([taxed19(10_000)], [pay('cash', 6_000), pay('card', 4_000)]),
      sale([exempt(2_000)], [pay('cash', 2_000)]),
    ]);

    expect(report.sales.payments).toEqual([
      { method: 'cash', amount: 8_000 },
      { method: 'card', amount: 4_000 },
      { method: 'transfer', amount: 0 },
    ]);
  });
});

describe('buildMonthlyReport: the voids', () => {
  it('lists them apart, with the amounts of the sale that was voided, and does not take them out of the sales', () => {
    const sold = sale([taxed19(11_900)], [pay('card', 11_900)]);
    const other = sale([exempt(700)], [pay('cash', 700)]);

    const report = build([sold, other], [sold]);

    expect(report.sales.count).toBe(2);
    expect(report.sales.total).toBe(12_600);
    expect(report.voids.count).toBe(1);
    expect(report.voids.total).toBe(11_900);
    expect(report.voids.rows[0]).toMatchObject({ total: 11_900, base: 10_000, tax: 1_900 });
    expect(report.voids.payments).toEqual([
      { method: 'cash', amount: 0 },
      { method: 'card', amount: 11_900 },
      { method: 'transfer', amount: 0 },
    ]);
  });

  it('keeps the voids in the same four rows as the sales, so the two sections can be read side by side', () => {
    const report = build([], [sale([taxed19(11_900), taxed5(1_050), exempt(700), excluded(500)])]);

    expect(report.voids.rows.map((r) => [r.taxKind, r.rateBp, r.total])).toEqual([
      ['taxed', 1900, 11_900],
      ['taxed', 500, 1_050],
      ['exempt', 0, 700],
      ['excluded', 0, 500],
    ]);
  });

  it('shows a void of a sale from another month in this one only: the sales stay at zero', () => {
    const report = build([], [sale([taxed19(11_900)])]);

    expect(report.sales).toMatchObject({ count: 0, total: 0 });
    expect(report.voids).toMatchObject({ count: 1, total: 11_900, base: 10_000, tax: 1_900 });
  });

  it('has no net: the voids are not taken out of the sales, because the accountant asked for them apart', () => {
    expect(build([sale([exempt(700)])], [sale([exempt(700)])])).not.toHaveProperty('net');
  });
});
