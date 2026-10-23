import { describe, expect, it } from 'vitest';
import { MAX_PESOS, Money } from './money.js';
import { TAX_KINDS, TAX_RATES_BP, isTaxKind, splitTaxIncluded, taxKindFitsRate } from './tax.js';

const split = (total: number, rateBp: number) => {
  const { base, tax } = splitTaxIncluded(Money.of(total), rateBp);
  return { base: base.amount, tax: tax.amount };
};

describe('the tax kind (ADR 0034)', () => {
  it('knows taxed, exempt and excluded, in that order', () => {
    expect(TAX_KINDS).toEqual(['taxed', 'exempt', 'excluded']);
  });

  it.each(TAX_KINDS)('recognises the kind %s', (kind) => {
    expect(isTaxKind(kind)).toBe(true);
  });

  it.each(['unclassified', 'Taxed', '', 'toString', 5, null, undefined])(
    'does not take %j for a kind',
    (value) => {
      expect(isTaxKind(value)).toBe(false);
    },
  );

  it.each([
    ['taxed', 500, true],
    ['taxed', 1900, true],
    ['taxed', 0, false],
    ['exempt', 0, true],
    ['exempt', 500, false],
    ['exempt', 1900, false],
    ['excluded', 0, true],
    ['excluded', 500, false],
    ['excluded', 1900, false],
  ] as const)('%s at %i basis points fits: %s', (kind, rateBp, fits) => {
    expect(taxKindFitsRate(kind, rateBp)).toBe(fits);
  });

  it('does not let «taxed» take a rate the catalogue does not have', () => {
    expect(taxKindFitsRate('taxed', 800)).toBe(false);
    expect(taxKindFitsRate('taxed', 10_000)).toBe(false);
  });

  it('gives every rate of the catalogue at least one kind, and 0 % exactly two', () => {
    for (const rateBp of TAX_RATES_BP) {
      const kinds = TAX_KINDS.filter((kind) => taxKindFitsRate(kind, rateBp));

      expect(kinds.length, `${rateBp}`).toBe(rateBp === 0 ? 2 : 1);
    }
  });

  it('does not enter the calculation: the split depends on the rate and nothing else', () => {
    expect(splitTaxIncluded.length).toBe(2);
    expect(split(10_000, 0)).toEqual({ base: 10_000, tax: 0 });
  });
});

describe('splitTaxIncluded', () => {
  it('knows the three rates of the delivery', () => {
    expect(TAX_RATES_BP).toEqual([0, 500, 1900]);
  });

  it('takes the VAT out of a price that already includes it', () => {
    expect(split(119, 1900)).toEqual({ base: 100, tax: 19 });
    expect(split(105, 500)).toEqual({ base: 100, tax: 5 });
    expect(split(1190, 1900)).toEqual({ base: 1000, tax: 190 });
  });

  it('rounds the taxable base to the nearest peso and leaves the rest to the VAT', () => {
    // 1000 / 1,19 = 840,336...
    expect(split(1000, 1900)).toEqual({ base: 840, tax: 160 });
    // 3 / 1,19 = 2,521... : redondea hacia arriba y el IVA queda en cero
    expect(split(3, 1900)).toEqual({ base: 3, tax: 0 });
    // 4 / 1,19 = 3,361...
    expect(split(4, 1900)).toEqual({ base: 3, tax: 1 });
  });

  it('charges nothing at 0 %', () => {
    expect(split(12_345, 0)).toEqual({ base: 12_345, tax: 0 });
  });

  it('adds up exactly: base + VAT is always the total, for every total and every rate', () => {
    for (const rateBp of TAX_RATES_BP) {
      for (let total = -3000; total <= 3000; total += 1) {
        const { base, tax } = split(total, rateBp);

        expect(base + tax, `${total} @ ${rateBp}`).toBe(total);
      }
    }
  });

  it('is never more than half a peso away from the exact base', () => {
    for (const rateBp of TAX_RATES_BP) {
      for (let total = 0; total <= 5000; total += 1) {
        const { base } = split(total, rateBp);
        const divisor = BigInt(10_000 + rateBp);
        const distance = BigInt(base) * divisor - BigInt(total) * 10_000n;
        const absolute = distance < 0n ? -distance : distance;

        // |base - exacta| <= 1/2  <=>  2 * |base * divisor - total * 10000| <= divisor
        expect(2n * absolute <= divisor, `${total} @ ${rateBp}`).toBe(true);
      }
    }
  });

  it('never takes more tax than the total, and never a negative one from a positive total', () => {
    for (const rateBp of TAX_RATES_BP) {
      for (let total = 0; total <= 3000; total += 1) {
        const { base, tax } = split(total, rateBp);

        expect(tax).toBeGreaterThanOrEqual(0);
        expect(tax).toBeLessThanOrEqual(total);
        expect(base).toBeLessThanOrEqual(total);
      }
    }
  });

  it('never makes the base smaller when the total grows', () => {
    for (const rateBp of TAX_RATES_BP) {
      let previous = split(0, rateBp).base;
      for (let total = 1; total <= 3000; total += 1) {
        const { base } = split(total, rateBp);

        expect(base, `${total} @ ${rateBp}`).toBeGreaterThanOrEqual(previous);
        previous = base;
      }
    }
  });

  it('breaks down a void as the exact mirror of the sale', () => {
    for (const rateBp of TAX_RATES_BP) {
      for (let total = 1; total <= 3000; total += 1) {
        const sale = split(total, rateBp);
        const voided = split(-total, rateBp);

        // Sumadas, la venta y su anulacion dejan exactamente cero en la base y en el impuesto.
        expect(sale.base + voided.base, `${total} @ ${rateBp}`).toBe(0);
        expect(sale.tax + voided.tax, `${total} @ ${rateBp}`).toBe(0);
      }
    }
  });

  it('stays exact at the largest amount', () => {
    // 10^12 * 10000 / 11900 supera los enteros seguros si se multiplica con numeros normales.
    expect(split(MAX_PESOS, 1900)).toEqual({ base: 840_336_134_454, tax: 159_663_865_546 });
  });

  it('adds up exactly for ANY rate, not only for the three in the catalogue', () => {
    // Con las tres tarifas del catalogo la mitad exacta nunca aparece; con otras (por ejemplo 2,4 %
    // y un total de 64 pesos, que da 62,5) si, y un impuesto redondeado aparte sumaria un peso de mas.
    const failures: string[] = [];
    for (let rateBp = 0; rateBp <= 10_000; rateBp += 3) {
      for (let total = 0; total <= 300; total += 1) {
        const { base, tax } = split(total, rateBp);
        if (base + tax !== total) failures.push(`${total} @ ${rateBp}`);
      }
    }

    expect(failures).toEqual([]);
    expect(split(64, 240)).toEqual({ base: 63, tax: 1 });
  });

  it.each([-1, 10_001, 19.5, Number.NaN])('rejects the rate %s', (rateBp) => {
    expect(() => splitTaxIncluded(Money.of(1000), rateBp)).toThrow(RangeError);
    expect(() => splitTaxIncluded(Money.of(1000), rateBp)).toThrow(/basis points/);
  });
});
