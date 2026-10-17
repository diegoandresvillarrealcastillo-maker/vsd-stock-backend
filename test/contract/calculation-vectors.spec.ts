import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderVectors, VECTORS_PATH } from '../../scripts/calculation-vectors.ts';
import { Money } from '../../src/domain/model/money.js';
import {
  grossLineTotal,
  lineTotal,
  percentOf,
  summarizeSale,
  type SaleLine,
} from '../../src/domain/model/sale-totals.js';
import { splitTaxIncluded } from '../../src/domain/model/tax.js';

// Los vectores de calculo los comparten el backend y el frontend (ADR 0014): el cliente es el
// que cobra cuando no hay red, y si su aritmetica difiere de la del servidor, el ticket no
// coincide con lo que el servidor registra. Estas pruebas ejecutan cada vector contra el dominio.

interface Vectors {
  version: number;
  currency: string;
  rounding: string;
  breakdown: { total: number; rateBp: number; base: number; tax: number }[];
  gross: { unitPrice: number; quantityMilli: number; total: number }[];
  percent: { amount: number; percentBp: number; result: number }[];
  sale: {
    name: string;
    lines: { unitPrice: number; quantityMilli: number; discount: number; rateBp: number }[];
    expected: {
      total: number;
      base: number;
      tax: number;
      byRate: { rateBp: number; total: number; base: number; tax: number }[];
    };
  }[];
  invalid: { fn: string; note: string; input: Record<string, unknown> }[];
}

const FILE = resolve(import.meta.dirname, '../..', VECTORS_PATH);
const vectors = JSON.parse(readFileSync(FILE, 'utf8')) as Vectors;

const toLines = (lines: Vectors['sale'][number]['lines']): SaleLine[] =>
  lines.map((entry) => ({
    unitPrice: Money.of(entry.unitPrice),
    quantityMilli: entry.quantityMilli,
    discount: Money.of(entry.discount),
    rateBp: entry.rateBp,
  }));

describe('calculation vectors (ADR 0014)', () => {
  it('are up to date with the generator that computes them with exact arithmetic', () => {
    expect(readFileSync(FILE, 'utf8')).toBe(renderVectors());
  });

  it('cover the three rates, both signs, ties and the largest amount', () => {
    expect(new Set(vectors.breakdown.map((row) => row.rateBp))).toEqual(new Set([0, 500, 1900]));
    expect(vectors.breakdown.some((row) => row.total < 0)).toBe(true);
    expect(vectors.breakdown.some((row) => row.total === 1_000_000_000_000)).toBe(true);
    expect(vectors.gross.some((row) => (row.unitPrice * row.quantityMilli) % 1000 === 500)).toBe(
      true,
    );
    expect(vectors.sale.length).toBeGreaterThanOrEqual(8);
    expect(vectors.invalid.length).toBeGreaterThanOrEqual(10);
  });

  it('say which currency and which rounding they assume', () => {
    expect(vectors.version).toBe(1);
    expect(vectors.currency).toBe('COP');
    expect(vectors.rounding).toBe('half-away-from-zero');
  });

  it.each(vectors.breakdown.map((row) => [`${row.total} @ ${row.rateBp}`, row] as const))(
    'breaks %s down as expected',
    (_label, row) => {
      const result = splitTaxIncluded(Money.of(row.total), row.rateBp);

      expect({ base: result.base.amount, tax: result.tax.amount }).toEqual({
        base: row.base,
        tax: row.tax,
      });
    },
  );

  it.each(vectors.gross.map((row) => [`${row.unitPrice} x ${row.quantityMilli}`, row] as const))(
    'prices the line %s as expected',
    (_label, row) => {
      expect(grossLineTotal(Money.of(row.unitPrice), row.quantityMilli).amount).toBe(row.total);
    },
  );

  it.each(vectors.percent.map((row) => [`${row.percentBp} bp of ${row.amount}`, row] as const))(
    'takes %s as expected',
    (_label, row) => {
      expect(percentOf(Money.of(row.amount), row.percentBp).amount).toBe(row.result);
    },
  );

  it.each(vectors.sale.map((entry) => [entry.name, entry] as const))(
    'summarizes the sale "%s" as expected',
    (_name, entry) => {
      const summary = summarizeSale(toLines(entry.lines));

      expect({
        total: summary.total.amount,
        base: summary.base.amount,
        tax: summary.tax.amount,
        byRate: summary.byRate.map((row) => ({
          rateBp: row.rateBp,
          total: row.total.amount,
          base: row.base.amount,
          tax: row.tax.amount,
        })),
      }).toEqual(entry.expected);
    },
  );

  it.each(vectors.invalid.map((entry) => [entry.note, entry] as const))(
    'rejects with a RangeError: %s',
    (_note, entry) => {
      // El JSON trae a proposito entradas de tipo equivocado (un texto donde va un numero): el
      // dominio debe rechazarlas, no confiar en los tipos de TypeScript.
      const input: Record<string, unknown> = entry.input;
      const number = (key: string): number => input[key] as number;
      const run: Record<string, () => unknown> = {
        breakdown: () => splitTaxIncluded(Money.of(number('total')), number('rateBp')),
        gross: () => grossLineTotal(Money.of(number('unitPrice')), number('quantityMilli')),
        percent: () => percentOf(Money.of(number('amount')), number('percentBp')),
        sale: () => summarizeSale(toLines(input['lines'] as Vectors['sale'][number]['lines'])),
      };

      expect(run[entry.fn]).toBeDefined();
      expect(() => run[entry.fn]?.()).toThrow(RangeError);
    },
  );

  it('keeps lineTotal consistent with the pieces it is made of', () => {
    for (const entry of vectors.sale) {
      for (const each of toLines(entry.lines)) {
        expect(lineTotal(each).amount).toBe(
          grossLineTotal(each.unitPrice, each.quantityMilli).amount - each.discount.amount,
        );
      }
    }
  });
});
