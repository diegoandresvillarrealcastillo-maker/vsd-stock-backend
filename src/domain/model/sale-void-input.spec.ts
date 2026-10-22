import { describe, expect, it } from 'vitest';
import {
  MAX_VOID_REASON_LENGTH,
  SALE_VOID_FIELDS,
  readSaleVoid,
  saleVoidFingerprint,
} from './sale-void-input.js';
import { InputReader, ValidationFailedError, type FieldError } from './validation.js';

const OPERATION = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const SHIFT = '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e';
const SALE = '3d4e5f6a-7b8c-4d9e-8f0a-2b3c4d5e6f7a';

const read = (body: unknown) => {
  const reader = new InputReader(body, SALE_VOID_FIELDS);
  const value = readSaleVoid(reader);
  reader.finish();
  return value;
};
const errorsOf = (body: unknown): readonly FieldError[] => {
  try {
    read(body);
    return [];
  } catch (error) {
    if (error instanceof ValidationFailedError) return error.errors;
    throw error;
  }
};
const codes = (errors: readonly FieldError[]) => errors.map((e) => `${e.pointer}:${e.code}`);

const valid = { operationId: OPERATION, shiftId: SHIFT, reason: 'Se equivocó de producto' };

describe('voiding a sale', () => {
  it('reads who asks, from which of their shifts the cash goes back, and why', () => {
    expect(read(valid)).toEqual({
      operationId: OPERATION,
      shiftId: SHIFT,
      reason: 'Se equivocó de producto',
    });
  });

  it('writes the identifiers in lowercase, however they came', () => {
    const value = read({
      ...valid,
      operationId: OPERATION.toUpperCase(),
      shiftId: SHIFT.toUpperCase(),
    });

    expect([value.operationId, value.shiftId]).toEqual([OPERATION, SHIFT]);
  });

  it('can go without a shift: a sale with no cash gives no cash back', () => {
    const { shiftId: _shiftId, ...withoutShift } = valid;

    expect(read(withoutShift).shiftId).toBeNull();
    expect(read({ ...valid, shiftId: null }).shiftId).toBeNull();
  });

  it('keeps the reason trimmed, up to 200 characters and no more', () => {
    expect(read({ ...valid, reason: '  Cliente se arrepintió  ' }).reason).toBe(
      'Cliente se arrepintió',
    );
    expect(read({ ...valid, reason: 'r'.repeat(MAX_VOID_REASON_LENGTH) }).reason).toHaveLength(
      MAX_VOID_REASON_LENGTH,
    );
    expect(codes(errorsOf({ ...valid, reason: 'r'.repeat(MAX_VOID_REASON_LENGTH + 1) }))).toEqual([
      '/reason:too-long',
    ]);
    expect(MAX_VOID_REASON_LENGTH).toBe(200);
  });

  it('wants a reason that says something, one line long', () => {
    expect(codes(errorsOf({ ...valid, reason: '   ' }))).toEqual(['/reason:blank']);
    expect(codes(errorsOf({ operationId: OPERATION, shiftId: SHIFT }))).toEqual([
      '/reason:required',
    ]);
    expect(codes(errorsOf({ ...valid, reason: 'uno\ndos' }))).toEqual([
      '/reason:invalid-characters',
    ]);
    expect(codes(errorsOf({ ...valid, reason: 5 }))).toEqual(['/reason:invalid-type']);
  });

  it('says every problem at once', () => {
    expect(
      codes(errorsOf({ operationId: 'no', shiftId: 'tampoco', reason: '', extra: true })),
    ).toEqual([
      '/extra:unknown-field',
      '/operationId:invalid-id',
      '/shiftId:invalid-id',
      '/reason:blank',
    ]);
  });

  it('knows its fields', () => {
    expect([...SALE_VOID_FIELDS]).toEqual(['operationId', 'shiftId', 'reason']);
  });

  describe('the fingerprint', () => {
    const fingerprint = (body: unknown, sale = SALE) => saleVoidFingerprint(sale, read(body));

    it('is the same for the same request, however it is written, and does not include the operation', () => {
      expect(fingerprint(valid)).toBe(
        fingerprint({
          reason: '  Se equivocó de producto ',
          shiftId: SHIFT.toUpperCase(),
          operationId: SHIFT,
        }),
      );
      expect(fingerprint(valid, SALE)).toBe(fingerprint(valid, SALE.toUpperCase()));
    });

    it.each([
      ['another shift', { shiftId: SALE }],
      ['no shift', { shiftId: null }],
      ['another reason', { reason: 'Otro motivo' }],
    ])('changes with %s', (_name, change) => {
      expect(fingerprint({ ...valid, ...change })).not.toBe(fingerprint(valid));
    });

    it('changes with the sale that is voided', () => {
      expect(fingerprint(valid, OPERATION)).not.toBe(fingerprint(valid));
    });
  });
});
