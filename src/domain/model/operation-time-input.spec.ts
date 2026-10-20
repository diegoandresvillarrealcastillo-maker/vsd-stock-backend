import { describe, expect, it } from 'vitest';
import {
  OPERATION_TIME_FIELDS,
  readOperationTime,
  resolveReceivedOperation,
} from './operation-time-input.js';
import { InputReader, ValidationFailedError, type FieldError } from './validation.js';

const read = (body: unknown) => {
  const reader = new InputReader(body, OPERATION_TIME_FIELDS);
  const value = readOperationTime(reader);
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

describe('the time an operation says it was made', () => {
  it('reads the time of the device and the difference measured against the server', () => {
    expect(read({ deviceTime: '2026-10-18T15:00:00.000Z', clockOffsetMs: -1500 })).toEqual({
      deviceTime: '2026-10-18T15:00:00.000Z',
      clockOffsetMs: -1500,
    });
  });

  it('reads a missing or null difference as never measured', () => {
    expect(read({ deviceTime: '2026-10-18T15:00:00Z' }).clockOffsetMs).toBeNull();
    expect(
      read({ deviceTime: '2026-10-18T15:00:00Z', clockOffsetMs: null }).clockOffsetMs,
    ).toBeNull();
  });

  it('needs the time of the device', () => {
    expect(errorsOf({}).map((e) => `${e.pointer}:${e.code}`)).toEqual(['/deviceTime:required']);
    expect(errorsOf({ deviceTime: '  ' }).map((e) => `${e.pointer}:${e.code}`)).toEqual([
      '/deviceTime:blank',
    ]);
  });

  it('does not reject a time that is not a time: the operation already happened and is flagged later', () => {
    expect(read({ deviceTime: 'ayer por la tarde' }).deviceTime).toBe('ayer por la tarde');
  });

  it('accepts a time of exactly 40 characters', () => {
    expect(read({ deviceTime: 'x'.repeat(40) }).deviceTime).toHaveLength(40);
  });

  it('refuses a time of more than 40 characters, which is not a clock', () => {
    expect(errorsOf({ deviceTime: 'x'.repeat(41) }).map((e) => e.code)).toEqual(['too-long']);
  });

  it('accepts a difference of a year and refuses more, or one that is not a whole number', () => {
    const year = 366 * 24 * 60 * 60 * 1000;
    expect(read({ deviceTime: 'x', clockOffsetMs: year }).clockOffsetMs).toBe(year);
    expect(read({ deviceTime: 'x', clockOffsetMs: -year }).clockOffsetMs).toBe(-year);
    expect(errorsOf({ deviceTime: 'x', clockOffsetMs: year + 1 }).map((e) => e.code)).toEqual([
      'out-of-range',
    ]);
    expect(errorsOf({ deviceTime: 'x', clockOffsetMs: 1.5 }).map((e) => e.code)).toEqual([
      'invalid-type',
    ]);
    expect(errorsOf({ deviceTime: 'x', clockOffsetMs: '10' }).map((e) => e.code)).toEqual([
      'invalid-type',
    ]);
  });
});

describe('what the server keeps of the time of an operation', () => {
  const received = new Date('2026-10-18T15:00:00.000Z');

  it('corrects the clock of the device and keeps what the device said', () => {
    const resolved = resolveReceivedOperation(
      { deviceTime: '2026-10-18T14:59:50.000Z', clockOffsetMs: 4000 },
      received,
    );

    expect(resolved).toEqual({
      occurredAt: new Date('2026-10-18T14:59:54.000Z'),
      receivedAt: received,
      deviceTimeRaw: '2026-10-18T14:59:50.000Z',
      source: 'corrected',
      flags: [],
    });
  });

  it('flags a clock that was never measured, and trusts it', () => {
    const resolved = resolveReceivedOperation(
      { deviceTime: '2026-10-18T14:00:00.000Z', clockOffsetMs: null },
      received,
    );

    expect(resolved).toMatchObject({
      occurredAt: new Date('2026-10-18T14:00:00.000Z'),
      source: 'device',
      flags: ['clock-unverified'],
    });
  });

  it('never accepts a time after the moment the server heard of it', () => {
    const resolved = resolveReceivedOperation(
      { deviceTime: '2026-10-18T16:00:00.000Z', clockOffsetMs: 0 },
      received,
    );

    expect(resolved).toMatchObject({ occurredAt: received, source: 'received', flags: ['future'] });
  });

  it('keeps what the device said even when it can not be read, and uses the moment it arrived', () => {
    const resolved = resolveReceivedOperation(
      { deviceTime: 'ayer', clockOffsetMs: null },
      received,
    );

    expect(resolved).toMatchObject({
      occurredAt: received,
      deviceTimeRaw: 'ayer',
      source: 'received',
      flags: ['unreadable'],
    });
  });

  it('flags an operation that waited more than 72 hours in the device', () => {
    const resolved = resolveReceivedOperation(
      { deviceTime: '2026-10-10T15:00:00.000Z', clockOffsetMs: 0 },
      received,
    );

    expect(resolved.flags).toEqual(['stale']);
  });
});
