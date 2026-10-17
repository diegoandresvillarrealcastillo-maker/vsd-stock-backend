import { describe, expect, it } from 'vitest';
import {
  UNITS_OF_MEASURE,
  isUnitOfMeasure,
  isWholeOnly,
  unitSymbol,
  type UnitOfMeasure,
} from './unit-of-measure.js';

describe('units of measure', () => {
  it('are a closed set: unit, weight and volume', () => {
    expect(Object.keys(UNITS_OF_MEASURE)).toEqual([
      'unit',
      'kilogram',
      'gram',
      'pound',
      'liter',
      'milliliter',
    ]);
  });

  it('has no box, pack or dozen: a presentation is a product of its own (ADR 0015)', () => {
    for (const presentation of ['box', 'pack', 'dozen', 'bundle']) {
      expect(isUnitOfMeasure(presentation)).toBe(false);
    }
  });

  it.each([
    ['unit', 'und'],
    ['kilogram', 'kg'],
    ['gram', 'g'],
    ['pound', 'lb'],
    ['liter', 'l'],
    ['milliliter', 'ml'],
  ] as [UnitOfMeasure, string][])('shows %s as "%s"', (unit, symbol) => {
    expect(unitSymbol(unit)).toBe(symbol);
  });

  it('counts only the unit in whole numbers; weight and volume admit thousandths', () => {
    expect(isWholeOnly('unit')).toBe(true);
    for (const unit of ['kilogram', 'gram', 'pound', 'liter', 'milliliter'] as const) {
      expect(isWholeOnly(unit), unit).toBe(false);
    }
  });

  it('recognizes its own names and nothing else', () => {
    expect(isUnitOfMeasure('kilogram')).toBe(true);
    expect(isUnitOfMeasure('Kilogram')).toBe(false);
    expect(isUnitOfMeasure('kg')).toBe(false);
    expect(isUnitOfMeasure('')).toBe(false);
    expect(isUnitOfMeasure(undefined)).toBe(false);
    expect(isUnitOfMeasure(5)).toBe(false);
    expect(isUnitOfMeasure('toString')).toBe(false);
    expect(isUnitOfMeasure('__proto__')).toBe(false);
  });
});
