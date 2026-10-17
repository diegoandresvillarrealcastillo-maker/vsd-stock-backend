import { describe, expect, it } from 'vitest';
import {
  ADJUSTMENT_FIELDS,
  adjustmentFingerprint,
  readAdjustment,
  type AdjustmentInput,
} from './stock-input.js';
import { InputReader, ValidationFailedError, type FieldError } from './validation.js';

const OPERATION = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const PRODUCT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const body = (overrides: Record<string, unknown> = {}) => ({
  operationId: OPERATION,
  productId: PRODUCT,
  deltaMilli: -2000,
  reason: 'Se cayeron dos paquetes',
  ...overrides,
});

const read = (input: unknown): AdjustmentInput => {
  const reader = new InputReader(input, ADJUSTMENT_FIELDS);
  const adjustment = readAdjustment(reader);
  reader.finish();
  return adjustment;
};

const errorsOf = (input: unknown): readonly FieldError[] => {
  try {
    read(input);
    return [];
  } catch (error) {
    if (error instanceof ValidationFailedError) return error.errors;
    throw error;
  }
};

const pointers = (input: unknown) => errorsOf(input).map((e) => `${e.pointer}:${e.code}`);

describe('a stock adjustment', () => {
  it('names the operation, the product, how much it goes up or down and why', () => {
    expect(read(body())).toEqual({
      operationId: OPERATION,
      productId: PRODUCT,
      deltaMilli: -2000,
      reason: 'Se cayeron dos paquetes',
    });
  });

  it('goes up as well as down', () => {
    expect(read(body({ deltaMilli: 3500 })).deltaMilli).toBe(3500);
  });

  it('writes the identifiers in lower case and the reason without the spaces around it', () => {
    const adjustment = read(
      body({
        operationId: OPERATION.toUpperCase(),
        productId: PRODUCT.toUpperCase(),
        reason: '  Conteo del lunes ',
      }),
    );

    expect(adjustment.operationId).toBe(OPERATION);
    expect(adjustment.productId).toBe(PRODUCT);
    expect(adjustment.reason).toBe('Conteo del lunes');
  });

  it('says what is missing, every field at once', () => {
    expect(pointers({})).toEqual([
      '/operationId:required',
      '/productId:required',
      '/deltaMilli:required',
      '/reason:required',
    ]);
  });

  it('wants a reason: an adjustment without why is a hole in the books', () => {
    expect(pointers(body({ reason: '   ' }))).toEqual(['/reason:blank']);
    expect(pointers(body({ reason: undefined }))).toEqual(['/reason:required']);
    expect(pointers(body({ reason: null }))).toEqual(['/reason:invalid-type']);
  });

  it('accepts a reason of 500 characters and refuses one of 501', () => {
    expect(read(body({ reason: 'r'.repeat(500) })).reason).toHaveLength(500);
    expect(errorsOf(body({ reason: 'r'.repeat(501) }))).toEqual([
      {
        pointer: '/reason',
        code: 'too-long',
        detail: 'El motivo no puede pasar de 500 caracteres.',
      },
    ]);
  });

  it('refuses an adjustment that changes nothing', () => {
    expect(errorsOf(body({ deltaMilli: 0 }))).toEqual([
      {
        pointer: '/deltaMilli',
        code: 'zero-delta',
        detail: 'La cantidad del ajuste no puede ser cero: no cambiaría nada.',
      },
    ]);
  });

  it('does not say «zero» when the quantity was not a number at all', () => {
    expect(pointers(body({ deltaMilli: 'cero' }))).toEqual(['/deltaMilli:invalid-type']);
    expect(pointers(body({ deltaMilli: 1.5 }))).toEqual(['/deltaMilli:invalid-type']);
    expect(pointers(body({ deltaMilli: null }))).toEqual(['/deltaMilli:invalid-type']);
  });

  it('accepts a billion thousandths up or down and refuses one more', () => {
    expect(read(body({ deltaMilli: 1_000_000_000 })).deltaMilli).toBe(1_000_000_000);
    expect(read(body({ deltaMilli: -1_000_000_000 })).deltaMilli).toBe(-1_000_000_000);
    expect(pointers(body({ deltaMilli: 1_000_000_001 }))).toEqual(['/deltaMilli:out-of-range']);
    expect(pointers(body({ deltaMilli: -1_000_000_001 }))).toEqual(['/deltaMilli:out-of-range']);
  });

  it.each(['no-es-uuid', 5, null])('refuses the operation id %j', (operationId) => {
    expect(pointers(body({ operationId }))).toEqual([
      '/operationId:' + (typeof operationId === 'string' ? 'invalid-id' : 'invalid-type'),
    ]);
  });

  it.each(['no-es-uuid', 5, null])('refuses the product id %j', (productId) => {
    expect(pointers(body({ productId }))).toEqual([
      '/productId:' + (typeof productId === 'string' ? 'invalid-id' : 'invalid-type'),
    ]);
  });

  it('refuses a field it does not know: the balance is not something a person edits', () => {
    expect(pointers(body({ balanceMilli: 10_000 }))).toEqual(['/balanceMilli:unknown-field']);
  });
});

describe('the fingerprint of an adjustment', () => {
  const base = read(body());

  it('is the same text for the same adjustment, written as it may be written', () => {
    const rewritten = read({
      reason: '  Se cayeron dos paquetes ',
      deltaMilli: -2000,
      productId: PRODUCT.toUpperCase(),
      operationId: OPERATION,
    });

    expect(adjustmentFingerprint(rewritten)).toBe(adjustmentFingerprint(base));
  });

  it('does not include the operation id: that is the key it is compared under', () => {
    const other = read(body({ operationId: '99999999-9999-4999-8999-999999999999' }));

    expect(adjustmentFingerprint(other)).toBe(adjustmentFingerprint(base));
  });

  it.each([
    ['the product', { productId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }],
    ['the quantity', { deltaMilli: -2001 }],
    ['the sign', { deltaMilli: 2000 }],
    ['the reason', { reason: 'Otro motivo' }],
  ])('changes when %s changes', (_name, change) => {
    expect(adjustmentFingerprint(read(body(change)))).not.toBe(adjustmentFingerprint(base));
  });
});
