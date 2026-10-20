import { describe, expect, it } from 'vitest';
import {
  MAX_REVIEW_NOTE_LENGTH,
  SALE_FILTER_FIELDS,
  SALE_REVIEW_FIELDS,
  readSaleFilter,
  readSaleReview,
} from './sale-query-input.js';
import { InputReader, ValidationFailedError, type FieldError } from './validation.js';

const SHIFT = '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e';

const filter = (query: unknown) => {
  const reader = new InputReader(query, SALE_FILTER_FIELDS);
  const value = readSaleFilter(reader);
  reader.finish();
  return value;
};
const review = (body: unknown) => {
  const reader = new InputReader(body, SALE_REVIEW_FIELDS);
  const value = readSaleReview(reader);
  reader.finish();
  return value;
};
const errorsOf = (work: (input: unknown) => unknown, input: unknown): readonly FieldError[] => {
  try {
    work(input);
    return [];
  } catch (error) {
    if (error instanceof ValidationFailedError) return error.errors;
    throw error;
  }
};
const codes = (errors: readonly FieldError[]) => errors.map((e) => `${e.pointer}:${e.code}`);

describe('the filters of the list of sales', () => {
  it('is nothing when nothing is asked, and only what was asked otherwise', () => {
    expect(filter({})).toEqual({});
    expect(filter({ shiftId: SHIFT })).toEqual({ shiftId: SHIFT });
    expect(filter({ attention: 'true' })).toEqual({ attention: true });
    expect(filter({ attention: 'false' })).toEqual({ attention: false });
    expect(filter({ folio: 'AA-000142' })).toEqual({ folio: 'AA-000142' });
  });

  it('reads the shift in lowercase', () => {
    expect(filter({ shiftId: SHIFT.toUpperCase() })).toEqual({ shiftId: SHIFT });
  });

  it('reads the folio the way it is written on the receipt', () => {
    expect(filter({ folio: ' aa-000142 ' })).toEqual({ folio: 'AA-000142' });
  });

  it('can combine all of them', () => {
    expect(filter({ shiftId: SHIFT, attention: 'true', folio: 'K7-000001' })).toEqual({
      shiftId: SHIFT,
      attention: true,
      folio: 'K7-000001',
    });
  });

  it('refuses what is not an identifier, a boolean or a folio, saying only that', () => {
    expect(codes(errorsOf(filter, { shiftId: 'no-es-uno' }))).toEqual(['/shiftId:invalid-id']);
    expect(codes(errorsOf(filter, { attention: 'quizas' }))).toEqual(['/attention:invalid-value']);
    expect(codes(errorsOf(filter, { folio: 'AA-12' }))).toEqual(['/folio:invalid-folio']);
    expect(codes(errorsOf(filter, { folio: '' }))).toEqual(['/folio:blank']);
    expect(codes(errorsOf(filter, { folio: 'A'.repeat(41) }))).toEqual(['/folio:too-long']);
  });

  it.each(['maybe', 'TRUE', 'False', '1', 'yes', 'si'])(
    'accepts only true or false for the tray, not %j',
    (value) => {
      expect(codes(errorsOf(filter, { attention: value }))).toEqual(['/attention:invalid-value']);
    },
  );

  it('says what a folio of the longest size is when it is not one, and only too long when it is longer', () => {
    expect(codes(errorsOf(filter, { folio: 'A'.repeat(40) }))).toEqual(['/folio:invalid-folio']);
    expect(codes(errorsOf(filter, { folio: 'A'.repeat(41) }))).toEqual(['/folio:too-long']);
  });

  it('knows its fields', () => {
    expect([...SALE_FILTER_FIELDS]).toEqual(['shiftId', 'attention', 'folio']);
  });
});

describe('the review of a sale', () => {
  it('can go without a note', () => {
    expect(review({})).toEqual({ note: null });
    expect(review({ note: null })).toEqual({ note: null });
  });

  it('keeps the note, trimmed', () => {
    expect(review({ note: '  Se ajustó el inventario de gaseosas  ' })).toEqual({
      note: 'Se ajustó el inventario de gaseosas',
    });
  });

  it('allows up to 200 characters and no more', () => {
    expect(MAX_REVIEW_NOTE_LENGTH).toBe(200);
    expect(review({ note: 'n'.repeat(200) }).note).toHaveLength(200);
    expect(codes(errorsOf(review, { note: 'n'.repeat(201) }))).toEqual(['/note:too-long']);
  });

  it('refuses a note that is blank or not text, and any field it does not know', () => {
    expect(codes(errorsOf(review, { note: '   ' }))).toEqual(['/note:blank']);
    expect(codes(errorsOf(review, { note: 7 }))).toEqual(['/note:invalid-type']);
    expect(codes(errorsOf(review, { motivo: 'x' }))).toEqual(['/motivo:unknown-field']);
  });

  it('knows its fields', () => {
    expect([...SALE_REVIEW_FIELDS]).toEqual(['note']);
  });
});
