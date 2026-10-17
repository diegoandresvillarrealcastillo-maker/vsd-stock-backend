import { describe, expect, it } from 'vitest';
import { MAX_PESOS, Money } from './money.js';
import {
  MAX_QUANTITY_MILLI,
  grossLineTotal,
  lineTotal,
  percentOf,
  summarizeSale,
  type SaleLine,
} from './sale-totals.js';
import { splitTaxIncluded } from './tax.js';

const line = (
  unitPrice: number,
  quantityMilli: number,
  rateBp: number,
  discount = 0,
): SaleLine => ({
  unitPrice: Money.of(unitPrice),
  quantityMilli,
  discount: Money.of(discount),
  rateBp,
});

describe('grossLineTotal', () => {
  it('multiplies the price by the quantity expressed in thousandths', () => {
    expect(grossLineTotal(Money.of(2500), 1000).amount).toBe(2500);
    expect(grossLineTotal(Money.of(2500), 1500).amount).toBe(3750);
    expect(grossLineTotal(Money.of(1200), 2500).amount).toBe(3000);
  });

  it('rounds to the nearest peso and sends exactly one half away from zero', () => {
    expect(grossLineTotal(Money.of(1), 499).amount).toBe(0); // 0,499
    expect(grossLineTotal(Money.of(1), 500).amount).toBe(1); // 0,5
    expect(grossLineTotal(Money.of(3), 500).amount).toBe(2); // 1,5
    expect(grossLineTotal(Money.of(999), 3333).amount).toBe(3330); // 3329,667
  });

  it('is free when the price is zero', () => {
    expect(grossLineTotal(Money.zero(), 5000).amount).toBe(0);
  });

  it('is exact where a plain multiplication would lose precision', () => {
    expect(grossLineTotal(Money.of(MAX_PESOS), 1000).amount).toBe(MAX_PESOS);
    expect(grossLineTotal(Money.of(999_999_999_999), 1000).amount).toBe(999_999_999_999);
  });

  it.each([0, -1000, 1.5, Number.NaN, MAX_QUANTITY_MILLI + 1])(
    'rejects the quantity %s',
    (quantityMilli) => {
      expect(() => grossLineTotal(Money.of(1000), quantityMilli)).toThrow(RangeError);
    },
  );

  it('accepts the largest quantity', () => {
    expect(grossLineTotal(Money.of(1), MAX_QUANTITY_MILLI).amount).toBe(1_000_000);
  });

  it('rejects a negative price and a line above the maximum amount', () => {
    expect(() => grossLineTotal(Money.of(-1), 1000)).toThrow(RangeError);
    expect(() => grossLineTotal(Money.of(MAX_PESOS), 2000)).toThrow(RangeError);
  });
});

describe('percentOf', () => {
  it('takes a percentage in basis points, rounded to the peso', () => {
    expect(percentOf(Money.of(10_000), 500).amount).toBe(500); // 5 %
    expect(percentOf(Money.of(10_000), 1900).amount).toBe(1900);
    expect(percentOf(Money.of(999), 1000).amount).toBe(100); // 99,9
    expect(percentOf(Money.of(12_345), 1250).amount).toBe(1543); // 1543,125
  });

  it('sends exactly one half away from zero, also for a negative amount', () => {
    expect(percentOf(Money.of(1), 5000).amount).toBe(1);
    expect(percentOf(Money.of(3), 5000).amount).toBe(2);
    expect(percentOf(Money.of(-3), 5000).amount).toBe(-2);
  });

  it('gives all or nothing at the ends', () => {
    expect(percentOf(Money.of(777), 0).amount).toBe(0);
    expect(percentOf(Money.of(777), 10_000).amount).toBe(777);
  });

  it.each([-1, 10_001, 12.5, Number.NaN])('rejects the percentage %s', (percentBp) => {
    expect(() => percentOf(Money.of(1000), percentBp)).toThrow(RangeError);
    expect(() => percentOf(Money.of(1000), percentBp)).toThrow(/basis points/);
  });
});

describe('lineTotal', () => {
  it('subtracts the discount from the gross amount', () => {
    expect(lineTotal(line(8900, 2000, 1900, 1800)).amount).toBe(16_000);
  });

  it('lets the discount cancel the line, but not exceed it', () => {
    expect(lineTotal(line(5000, 1000, 1900, 5000)).amount).toBe(0);
    expect(() => lineTotal(line(5000, 1000, 1900, 5001))).toThrow(RangeError);
  });

  it('rejects a negative discount', () => {
    expect(() => lineTotal(line(5000, 1000, 1900, -1))).toThrow(RangeError);
  });
});

describe('summarizeSale', () => {
  it('is zero for an empty sale', () => {
    const summary = summarizeSale([]);

    expect(summary.total.amount).toBe(0);
    expect(summary.base.amount).toBe(0);
    expect(summary.tax.amount).toBe(0);
    expect(summary.byRate).toEqual([]);
  });

  it('breaks the VAT down once per rate, in ascending order of rate', () => {
    const summary = summarizeSale([
      line(8900, 1000, 1900), // detergente
      line(4500, 1000, 0), // arroz
      line(2300, 2000, 500), // chocolate
    ]);

    expect(summary.byRate.map((row) => row.rateBp)).toEqual([0, 500, 1900]);
    expect(summary.byRate.map((row) => row.total.amount)).toEqual([4500, 4600, 8900]);
    expect(summary.byRate.map((row) => row.base.amount)).toEqual([4500, 4381, 7479]);
    expect(summary.byRate.map((row) => row.tax.amount)).toEqual([0, 219, 1421]);
    expect(summary.total.amount).toBe(18_000);
    expect(summary.base.amount).toBe(16_360);
    expect(summary.tax.amount).toBe(1640);
  });

  it('adds the lines of one rate before extracting the VAT, so the rounding does not pile up', () => {
    const lines = [
      line(100, 1000, 500),
      line(100, 1000, 500),
      line(100, 1000, 500),
      line(50, 3000, 500),
      line(700, 500, 500),
    ];

    const grouped = summarizeSale(lines);
    const lineByLine = lines
      .map((each) => splitTaxIncluded(lineTotal(each), 500).tax.amount)
      .reduce((sum, tax) => sum + tax, 0);

    // El IVA exacto de 800 pesos al 5 % es 38,095...
    expect(grouped.tax.amount).toBe(38);
    expect(lineByLine).toBe(39);
  });

  it('applies the discount before taking the VAT out', () => {
    const summary = summarizeSale([line(8900, 2000, 1900, 1800), line(3500, 1000, 1900)]);

    expect(summary.total.amount).toBe(19_500);
    expect(summary.byRate).toHaveLength(1);
    expect(summary.byRate[0]?.base.amount).toBe(16_387);
    expect(summary.byRate[0]?.tax.amount).toBe(3113);
  });

  it('always adds up: base + VAT is the total, in every rate and in the whole sale', () => {
    let seed = 12_345;
    const next = (limit: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % limit;
    };
    const rates = [0, 500, 1900];

    for (let round = 0; round < 500; round += 1) {
      const lines = Array.from({ length: 1 + next(8) }, () =>
        line(1 + next(50_000), 1 + next(5000), rates[next(3)] ?? 0),
      );

      const summary = summarizeSale(lines);

      expect(summary.base.amount + summary.tax.amount).toBe(summary.total.amount);
      for (const row of summary.byRate) {
        expect(row.base.amount + row.tax.amount).toBe(row.total.amount);
      }
      expect(summary.byRate.reduce((sum, row) => sum + row.total.amount, 0)).toBe(
        summary.total.amount,
      );
    }
  });

  it('refuses a sale above the maximum amount', () => {
    expect(() => summarizeSale([line(MAX_PESOS, 1000, 0), line(1, 1000, 0)])).toThrow(RangeError);
  });
});
