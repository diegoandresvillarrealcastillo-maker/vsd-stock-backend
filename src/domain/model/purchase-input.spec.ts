import { describe, expect, it } from 'vitest';
import {
  MAX_PURCHASE_LINES,
  PURCHASE_FIELDS,
  purchaseFingerprint,
  readPurchase,
  type PurchaseInput,
} from './purchase-input.js';
import { InputReader, ValidationFailedError, type FieldError } from './validation.js';

const OPERATION = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const SUPPLIER = '33333333-3333-4333-8333-333333333333';
const P1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const P2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const P3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const line = (productId = P1, quantityMilli = 5000, unitCost = 2500) => ({
  productId,
  quantityMilli,
  unitCost,
});
const body = (overrides: Record<string, unknown> = {}) => ({
  operationId: OPERATION,
  lines: [line()],
  ...overrides,
});

const read = (input: unknown): PurchaseInput => {
  const reader = new InputReader(input, PURCHASE_FIELDS);
  const purchase = readPurchase(reader);
  reader.finish();
  return purchase;
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

describe('a purchase', () => {
  it('needs an operation id and at least one line; the supplier and the note are optional', () => {
    expect(read(body())).toEqual({
      operationId: OPERATION,
      supplierId: null,
      note: null,
      lines: [{ productId: P1, quantityMilli: 5000, unitCost: 2500 }],
    });
  });

  it('takes the supplier, the note and several lines', () => {
    const purchase = read(
      body({
        supplierId: SUPPLIER,
        note: '  Pedido de octubre ',
        lines: [line(P1), line(P2, 1500, 0)],
      }),
    );

    expect(purchase.supplierId).toBe(SUPPLIER);
    expect(purchase.note).toBe('Pedido de octubre');
    expect(purchase.lines).toEqual([
      { productId: P1, quantityMilli: 5000, unitCost: 2500 },
      { productId: P2, quantityMilli: 1500, unitCost: 0 },
    ]);
  });

  it('reads null as no supplier and no note', () => {
    const purchase = read(body({ supplierId: null, note: null }));

    expect(purchase.supplierId).toBeNull();
    expect(purchase.note).toBeNull();
  });

  it('writes the identifiers in lower case, so two spellings of one id are one id', () => {
    const purchase = read(
      body({
        operationId: OPERATION.toUpperCase(),
        supplierId: SUPPLIER.toUpperCase(),
        lines: [line(P1.toUpperCase())],
      }),
    );

    expect(purchase.operationId).toBe(OPERATION);
    expect(purchase.supplierId).toBe(SUPPLIER);
    expect(purchase.lines[0]?.productId).toBe(P1);
  });

  it('accepts as many lines as the limit and refuses one more', () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        line(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`),
      );

    expect(MAX_PURCHASE_LINES).toBe(200);
    expect(read(body({ lines: many(200) })).lines).toHaveLength(200);
    expect(pointers(body({ lines: many(201) }))).toEqual(['/lines:too-many']);
  });

  it('refuses an empty list of lines', () => {
    expect(pointers(body({ lines: [] }))).toEqual(['/lines:too-few']);
  });

  it('says what is missing, every field at once', () => {
    expect(pointers({})).toEqual(['/operationId:required', '/lines:required']);
  });

  it.each(['no-es-uuid', 5, null])('refuses the operation id %j', (operationId) => {
    expect(pointers(body({ operationId }))).toEqual([
      '/operationId:' + (typeof operationId === 'string' ? 'invalid-id' : 'invalid-type'),
    ]);
  });

  it('accepts a note of 500 characters and refuses one of 501', () => {
    expect(read(body({ note: 'n'.repeat(500) })).note).toHaveLength(500);
    expect(errorsOf(body({ note: 'n'.repeat(501) }))).toEqual([
      { pointer: '/note', code: 'too-long', detail: 'La nota no puede pasar de 500 caracteres.' },
    ]);
  });

  it('refuses a blank note: «none» is null', () => {
    expect(pointers(body({ note: '  ' }))).toEqual(['/note:blank']);
  });

  describe('each line', () => {
    it('points at the exact line and field that fail', () => {
      expect(
        pointers(
          body({
            lines: [line(), { productId: 'x', quantityMilli: 0, unitCost: -1 }, line(P2, 1.5, 5)],
          }),
        ),
      ).toEqual([
        '/lines/1/productId:invalid-id',
        '/lines/1/quantityMilli:out-of-range',
        '/lines/1/unitCost:out-of-range',
        '/lines/2/quantityMilli:invalid-type',
      ]);
    });

    it('accepts the smallest and the largest quantity, and refuses the ones just outside', () => {
      expect(read(body({ lines: [line(P1, 1)] })).lines[0]?.quantityMilli).toBe(1);
      expect(read(body({ lines: [line(P1, 1_000_000_000)] })).lines[0]?.quantityMilli).toBe(
        1_000_000_000,
      );
      expect(pointers(body({ lines: [line(P1, 0)] }))).toEqual([
        '/lines/0/quantityMilli:out-of-range',
      ]);
      expect(pointers(body({ lines: [line(P1, 1_000_000_001)] }))).toEqual([
        '/lines/0/quantityMilli:out-of-range',
      ]);
    });

    it('accepts a cost of zero and of a thousand billion pesos, and refuses the ones just outside', () => {
      expect(read(body({ lines: [line(P1, 1000, 0)] })).lines[0]?.unitCost).toBe(0);
      expect(read(body({ lines: [line(P1, 1000, 1_000_000_000_000)] })).lines[0]?.unitCost).toBe(
        1_000_000_000_000,
      );
      expect(pointers(body({ lines: [line(P1, 1000, -1)] }))).toEqual([
        '/lines/0/unitCost:out-of-range',
      ]);
      expect(pointers(body({ lines: [line(P1, 1000, 1_000_000_000_001)] }))).toEqual([
        '/lines/0/unitCost:out-of-range',
      ]);
    });

    it('refuses a line that is not an object, and a field it does not know', () => {
      expect(pointers(body({ lines: ['texto'] }))).toEqual(['/lines/0:invalid-type']);
      expect(pointers(body({ lines: [{ ...line(), color: 'rojo' }] }))).toEqual([
        '/lines/0/color:unknown-field',
      ]);
    });

    it('refuses the same product twice, pointing at the second line, because the lines add up in one', () => {
      expect(errorsOf(body({ lines: [line(P1), line(P2), line(P1, 100, 9)] }))).toEqual([
        {
          pointer: '/lines/2/productId',
          code: 'duplicate-product',
          detail: 'Este producto ya está en otra línea: junta las cantidades en una sola.',
        },
      ]);
    });

    it('sees a duplicate also when the ids are written in different case', () => {
      expect(pointers(body({ lines: [line(P1), line(P1.toUpperCase())] }))).toEqual([
        '/lines/1/productId:duplicate-product',
      ]);
    });

    it('does not call a product a duplicate when its id was already refused', () => {
      expect(pointers(body({ lines: [line('x'), line('x')] }))).toEqual([
        '/lines/0/productId:invalid-id',
        '/lines/1/productId:invalid-id',
      ]);
    });
  });

  it('refuses a field it does not know', () => {
    expect(pointers(body({ total: 5 }))).toEqual(['/total:unknown-field']);
  });
});

describe('the fingerprint of a purchase', () => {
  const base = read(
    body({ supplierId: SUPPLIER, note: 'x', lines: [line(P1), line(P2, 1500, 100)] }),
  );

  it('is the same text for the same purchase', () => {
    expect(purchaseFingerprint(base)).toBe(
      purchaseFingerprint(
        read(body({ supplierId: SUPPLIER, note: 'x', lines: [line(P1), line(P2, 1500, 100)] })),
      ),
    );
  });

  it('does not depend on how the body was written: the order of its keys or the case of its ids', () => {
    const reordered = read({
      lines: [
        { unitCost: 2500, quantityMilli: 5000, productId: P1.toUpperCase() },
        { unitCost: 100, productId: P2, quantityMilli: 1500 },
      ],
      note: '  x ',
      operationId: OPERATION,
      supplierId: SUPPLIER,
    });

    expect(purchaseFingerprint(reordered)).toBe(purchaseFingerprint(base));
  });

  it('does not include the operation id: that is the key it is compared under', () => {
    const other = read(
      body({
        operationId: '99999999-9999-4999-8999-999999999999',
        supplierId: SUPPLIER,
        note: 'x',
        lines: [line(P1), line(P2, 1500, 100)],
      }),
    );

    expect(purchaseFingerprint(other)).toBe(purchaseFingerprint(base));
  });

  it.each([
    ['the supplier', { supplierId: null }],
    ['the note', { note: 'otra' }],
    ['a quantity', { lines: [line(P1, 5001), line(P2, 1500, 100)] }],
    ['a cost', { lines: [line(P1, 5000, 2501), line(P2, 1500, 100)] }],
    ['a product', { lines: [line(P3), line(P2, 1500, 100)] }],
    ['the order of the lines', { lines: [line(P2, 1500, 100), line(P1)] }],
    ['a line less', { lines: [line(P1)] }],
  ])('changes when %s changes', (_name, change) => {
    const changed = read(
      body({ supplierId: SUPPLIER, note: 'x', lines: [line(P1), line(P2, 1500, 100)], ...change }),
    );

    expect(purchaseFingerprint(changed)).not.toBe(purchaseFingerprint(base));
  });

  it('tells a note from no note, and an empty-looking note from both', () => {
    const none = read(body({ note: null }));
    const some = read(body({ note: 'null' }));

    expect(purchaseFingerprint(none)).not.toBe(purchaseFingerprint(some));
  });
});
