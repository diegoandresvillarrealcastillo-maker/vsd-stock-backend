import { describe, expect, it } from 'vitest';
import { MAX_QUANTITY_MILLI } from './sale-totals.js';
import { Quantity } from './quantity.js';

describe('Quantity.of', () => {
  it('holds a positive whole number of thousandths of a unit', () => {
    const quantity = Quantity.of(1500, 'kilogram');

    expect(quantity.milli).toBe(1500);
    expect(quantity.unit).toBe('kilogram');
  });

  it('counts the unit in whole units only', () => {
    expect(Quantity.of(3000, 'unit').milli).toBe(3000);
    expect(() => Quantity.of(1500, 'unit')).toThrow(RangeError);
    expect(() => Quantity.of(1, 'unit')).toThrow(RangeError);
  });

  it('accepts the smallest and the largest quantity', () => {
    expect(Quantity.of(1, 'gram').milli).toBe(1);
    expect(Quantity.of(MAX_QUANTITY_MILLI, 'unit').milli).toBe(MAX_QUANTITY_MILLI);
  });

  it.each([0, -1000, 1.5, Number.NaN, MAX_QUANTITY_MILLI + 1000])('rejects %s', (milli) => {
    expect(() => Quantity.of(milli, 'kilogram')).toThrow(RangeError);
  });

  it('rejects a unit that does not exist', () => {
    expect(() => Quantity.of(1000, 'box' as never)).toThrow(RangeError);
  });

  it('cannot be changed once created', () => {
    const quantity = Quantity.of(1000, 'unit');

    expect(() => {
      (quantity as { milli: number }).milli = 5000;
    }).toThrow(TypeError);
  });
});

describe('Quantity.parse', () => {
  it.each([
    ['1', 'kilogram', 1000],
    ['2', 'unit', 2000],
    ['1,5', 'kilogram', 1500],
    ['1.5', 'kilogram', 1500],
    ['0,25', 'liter', 250],
    ['0.001', 'gram', 1],
    ['  3  ', 'unit', 3000],
    ['12,500', 'kilogram', 12_500],
    ['007', 'unit', 7000],
    ['2,', 'kilogram', 2000],
    ['.5', 'kilogram', 500],
  ] as const)('reads "%s" in %s as %i thousandths', (text, unit, milli) => {
    expect(Quantity.parse(text, unit).milli).toBe(milli);
  });

  it('reads a point and a comma both as the decimal separator, never as thousands', () => {
    // «1.500» son un kilo y medio, no mil quinientos: ver el ADR 0015.
    expect(Quantity.parse('1.500', 'kilogram').milli).toBe(1500);
    expect(Quantity.parse('1,500', 'kilogram').milli).toBe(1500);
  });

  it.each([
    ['', 'empty'],
    ['   ', 'blank'],
    ['abc', 'letters'],
    ['1,2,3', 'two separators'],
    ['1.2.3', 'two points'],
    ['1,5.5', 'a comma and a point'],
    ['-1', 'negative'],
    ['+1', 'with a sign'],
    ['1e3', 'scientific notation'],
    ['0x10', 'hexadecimal'],
    ['1 000', 'a space inside'],
    ['0', 'zero'],
    ['0,000', 'zero with decimals'],
    ['1,2345', 'four decimals (it would have to round)'],
    ['99999999999', 'above the maximum'],
  ])('rejects "%s" (%s)', (text) => {
    expect(() => Quantity.parse(text, 'kilogram')).toThrow(RangeError);
  });

  it('rejects decimals when the unit is counted in whole numbers', () => {
    expect(() => Quantity.parse('1,5', 'unit')).toThrow(RangeError);
    expect(() => Quantity.parse('1.0', 'unit')).not.toThrow();
    expect(Quantity.parse('1.0', 'unit').milli).toBe(1000);
  });

  it('says why: four decimals would have to be rounded, and nothing is rounded in silence', () => {
    expect(() => Quantity.parse('1,2345', 'kilogram')).toThrow(/more than three decimals/);
    expect(() => Quantity.parse('0.0001', 'gram')).toThrow(/more than three decimals/);
  });

  it('says in the error what it could not read', () => {
    expect(() => Quantity.parse('abc', 'kilogram')).toThrow(/abc/);
  });

  it('rejects what is not text', () => {
    expect(() => Quantity.parse(5 as never, 'unit')).toThrow(RangeError);
    expect(() => Quantity.parse(null as never, 'unit')).toThrow(RangeError);
  });
});

describe('Quantity arithmetic and text', () => {
  it('adds quantities of the same unit', () => {
    const total = Quantity.of(1500, 'kilogram').add(Quantity.of(2250, 'kilogram'));

    expect(total.milli).toBe(3750);
    expect(total.unit).toBe('kilogram');
  });

  it('refuses to add different units: a kilo and a liter are not a quantity', () => {
    expect(() => Quantity.of(1000, 'kilogram').add(Quantity.of(1000, 'liter'))).toThrow(RangeError);
  });

  it('refuses a sum above the maximum', () => {
    expect(() => Quantity.of(MAX_QUANTITY_MILLI, 'unit').add(Quantity.of(1000, 'unit'))).toThrow(
      RangeError,
    );
  });

  it('compares by thousandths and unit', () => {
    expect(Quantity.of(1500, 'kilogram').equals(Quantity.of(1500, 'kilogram'))).toBe(true);
    expect(Quantity.of(1500, 'kilogram').equals(Quantity.of(1501, 'kilogram'))).toBe(false);
    expect(Quantity.of(1000, 'kilogram').equals(Quantity.of(1000, 'liter'))).toBe(false);
  });

  it.each([
    [1000, 'unit', '1 und'],
    [1500, 'kilogram', '1.5 kg'],
    [1, 'gram', '0.001 g'],
    [250, 'liter', '0.25 l'],
    [12_500, 'pound', '12.5 lb'],
    [100_000, 'milliliter', '100 ml'],
  ] as const)('writes %i thousandths of %s as "%s"', (milli, unit, text) => {
    expect(Quantity.of(milli, unit).toString()).toBe(text);
  });

  it('reads back what it writes', () => {
    for (const milli of [1, 10, 100, 999, 1000, 1001, 1500, 12_345, 99_999_000]) {
      const quantity = Quantity.of(milli, 'kilogram');
      const [number] = quantity.toString().split(' ');

      expect(Quantity.parse(number ?? '', 'kilogram').equals(quantity)).toBe(true);
    }
  });
});
