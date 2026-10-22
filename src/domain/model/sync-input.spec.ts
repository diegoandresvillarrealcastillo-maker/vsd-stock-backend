import { describe, expect, it } from 'vitest';
import {
  COPY_FIELDS,
  MAX_SYNC_OPERATIONS,
  SYNC_FIELDS,
  SYNC_KINDS,
  readCopySince,
  readSyncBatch,
  type SyncItem,
} from './sync-input.js';
import { InputReader, ValidationFailedError, type FieldError } from './validation.js';

const OPERATION = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const SHIFT = '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e';

const batch = (body: unknown): readonly SyncItem[] => {
  const reader = new InputReader(body, SYNC_FIELDS);
  const items = readSyncBatch(reader);
  reader.finish();
  return items;
};
const errorsOf = (work: () => unknown): readonly FieldError[] => {
  try {
    work();
    return [];
  } catch (error) {
    if (error instanceof ValidationFailedError) return error.errors;
    throw error;
  }
};
const codes = (errors: readonly FieldError[]) => errors.map((e) => `${e.pointer}:${e.code}`);

const sale = { kind: 'sale', body: { operationId: OPERATION, folio: 'AA-000001' } };

describe('the batch that a device sends', () => {
  it('knows the three things that can be done without a connection, and nothing else', () => {
    expect([...SYNC_KINDS]).toEqual(['shift-open', 'shift-close', 'sale']);
    expect([...SYNC_FIELDS]).toEqual(['operations']);
    expect(MAX_SYNC_OPERATIONS).toBe(50);
  });

  it('reads each operation with its kind and exactly the body that the single route takes', () => {
    const items = batch({
      operations: [
        sale,
        { kind: 'shift-open', body: { operationId: SHIFT } },
        { kind: 'shift-close', shiftId: SHIFT, body: { operationId: OPERATION } },
      ],
    });

    expect(items).toEqual([
      { valid: true, kind: 'sale', shiftId: null, body: sale.body, operationId: OPERATION },
      {
        valid: true,
        kind: 'shift-open',
        shiftId: null,
        body: { operationId: SHIFT },
        operationId: SHIFT,
      },
      {
        valid: true,
        kind: 'shift-close',
        shiftId: SHIFT,
        body: { operationId: OPERATION },
        operationId: OPERATION,
      },
    ]);
  });

  it('keeps the order in which they came', () => {
    const items = batch({
      operations: [1, 2, 3].map((n) => ({
        kind: 'sale',
        body: { operationId: `00000000-0000-4000-8000-00000000000${String(n)}` },
      })),
    });

    expect(items.map((item) => item.operationId?.slice(-1))).toEqual(['1', '2', '3']);
  });

  it('writes the identifiers of the shift and of the operation in lowercase', () => {
    const [item] = batch({
      operations: [
        {
          kind: 'shift-close',
          shiftId: SHIFT.toUpperCase(),
          body: { operationId: OPERATION.toUpperCase() },
        },
      ],
    });

    expect(item).toMatchObject({ shiftId: SHIFT, operationId: OPERATION });
  });

  describe('the whole request', () => {
    it('wants a list of one to fifty operations', () => {
      expect(codes(errorsOf(() => batch({})))).toEqual(['/operations:required']);
      expect(codes(errorsOf(() => batch({ operations: [] })))).toEqual(['/operations:too-few']);
      expect(codes(errorsOf(() => batch({ operations: 'no' })))).toEqual([
        '/operations:invalid-type',
      ]);
      expect(
        codes(errorsOf(() => batch({ operations: Array.from({ length: 51 }, () => sale) }))),
      ).toEqual(['/operations:too-many']);
      expect(batch({ operations: Array.from({ length: 50 }, () => sale) })).toHaveLength(50);
    });

    it('refuses a field that it does not know, and a body that is not an object', () => {
      expect(codes(errorsOf(() => batch({ operations: [sale], extra: 1 })))).toEqual([
        '/extra:unknown-field',
      ]);
      expect(errorsOf(() => batch([sale])).length).toBeGreaterThan(0);
      expect(errorsOf(() => batch(null)).length).toBeGreaterThan(0);
    });
  });

  describe('one operation that is not right does not spoil the others', () => {
    const invalid = (operation: unknown) => {
      const [item] = batch({ operations: [operation] });
      if (item?.valid !== false) throw new Error('The operation was expected to be refused');
      return item;
    };

    it('says what is wrong with its kind, saying it for the operation and not for the batch', () => {
      const item = invalid({ kind: 'void', body: { operationId: OPERATION } });

      expect(codes(item.errors)).toEqual(['/kind:invalid-value']);
      expect(item.operationId).toBe(OPERATION);
    });

    it('says what is wrong with its body', () => {
      expect(codes(invalid({ kind: 'sale' }).errors)).toEqual(['/body:required']);
      expect(codes(invalid({ kind: 'sale', body: 5 }).errors)).toEqual(['/body:invalid-type']);
      expect(codes(invalid({ kind: 'sale', body: [] }).errors)).toEqual(['/body:invalid-type']);
    });

    it('wants the shift to close, only to close one', () => {
      expect(codes(invalid({ kind: 'shift-close', body: {} }).errors)).toEqual([
        '/shiftId:required',
      ]);
      expect(codes(invalid({ kind: 'shift-close', shiftId: 'no', body: {} }).errors)).toEqual([
        '/shiftId:invalid-id',
      ]);
      expect(codes(invalid({ kind: 'sale', shiftId: SHIFT, body: {} }).errors)).toEqual([
        '/shiftId:unknown-field',
      ]);
      expect(codes(invalid({ kind: 'shift-open', shiftId: SHIFT, body: {} }).errors)).toEqual([
        '/shiftId:unknown-field',
      ]);
    });

    it('says every problem of the operation at once, and refuses fields it does not know', () => {
      const item = invalid({ kind: 'nada', shiftId: 5, body: 'no', extra: true });

      expect(codes(item.errors)).toEqual([
        '/extra:unknown-field',
        '/kind:invalid-value',
        '/body:invalid-type',
        '/shiftId:unknown-field',
      ]);
    });

    it('is refused when it is not even an object', () => {
      for (const operation of [null, 5, 'sale', []]) {
        expect(invalid(operation).errors.length).toBeGreaterThan(0);
      }
    });

    it('is refused when its body is nothing, a list or a text: the body is an object', () => {
      for (const body of [null, [], 'no', 5]) {
        expect(codes(invalid({ kind: 'sale', body }).errors)).toEqual(['/body:invalid-type']);
      }
    });

    it('does not guess the operation id of what it can not read', () => {
      expect(
        invalid({ kind: 'void', body: { operationId: 'no-es-un-id' } }).operationId,
      ).toBeNull();
      expect(invalid({ kind: 'void', body: { operationId: 5 } }).operationId).toBeNull();
      expect(invalid({ kind: 'void', body: 'no' }).operationId).toBeNull();
      expect(invalid(7).operationId).toBeNull();
    });

    it('leaves the good ones of the same batch as they are', () => {
      const items = batch({ operations: [sale, { kind: 'void', body: {} }, sale] });

      expect(items.map((item) => item.valid)).toEqual([true, false, true]);
    });
  });
});

describe('the read copy', () => {
  const since = (value: unknown) => {
    const reader = new InputReader({ since: value }, COPY_FIELDS);
    const date = readCopySince(reader);
    reader.finish();
    return date;
  };

  it('knows the parameters of a download', () => {
    expect([...COPY_FIELDS]).toEqual(['since', 'limit', 'cursor']);
  });

  it('is everything when nothing is asked: no since', () => {
    const reader = new InputReader({}, COPY_FIELDS);

    expect(readCopySince(reader)).toBeUndefined();
    expect(() => reader.finish()).not.toThrow();
  });

  it('reads the instant as the device writes it, with or without milliseconds', () => {
    expect(since('2026-10-18T15:00:00.123Z')?.toISOString()).toBe('2026-10-18T15:00:00.123Z');
    expect(since('2026-10-18T15:00:00Z')?.toISOString()).toBe('2026-10-18T15:00:00.000Z');
  });

  it.each([
    '2026-10-18',
    '2026-10-18T15:00:00',
    '2026-10-18T15:00:00+02:00',
    '2026-02-30T15:00:00.000Z',
    '2026-10-18T25:00:00.000Z',
    'ayer',
    '',
  ])('does not accept %j as an instant', (value) => {
    expect(codes(errorsOf(() => since(value)))).toEqual(['/since:invalid-moment']);
  });

  it('does not accept something that is not text', () => {
    expect(codes(errorsOf(() => since(5)))).toEqual(['/since:invalid-moment']);
  });
});
