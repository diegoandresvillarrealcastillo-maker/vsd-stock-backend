import { describe, expect, it } from 'vitest';
import {
  NEW_PRODUCT_FIELDS,
  PRODUCT_CHANGE_FIELDS,
  readNewProduct,
  readProductChange,
  type NewProduct,
  type ProductChange,
} from './product-input.js';
import { InputReader, ValidationFailedError, type FieldError } from './validation.js';

const CATEGORY = '33333333-3333-4333-8333-333333333333';
// Un EAN-13 (prefijo de Colombia) con su digito de control correcto.
const BARCODE = '7701234567897';

const valid = {
  name: 'Arroz 500 g',
  sku: 'ARR-500',
  unit: 'unit',
  unitPrice: 3200,
  taxRateBp: 0,
};

const read = <T>(work: (reader: InputReader) => T, body: unknown, fields: readonly string[]): T => {
  const reader = new InputReader(body, fields);
  const value = work(reader);
  reader.finish();
  return value;
};

const newProduct = (body: unknown): NewProduct => read(readNewProduct, body, NEW_PRODUCT_FIELDS);
const change = (body: unknown): ProductChange =>
  read(readProductChange, body, PRODUCT_CHANGE_FIELDS);

const errorsOf = (work: (body: unknown) => unknown, body: unknown): readonly FieldError[] => {
  try {
    work(body);
    return [];
  } catch (error) {
    if (error instanceof ValidationFailedError) return error.errors;
    throw error;
  }
};

describe('a new product', () => {
  it('needs a name, a SKU, a unit, a price and an IVA rate; the rest is none', () => {
    const product = newProduct(valid);

    expect(product.name).toBe('Arroz 500 g');
    expect(product.sku.value).toBe('ARR-500');
    expect(product.unit).toBe('unit');
    expect(product.unitPrice).toBe(3200);
    expect(product.taxRateBp).toBe(0);
    expect(product.barcode).toBeNull();
    expect(product.categoryId).toBeNull();
    expect(product.minStockMilli).toBeNull();
  });

  it('takes the barcode, the category and the minimum stock when they are given', () => {
    const product = newProduct({
      ...valid,
      barcode: BARCODE,
      categoryId: CATEGORY,
      minStockMilli: 5000,
    });

    expect(product.barcode?.value).toBe(BARCODE);
    expect(product.categoryId).toBe(CATEGORY);
    expect(product.minStockMilli).toBe(5000);
  });

  it('reads null as none for the optional fields', () => {
    const product = newProduct({ ...valid, barcode: null, categoryId: null, minStockMilli: null });

    expect(product.barcode).toBeNull();
    expect(product.categoryId).toBeNull();
    expect(product.minStockMilli).toBeNull();
  });

  it('trims the name and the SKU', () => {
    const product = newProduct({ ...valid, name: '  Arroz  ', sku: ' ARR-500 ' });

    expect(product.name).toBe('Arroz');
    expect(product.sku.value).toBe('ARR-500');
  });

  it('accepts a price of zero and the largest price, and refuses one more peso or a negative', () => {
    expect(newProduct({ ...valid, unitPrice: 0 }).unitPrice).toBe(0);
    expect(newProduct({ ...valid, unitPrice: 1_000_000_000_000 }).unitPrice).toBe(
      1_000_000_000_000,
    );
    expect(errorsOf(newProduct, { ...valid, unitPrice: 1_000_000_000_001 })[0]).toMatchObject({
      pointer: '/unitPrice',
      code: 'out-of-range',
    });
    expect(errorsOf(newProduct, { ...valid, unitPrice: -1 })[0]).toMatchObject({
      pointer: '/unitPrice',
      code: 'out-of-range',
    });
  });

  it.each([0, 500, 1900])('accepts the IVA rate of %i basis points', (rate) => {
    expect(newProduct({ ...valid, taxRateBp: rate }).taxRateBp).toBe(rate);
  });

  it.each([1, 1000, 1901, 10_000])(
    'refuses the IVA rate of %i, which is not 0 %, 5 % or 19 %',
    (rate) => {
      expect(errorsOf(newProduct, { ...valid, taxRateBp: rate })).toEqual([
        {
          pointer: '/taxRateBp',
          code: 'invalid-value',
          detail: 'La tarifa de IVA debe ser 0, 500 o 1900 puntos básicos (0 %, 5 % o 19 %).',
        },
      ]);
    },
  );

  it.each(['unit', 'kilogram', 'gram', 'pound', 'liter', 'milliliter'])(
    'accepts the unit %s',
    (unit) => {
      expect(newProduct({ ...valid, unit }).unit).toBe(unit);
    },
  );

  it('refuses a unit that is not one of the six, and lists them', () => {
    expect(errorsOf(newProduct, { ...valid, unit: 'box' })).toEqual([
      {
        pointer: '/unit',
        code: 'invalid-value',
        detail: 'La unidad debe ser uno de: unit, kilogram, gram, pound, liter, milliliter.',
      },
    ]);
  });

  it.each(['con acento é', 'con%signo', 'dos  espacios'])(
    'refuses the SKU %j with a reason a person understands',
    (sku) => {
      expect(errorsOf(newProduct, { ...valid, sku })).toEqual([
        {
          pointer: '/sku',
          code: 'invalid-sku',
          detail:
            'El SKU solo lleva letras sin acento, dígitos y . _ / - (con espacios sueltos entre grupos).',
        },
      ]);
    },
  );

  it('accepts a SKU of 40 characters and refuses one of 41, as too long', () => {
    expect(newProduct({ ...valid, sku: 'a'.repeat(40) }).sku.value).toHaveLength(40);
    expect(errorsOf(newProduct, { ...valid, sku: 'a'.repeat(41) })).toEqual([
      { pointer: '/sku', code: 'too-long', detail: 'El SKU no puede pasar de 40 caracteres.' },
    ]);
  });

  it('accepts a name of 120 characters and refuses one of 121, as too long', () => {
    expect(newProduct({ ...valid, name: 'n'.repeat(120) }).name).toHaveLength(120);
    expect(errorsOf(newProduct, { ...valid, name: 'n'.repeat(121) })).toEqual([
      { pointer: '/name', code: 'too-long', detail: 'El nombre no puede pasar de 120 caracteres.' },
    ]);
  });

  it('refuses a barcode with a wrong check digit, a wrong length or letters', () => {
    for (const barcode of ['7701234567890', '12345', 'ABCDEFGH']) {
      expect(errorsOf(newProduct, { ...valid, barcode })).toEqual([
        {
          pointer: '/barcode',
          code: 'invalid-barcode',
          detail:
            'El código de barras no es un GTIN válido: 8, 12, 13 o 14 dígitos con su dígito de control.',
        },
      ]);
    }
  });

  it('refuses an empty barcode: «none» is null, not an empty text', () => {
    expect(errorsOf(newProduct, { ...valid, barcode: '' })[0]).toMatchObject({
      pointer: '/barcode',
      code: 'blank',
    });
  });

  it.each(['no-es-un-uuid', 5, ''])('refuses the category %j', (categoryId) => {
    const errors = errorsOf(newProduct, { ...valid, categoryId });

    expect(errors).toHaveLength(1);
    expect(errors[0]?.pointer).toBe('/categoryId');
  });

  it.each([-1, 1_000_000_001, 1.5, '5'])('refuses the minimum stock %j', (minStockMilli) => {
    expect(errorsOf(newProduct, { ...valid, minStockMilli })[0]).toMatchObject({
      pointer: '/minStockMilli',
    });
  });

  it('accepts a minimum stock of zero and of a thousand million thousandths', () => {
    expect(newProduct({ ...valid, minStockMilli: 0 }).minStockMilli).toBe(0);
    expect(newProduct({ ...valid, minStockMilli: 1_000_000_000 }).minStockMilli).toBe(
      1_000_000_000,
    );
  });

  it('says what is missing, every field at once', () => {
    expect(errorsOf(newProduct, {}).map((e) => `${e.pointer}:${e.code}`)).toEqual([
      '/name:required',
      '/sku:required',
      '/unit:required',
      '/unitPrice:required',
      '/taxRateBp:required',
    ]);
  });

  it('does not take «active» when creating: a new product is active', () => {
    expect(errorsOf(newProduct, { ...valid, active: false })[0]).toMatchObject({
      pointer: '/active',
      code: 'unknown-field',
    });
  });

  it('refuses a field it does not know', () => {
    expect(errorsOf(newProduct, { ...valid, precio: 5 })[0]).toMatchObject({
      pointer: '/precio',
      code: 'unknown-field',
    });
  });
});

describe('a change to a product', () => {
  it('changes only what was given', () => {
    expect(change({ name: 'Arroz integral' })).toEqual({ name: 'Arroz integral' });
    expect(change({ unitPrice: 3500 })).toEqual({ unitPrice: 3500 });
    expect(change({ active: false })).toEqual({ active: false });
    expect(change({ taxRateBp: 1900 })).toEqual({ taxRateBp: 1900 });
    expect(change({ unit: 'kilogram' })).toEqual({ unit: 'kilogram' });
  });

  it('changes the SKU and the barcode through the same checks as a new product', () => {
    const result = change({ sku: 'NUEVO-1', barcode: BARCODE });

    expect(result.sku?.value).toBe('NUEVO-1');
    expect(result.barcode?.value).toBe(BARCODE);
    expect(errorsOf(change, { sku: 'mal é' })[0]?.pointer).toBe('/sku');
    expect(errorsOf(change, { barcode: '12345' })[0]?.code).toBe('invalid-barcode');
  });

  it('clears the barcode, the category and the minimum stock with null', () => {
    expect(change({ barcode: null })).toEqual({ barcode: null });
    expect(change({ categoryId: null })).toEqual({ categoryId: null });
    expect(change({ minStockMilli: null })).toEqual({ minStockMilli: null });
  });

  it('sets the category and the minimum stock', () => {
    expect(change({ categoryId: CATEGORY, minStockMilli: 2500 })).toEqual({
      categoryId: CATEGORY,
      minStockMilli: 2500,
    });
  });

  it('asks for at least one change', () => {
    expect(errorsOf(change, {})).toEqual([
      { pointer: '', code: 'empty-change', detail: 'Indica al menos un dato para cambiar.' },
    ]);
  });

  it('does not take null for what cannot be none', () => {
    for (const field of ['name', 'sku', 'unit', 'unitPrice', 'taxRateBp', 'active']) {
      const errors = errorsOf(change, { [field]: null });
      expect(errors, field).toHaveLength(1);
      expect(errors[0]?.pointer).toBe(`/${field}`);
    }
  });

  it('reports every problem together', () => {
    expect(
      errorsOf(change, { name: '', unitPrice: -5, taxRateBp: 7, active: 'si' }).map(
        (e) => `${e.pointer}:${e.code}`,
      ),
    ).toEqual([
      '/name:blank',
      '/unitPrice:out-of-range',
      '/taxRateBp:invalid-value',
      '/active:invalid-type',
    ]);
  });
});
