import { describe, expect, it } from 'vitest';
import {
  CASH_MOVEMENT_FIELDS,
  SHIFT_CLOSING_FIELDS,
  SHIFT_OPENING_FIELDS,
  cashMovementFingerprint,
  readCashMovement,
  readShiftClosing,
  readShiftOpening,
  shiftClosingFingerprint,
  shiftOpeningFingerprint,
} from './shift-input.js';
import { InputReader, ValidationFailedError, type FieldError } from './validation.js';

const OPERATION = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const SHIFT = '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e';
const DEVICE = '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f';
const TIME = '2026-10-18T15:00:00.000Z';
const MAX_PESOS = 1_000_000_000_000;

const run = <T>(work: (reader: InputReader) => T, body: unknown, fields: readonly string[]): T => {
  const reader = new InputReader(body, fields);
  const value = work(reader);
  reader.finish();
  return value;
};
const opening = (body: unknown) => run(readShiftOpening, body, SHIFT_OPENING_FIELDS);
const closing = (body: unknown) => run(readShiftClosing, body, SHIFT_CLOSING_FIELDS);
const movement = (body: unknown) => run(readCashMovement, body, CASH_MOVEMENT_FIELDS);

const errorsOf = (work: (body: unknown) => unknown, body: unknown): readonly FieldError[] => {
  try {
    work(body);
    return [];
  } catch (error) {
    if (error instanceof ValidationFailedError) return error.errors;
    throw error;
  }
};
const codes = (errors: readonly FieldError[]) => errors.map((e) => `${e.pointer}:${e.code}`);

const validOpening = {
  operationId: OPERATION,
  shiftId: SHIFT,
  deviceId: DEVICE,
  openingAmount: 50_000,
  deviceTime: TIME,
  clockOffsetMs: 1200,
};

describe('opening a shift', () => {
  it('reads who opens it, where, with how much cash, and when', () => {
    expect(opening(validOpening)).toEqual({
      operationId: OPERATION,
      shiftId: SHIFT,
      deviceId: DEVICE,
      openingAmount: 50_000,
      time: { deviceTime: TIME, clockOffsetMs: 1200 },
    });
  });

  it('writes the identifiers in lowercase, however they came', () => {
    const read = opening({
      ...validOpening,
      operationId: OPERATION.toUpperCase(),
      shiftId: SHIFT.toUpperCase(),
      deviceId: DEVICE.toUpperCase(),
    });

    expect([read.operationId, read.shiftId, read.deviceId]).toEqual([OPERATION, SHIFT, DEVICE]);
  });

  it('opens with no cash, but not with a negative amount or more than the database accepts', () => {
    expect(opening({ ...validOpening, openingAmount: 0 }).openingAmount).toBe(0);
    expect(opening({ ...validOpening, openingAmount: MAX_PESOS }).openingAmount).toBe(MAX_PESOS);
    expect(codes(errorsOf(opening, { ...validOpening, openingAmount: -1 }))).toEqual([
      '/openingAmount:out-of-range',
    ]);
    expect(codes(errorsOf(opening, { ...validOpening, openingAmount: MAX_PESOS + 1 }))).toEqual([
      '/openingAmount:out-of-range',
    ]);
    expect(codes(errorsOf(opening, { ...validOpening, openingAmount: 100.5 }))).toEqual([
      '/openingAmount:invalid-type',
    ]);
  });

  it('reports every missing or wrong field together', () => {
    expect(codes(errorsOf(opening, { shiftId: 'turno', extra: 1 }))).toEqual([
      '/extra:unknown-field',
      '/operationId:required',
      '/shiftId:invalid-id',
      '/deviceId:required',
      '/openingAmount:required',
      '/deviceTime:required',
    ]);
  });
});

describe('closing a shift', () => {
  const validClosing = { operationId: OPERATION, countedAmount: 187_500, deviceTime: TIME };

  it('reads the cash that was counted and when', () => {
    expect(closing({ ...validClosing, clockOffsetMs: null })).toEqual({
      operationId: OPERATION,
      countedAmount: 187_500,
      time: { deviceTime: TIME, clockOffsetMs: null },
    });
  });

  it('accepts a drawer with nothing in it and refuses a negative count', () => {
    expect(closing({ ...validClosing, countedAmount: 0 }).countedAmount).toBe(0);
    expect(codes(errorsOf(closing, { ...validClosing, countedAmount: -5 }))).toEqual([
      '/countedAmount:out-of-range',
    ]);
  });

  it('does not take the shift or the device from the body: the shift is in the address', () => {
    expect(codes(errorsOf(closing, { ...validClosing, shiftId: SHIFT }))).toEqual([
      '/shiftId:unknown-field',
    ]);
  });
});

describe('moving cash outside a sale', () => {
  const validMovement = {
    operationId: OPERATION,
    shiftId: SHIFT,
    direction: 'out',
    amount: 20_000,
    reason: '  Pago al proveedor de bebidas ',
  };

  it('reads the direction, the amount and the reason, which is trimmed', () => {
    expect(movement(validMovement)).toEqual({
      operationId: OPERATION,
      shiftId: SHIFT,
      direction: 'out',
      amount: 20_000,
      reason: 'Pago al proveedor de bebidas',
    });
    expect(movement({ ...validMovement, direction: 'in' }).direction).toBe('in');
  });

  it('refuses a direction that is neither in nor out', () => {
    expect(codes(errorsOf(movement, { ...validMovement, direction: 'sale' }))).toEqual([
      '/direction:invalid-value',
    ]);
    expect(codes(errorsOf(movement, { ...validMovement, direction: undefined }))).toEqual([
      '/direction:required',
    ]);
  });

  it('wants at least one peso, and not more than the database accepts', () => {
    expect(movement({ ...validMovement, amount: 1 }).amount).toBe(1);
    expect(movement({ ...validMovement, amount: MAX_PESOS }).amount).toBe(MAX_PESOS);
    expect(codes(errorsOf(movement, { ...validMovement, amount: 0 }))).toEqual([
      '/amount:out-of-range',
    ]);
    expect(codes(errorsOf(movement, { ...validMovement, amount: MAX_PESOS + 1 }))).toEqual([
      '/amount:out-of-range',
    ]);
  });

  it('wants a reason of up to 200 characters, because a movement without one is a hole in the cash', () => {
    expect(movement({ ...validMovement, reason: 'r'.repeat(200) }).reason).toHaveLength(200);
    expect(codes(errorsOf(movement, { ...validMovement, reason: 'r'.repeat(201) }))).toEqual([
      '/reason:too-long',
    ]);
    expect(codes(errorsOf(movement, { ...validMovement, reason: undefined }))).toEqual([
      '/reason:required',
    ]);
    expect(codes(errorsOf(movement, { ...validMovement, reason: ' ' }))).toEqual(['/reason:blank']);
  });
});

describe('the fingerprint of an operation', () => {
  it('is the same however the body was written, and does not depend on the measured clock', () => {
    const read = opening(validOpening);
    const other = opening({
      deviceTime: TIME,
      openingAmount: 50_000,
      deviceId: DEVICE.toUpperCase(),
      shiftId: SHIFT.toUpperCase(),
      operationId: OPERATION,
      clockOffsetMs: -300,
    });

    expect(shiftOpeningFingerprint(other)).toBe(shiftOpeningFingerprint(read));
  });

  it.each([
    ['another shift', { shiftId: DEVICE }],
    ['another device', { deviceId: SHIFT }],
    ['another opening amount', { openingAmount: 60_000 }],
    ['another time', { deviceTime: '2026-10-18T16:00:00.000Z' }],
  ])('changes with %s when a shift is opened', (_name, change) => {
    expect(shiftOpeningFingerprint(opening({ ...validOpening, ...change }))).not.toBe(
      shiftOpeningFingerprint(opening(validOpening)),
    );
  });

  it('does not include the operation id: it is the key under which it is compared', () => {
    expect(shiftOpeningFingerprint(opening({ ...validOpening, operationId: SHIFT }))).toBe(
      shiftOpeningFingerprint(opening(validOpening)),
    );
  });

  it('tells apart the shift a closing is for, the cash counted and the time', () => {
    const read = closing({ operationId: OPERATION, countedAmount: 100, deviceTime: TIME });
    const fingerprint = (shiftId: string, input = read) => shiftClosingFingerprint(shiftId, input);

    expect(fingerprint(SHIFT)).toBe(fingerprint(SHIFT.toUpperCase()));
    expect(fingerprint(SHIFT)).not.toBe(fingerprint(DEVICE));
    expect(fingerprint(SHIFT)).not.toBe(
      fingerprint(SHIFT, closing({ operationId: OPERATION, countedAmount: 101, deviceTime: TIME })),
    );
    expect(fingerprint(SHIFT)).not.toBe(
      fingerprint(
        SHIFT,
        closing({ operationId: OPERATION, countedAmount: 100, deviceTime: '2026-10-18T16:00:00Z' }),
      ),
    );
  });

  it.each([
    ['another direction', { direction: 'in' }],
    ['another amount', { amount: 20_001 }],
    ['another reason', { reason: 'Otro motivo' }],
    ['another shift', { shiftId: DEVICE }],
  ])('changes with %s when cash is moved', (_name, change) => {
    const base = {
      operationId: OPERATION,
      shiftId: SHIFT,
      direction: 'out',
      amount: 20_000,
      reason: 'Pago',
    };

    expect(cashMovementFingerprint(movement({ ...base, ...change }))).not.toBe(
      cashMovementFingerprint(movement(base)),
    );
  });
});
