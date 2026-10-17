import { describe, expect, it } from 'vitest';
import { Sku } from './sku.js';

describe('Sku.parse', () => {
  it.each(['ARROZ-500', 'a1', 'GAS_350.ML', 'Cod 12/B', 'x'.repeat(40), '0001'])(
    'accepts "%s"',
    (text) => {
      expect(Sku.parse(text).value).toBe(text);
    },
  );

  it('trims the whitespace around it and keeps the one inside', () => {
    expect(Sku.parse('  Cod 12  ').value).toBe('Cod 12');
  });

  it('has a key that ignores case, so two codes that differ only in capitals are the same code', () => {
    expect(Sku.parse('arroz-500').key).toBe('ARROZ-500');
    expect(Sku.parse('Arroz-500').key).toBe(Sku.parse('ARROZ-500').key);
    expect(Sku.parse('Arroz-500').equals(Sku.parse('arroz-500'))).toBe(true);
    expect(Sku.parse('Arroz-500').value).toBe('Arroz-500');
  });

  it('tells different codes apart', () => {
    expect(Sku.parse('ARROZ-500').equals(Sku.parse('ARROZ-501'))).toBe(false);
  });

  it.each([
    ['', 'empty'],
    ['   ', 'blank'],
    ['x'.repeat(41), 'longer than 40 characters'],
    ['ARROZ\n500', 'a line break'],
    ['ARROZ\t500', 'a tab'],
    ['ARROZ#500', 'a character outside the set'],
    ['ARROZ😀', 'an emoji'],
    ['ARRÓZ', 'an accent'],
    ['ARROZ  500', 'two spaces in a row'],
  ])('rejects "%s" (%s)', (text) => {
    expect(() => Sku.parse(text)).toThrow(RangeError);
  });

  it('rejects what is not text', () => {
    expect(() => Sku.parse(123 as never)).toThrow(RangeError);
    expect(() => Sku.parse(undefined as never)).toThrow(RangeError);
  });

  it('cannot be changed once created', () => {
    const sku = Sku.parse('A1');

    expect(() => {
      (sku as { value: string }).value = 'B2';
    }).toThrow(TypeError);
  });
});
