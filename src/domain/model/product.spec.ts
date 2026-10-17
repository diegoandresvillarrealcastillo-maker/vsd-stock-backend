import { describe, expect, it } from 'vitest';
import { createProduct, type ProductInput } from './product.js';

const valid: ProductInput = {
  name: 'Arroz 500 g',
  sku: 'ARROZ-500',
  barcode: '4006381333931',
  unit: 'unit',
  unitPrice: 4500,
  rateBp: 0,
};

describe('createProduct', () => {
  it('builds a product out of validated parts', () => {
    const product = createProduct(valid);

    expect(product.name).toBe('Arroz 500 g');
    expect(product.sku.value).toBe('ARROZ-500');
    expect(product.barcode?.value).toBe('4006381333931');
    expect(product.unit).toBe('unit');
    expect(product.unitPrice.amount).toBe(4500);
    expect(product.rateBp).toBe(0);
  });

  it('does not need a barcode: a loose product lives by its SKU', () => {
    expect(createProduct({ ...valid, barcode: null }).barcode).toBeNull();
    const { barcode: _omitted, ...withoutBarcode } = valid;
    expect(createProduct(withoutBarcode).barcode).toBeNull();
  });

  it('treats an empty barcode as no barcode, because a form sends an empty text', () => {
    expect(createProduct({ ...valid, barcode: '' }).barcode).toBeNull();
    expect(createProduct({ ...valid, barcode: '  ' }).barcode).toBeNull();
  });

  it('trims the name and keeps a name with accents and punctuation', () => {
    expect(createProduct({ ...valid, name: '  Ñame (kg) — fresco  ' }).name).toBe(
      'Ñame (kg) — fresco',
    );
  });

  it.each(['', '   ', 'x'.repeat(121), 'Arroz\n500', 'Arroz\u0000'])(
    'rejects the name %j',
    (name) => {
      expect(() => createProduct({ ...valid, name })).toThrow(RangeError);
    },
  );

  it('accepts a name of exactly 120 characters', () => {
    expect(createProduct({ ...valid, name: 'x'.repeat(120) }).name).toHaveLength(120);
  });

  it('rejects a bad SKU or a bad barcode through the value objects', () => {
    expect(() => createProduct({ ...valid, sku: '' })).toThrow(RangeError);
    expect(() => createProduct({ ...valid, barcode: '4006381333932' })).toThrow(RangeError);
  });

  it('rejects a unit that is not in the closed set', () => {
    expect(() => createProduct({ ...valid, unit: 'box' })).toThrow(RangeError);
  });

  it.each([0, 500, 1900])('accepts the rate %i', (rateBp) => {
    expect(createProduct({ ...valid, rateBp }).rateBp).toBe(rateBp);
  });

  it.each([800, 100, 10_000, -1, 19.5, Number.NaN])(
    'rejects the rate %s: the catalogue only has 0 %, 5 % and 19 %',
    (rateBp) => {
      expect(() => createProduct({ ...valid, rateBp })).toThrow(RangeError);
    },
  );

  it('accepts a price of zero (a gift) and rejects a negative or fractional one', () => {
    expect(createProduct({ ...valid, unitPrice: 0 }).unitPrice.amount).toBe(0);
    expect(() => createProduct({ ...valid, unitPrice: -1 })).toThrow(RangeError);
    expect(() => createProduct({ ...valid, unitPrice: 10.5 })).toThrow(RangeError);
  });

  it('is frozen, so a product is not edited in place', () => {
    const product = createProduct(valid);

    expect(() => {
      (product as { name: string }).name = 'otro';
    }).toThrow(TypeError);
  });
});
