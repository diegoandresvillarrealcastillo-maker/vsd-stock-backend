import { describe, expect, it } from 'vitest';
import {
  MAX_PAYMENTS,
  MAX_SALE_LINES,
  PAYMENT_FIELDS,
  SALE_FIELDS,
  SALE_LINE_FIELDS,
  readSale,
  saleFingerprint,
} from './sale-input.js';
import { InputReader, ValidationFailedError, type FieldError } from './validation.js';

const OPERATION = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const SHIFT = '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e';
const COLA = '3d4e5f6a-7b8c-4d9e-8f0a-2b3c4d5e6f7a';
const BREAD = '4e5f6a7b-8c9d-4e0f-9a1b-3c4d5e6f7a8b';
const TIME = '2026-10-18T15:00:00.000Z';
const MAX_PESOS = 1_000_000_000_000;

const sale = (body: unknown) => {
  const reader = new InputReader(body, SALE_FIELDS);
  const value = readSale(reader);
  reader.finish();
  return value;
};

const errorsOf = (body: unknown): readonly FieldError[] => {
  try {
    sale(body);
    return [];
  } catch (error) {
    if (error instanceof ValidationFailedError) return error.errors;
    throw error;
  }
};
const codes = (errors: readonly FieldError[]) => errors.map((e) => `${e.pointer}:${e.code}`);

/** 2 gaseosas a 3.500 con IVA general y 1,5 de pan a 4.000 sin IVA: 7.000 + 6.000 = 13.000. */
const valid = {
  operationId: OPERATION,
  shiftId: SHIFT,
  folio: 'AA-000142',
  total: 13_000,
  lines: [
    { productId: COLA, quantityMilli: 2_000, unitPrice: 3_500, discount: 0, taxRateBp: 1900 },
    { productId: BREAD, quantityMilli: 1_500, unitPrice: 4_000, discount: 0, taxRateBp: 0 },
  ],
  payments: [
    { method: 'cash', amount: 10_000 },
    { method: 'card', amount: 3_000, reference: 'aprobacion 77123' },
  ],
  deviceTime: TIME,
  clockOffsetMs: 1_200,
};

describe('reading a sale', () => {
  it('reads who sold what, with which folio, how it was paid and when', () => {
    const read = sale(valid);

    expect(read).toMatchObject({
      operationId: OPERATION,
      shiftId: SHIFT,
      folio: 'AA-000142',
      folioDevice: 'AA',
      claimedTotal: 13_000,
      lines: [
        { productId: COLA, quantityMilli: 2_000, unitPrice: 3_500, discount: 0, taxRateBp: 1900 },
        { productId: BREAD, quantityMilli: 1_500, unitPrice: 4_000, discount: 0, taxRateBp: 0 },
      ],
      payments: [
        { method: 'cash', amount: 10_000, reference: null },
        { method: 'card', amount: 3_000, reference: 'aprobacion 77123' },
      ],
      time: { deviceTime: TIME, clockOffsetMs: 1_200 },
    });
  });

  it('calculates the total again, with the same calculation as the device, and splits the tax', () => {
    const { summary } = sale(valid);

    expect(summary.total.amount).toBe(13_000);
    expect(
      summary.byRate.map((row) => [row.rateBp, row.total.amount, row.base.amount, row.tax.amount]),
    ).toEqual([
      [0, 6_000, 6_000, 0],
      [1900, 7_000, 5_882, 1_118],
    ]);
  });

  it('respects a discount in the price of a line', () => {
    const read = sale({
      ...valid,
      total: 12_500,
      lines: [{ ...valid.lines[0], discount: 500 }, valid.lines[1]],
    });

    expect(read.summary.total.amount).toBe(12_500);
  });

  it('writes the identifiers in lowercase and the folio the way it is written on the receipt', () => {
    const read = sale({
      ...valid,
      operationId: OPERATION.toUpperCase(),
      shiftId: SHIFT.toUpperCase(),
      folio: ' aa-000142 ',
      lines: [{ ...valid.lines[0], productId: COLA.toUpperCase() }, valid.lines[1]],
    });

    expect(read.operationId).toBe(OPERATION);
    expect(read.shiftId).toBe(SHIFT);
    expect(read.folio).toBe('AA-000142');
    expect(read.lines[0]?.productId).toBe(COLA);
  });

  it('lets the same product appear in two lines, because each may have its own price or discount', () => {
    const read = sale({
      ...valid,
      total: 6_000,
      lines: [
        { productId: COLA, quantityMilli: 1_000, unitPrice: 3_500, discount: 0, taxRateBp: 1900 },
        {
          productId: COLA,
          quantityMilli: 1_000,
          unitPrice: 3_500,
          discount: 1_000,
          taxRateBp: 1900,
        },
      ],
      payments: [{ method: 'cash', amount: 6_000 }],
    });

    expect(read.lines).toHaveLength(2);
    expect(read.summary.total.amount).toBe(6_000);
  });

  it('reads a sale of nothing paid with nothing, such as a gift', () => {
    const read = sale({
      ...valid,
      total: 0,
      lines: [{ ...valid.lines[0], discount: 7_000 }],
      payments: [],
    });

    expect(read.summary.total.amount).toBe(0);
    expect(read.payments).toEqual([]);
  });

  it('does not take anything the device was not asked for', () => {
    expect(codes(errorsOf({ ...valid, deviceId: SHIFT }))).toEqual(['/deviceId:unknown-field']);
    expect(
      codes(
        errorsOf({ ...valid, lines: [{ ...valid.lines[0], name: 'Gaseosa' }, valid.lines[1]] }),
      ),
    ).toEqual(['/lines/0/name:unknown-field']);
    expect(
      codes(errorsOf({ ...valid, payments: [{ method: 'cash', amount: 13_000, change: 0 }] })),
    ).toEqual(['/payments/0/change:unknown-field']);
  });

  it('knows its fields', () => {
    expect(SALE_FIELDS).toEqual([
      'operationId',
      'shiftId',
      'folio',
      'total',
      'lines',
      'payments',
      'deviceTime',
      'clockOffsetMs',
    ]);
    expect(SALE_LINE_FIELDS).toEqual([
      'productId',
      'quantityMilli',
      'unitPrice',
      'discount',
      'taxRateBp',
    ]);
    expect(PAYMENT_FIELDS).toEqual(['method', 'amount', 'reference']);
  });
});

describe('the folio of a sale', () => {
  it.each(['AA', 'AA-', 'AA-12', 'AA-0001420', '00-000142', 'AAAAA-000142', 'AA 000142'])(
    'refuses %j, which is not a folio',
    (folio) => {
      expect(codes(errorsOf({ ...valid, folio }))).toEqual(['/folio:invalid-folio']);
    },
  );

  it('wants a folio, and says only that when it is missing, blank or too long', () => {
    expect(codes(errorsOf({ ...valid, folio: undefined }))).toEqual(['/folio:required']);
    expect(codes(errorsOf({ ...valid, folio: '' }))).toEqual(['/folio:blank']);
    expect(codes(errorsOf({ ...valid, folio: 'A'.repeat(41) }))).toEqual(['/folio:too-long']);
    // Hasta cuarenta caracteres es un texto que se lee; que sea un folio ya es otra pregunta.
    expect(codes(errorsOf({ ...valid, folio: 'A'.repeat(40) }))).toEqual(['/folio:invalid-folio']);
  });
});

describe('the lines of a sale', () => {
  it('wants at least one and at most 200', () => {
    expect(codes(errorsOf({ ...valid, lines: [] }))).toEqual(['/lines:too-few']);
    expect(MAX_SALE_LINES).toBe(200);
    const many = Array.from({ length: MAX_SALE_LINES }, () => ({
      productId: COLA,
      quantityMilli: 1_000,
      unitPrice: 100,
      discount: 0,
      taxRateBp: 0,
    }));
    expect(sale({ ...valid, total: 20_000, lines: many }).lines).toHaveLength(MAX_SALE_LINES);
    expect(codes(errorsOf({ ...valid, lines: [...many, many[0]] }))).toEqual(['/lines:too-many']);
  });

  it('wants a quantity of at least a thousandth and at most a million units', () => {
    const line = (quantityMilli: unknown) => ({ ...valid.lines[0], quantityMilli });

    expect(codes(errorsOf({ ...valid, lines: [line(0)] }))).toContain(
      '/lines/0/quantityMilli:out-of-range',
    );
    expect(codes(errorsOf({ ...valid, lines: [line(1_000_000_001)] }))).toContain(
      '/lines/0/quantityMilli:out-of-range',
    );
    expect(codes(errorsOf({ ...valid, lines: [line(1.5)] }))).toContain(
      '/lines/0/quantityMilli:invalid-type',
    );
    expect(
      sale({
        ...valid,
        total: 1,
        lines: [{ ...line(1), unitPrice: 1_000 }],
        payments: [{ method: 'cash', amount: 1 }],
      }).lines[0]?.quantityMilli,
    ).toBe(1);
  });

  it('accepts a price of nothing and refuses a negative one', () => {
    const line = (unitPrice: unknown) => ({ ...valid.lines[0], unitPrice });

    expect(
      sale({
        ...valid,
        total: 6_000,
        lines: [line(0), valid.lines[1]],
        payments: [{ method: 'cash', amount: 6_000 }],
      }).summary.total.amount,
    ).toBe(6_000);
    expect(codes(errorsOf({ ...valid, lines: [line(-1), valid.lines[1]] }))).toContain(
      '/lines/0/unitPrice:out-of-range',
    );
  });

  it('refuses a discount that is negative or larger than the line', () => {
    const line = (discount: unknown) => ({ ...valid.lines[0], discount });

    expect(codes(errorsOf({ ...valid, lines: [line(-1), valid.lines[1]] }))).toEqual([
      '/lines/0/discount:out-of-range',
    ]);
    expect(codes(errorsOf({ ...valid, lines: [line(7_001), valid.lines[1]] }))).toEqual([
      '/lines/0/discount:discount-too-large',
    ]);
    expect(
      sale({
        ...valid,
        total: 6_000,
        lines: [line(7_000), valid.lines[1]],
        payments: [{ method: 'cash', amount: 6_000 }],
      }).summary.total.amount,
    ).toBe(6_000);
  });

  it('knows only the tax rates of the catalog', () => {
    const line = (taxRateBp: unknown) => ({ ...valid.lines[0], taxRateBp });

    expect(codes(errorsOf({ ...valid, lines: [line(1_000), valid.lines[1]] }))).toEqual([
      '/lines/0/taxRateBp:invalid-value',
    ]);
    for (const rate of [0, 500, 1900]) {
      expect(sale({ ...valid, lines: [line(rate), valid.lines[1]] }).lines[0]?.taxRateBp).toBe(
        rate,
      );
    }
  });

  it('says only what is wrong with a line, not what follows from it', () => {
    const broken = (change: Record<string, unknown>) => ({ ...valid.lines[0], ...change });

    // Sin precio valido no se puede saber si la rebaja pasa del valor de la linea.
    expect(
      codes(
        errorsOf({ ...valid, lines: [broken({ unitPrice: -1, discount: 500 }), valid.lines[1]] }),
      ),
    ).toEqual(['/lines/0/unitPrice:out-of-range']);
    // Una tarifa que falta se dice una vez, no tambien como una tarifa desconocida.
    expect(
      codes(errorsOf({ ...valid, lines: [broken({ taxRateBp: undefined }), valid.lines[1]] })),
    ).toEqual(['/lines/0/taxRateBp:required']);
    // Una linea mala no hace que el total de las demas parezca demasiado grande.
    const huge = { ...valid.lines[0], unitPrice: MAX_PESOS, quantityMilli: 1_000 };
    expect(
      codes(errorsOf({ ...valid, lines: [huge, huge, broken({ quantityMilli: 0 })] })),
    ).toEqual(['/lines/2/quantityMilli:out-of-range']);
  });

  it('refuses a line that costs more than the database can keep, and a sale that adds up to more', () => {
    const huge = { ...valid.lines[0], unitPrice: MAX_PESOS, quantityMilli: 2_000 };
    expect(codes(errorsOf({ ...valid, lines: [huge, valid.lines[1]] }))).toEqual([
      '/lines/0/unitPrice:line-too-large',
    ]);

    const big = { ...valid.lines[0], unitPrice: MAX_PESOS, quantityMilli: 1_000 };
    expect(codes(errorsOf({ ...valid, total: 1, lines: [big, big] }))).toEqual([
      '/lines:total-too-large',
    ]);
  });
});

describe('the payments of a sale', () => {
  it('knows cash, card and transfer', () => {
    for (const method of ['cash', 'card', 'transfer']) {
      expect(sale({ ...valid, payments: [{ method, amount: 13_000 }] }).payments[0]?.method).toBe(
        method,
      );
    }
    expect(codes(errorsOf({ ...valid, payments: [{ method: 'check', amount: 13_000 }] }))).toEqual([
      '/payments/0/method:invalid-value',
    ]);
  });

  it('wants at least a peso in each, and not more than the database accepts', () => {
    expect(codes(errorsOf({ ...valid, payments: [{ method: 'cash', amount: 0 }] }))).toEqual([
      '/payments/0/amount:out-of-range',
    ]);
    expect(
      codes(errorsOf({ ...valid, payments: [{ method: 'cash', amount: MAX_PESOS + 1 }] })),
    ).toEqual(['/payments/0/amount:out-of-range']);
    expect(
      sale({ ...valid, payments: [{ method: 'cash', amount: MAX_PESOS }] }).payments[0]?.amount,
    ).toBe(MAX_PESOS);
  });

  it('keeps a reference of up to 100 characters, trimmed, and none when there is none', () => {
    const paid = (reference: unknown) => ({
      ...valid,
      payments: [{ method: 'card', amount: 13_000, reference }],
    });

    expect(sale(paid('  voucher 9921 ')).payments[0]?.reference).toBe('voucher 9921');
    expect(sale(paid(null)).payments[0]?.reference).toBeNull();
    expect(sale(paid(undefined)).payments[0]?.reference).toBeNull();
    expect(sale(paid('r'.repeat(100))).payments[0]?.reference).toHaveLength(100);
    expect(codes(errorsOf(paid('r'.repeat(101))))).toEqual(['/payments/0/reference:too-long']);
  });

  it('allows at most ten', () => {
    expect(MAX_PAYMENTS).toBe(10);
    const payment = { method: 'cash', amount: 1_300 };
    expect(
      sale({ ...valid, payments: Array.from({ length: 10 }, () => payment) }).payments,
    ).toHaveLength(10);
    expect(
      codes(errorsOf({ ...valid, payments: Array.from({ length: 11 }, () => payment) })),
    ).toEqual(['/payments:too-many']);
  });

  it('does not decide whether they add up to the total: the server notes it and the sale stands', () => {
    expect(sale({ ...valid, payments: [{ method: 'cash', amount: 1 }] }).payments).toHaveLength(1);
  });
});

describe('the total that the device charged', () => {
  it('is read as sent, even when it does not match the lines', () => {
    expect(sale({ ...valid, total: 99 }).claimedTotal).toBe(99);
  });

  it('is a whole number of pesos between nothing and what the database accepts', () => {
    expect(codes(errorsOf({ ...valid, total: -1 }))).toEqual(['/total:out-of-range']);
    expect(codes(errorsOf({ ...valid, total: MAX_PESOS + 1 }))).toEqual(['/total:out-of-range']);
    expect(codes(errorsOf({ ...valid, total: 1.5 }))).toEqual(['/total:invalid-type']);
    expect(codes(errorsOf({ ...valid, total: undefined }))).toEqual(['/total:required']);
  });
});

describe('the fingerprint of a sale', () => {
  const print = (body: unknown) => saleFingerprint(sale(body));

  it('is the same however the body was written, and does not depend on the clock measure or the operation', () => {
    const reordered = {
      payments: valid.payments,
      lines: valid.lines,
      clockOffsetMs: 7,
      total: valid.total,
      folio: ' aa-000142',
      shiftId: SHIFT.toUpperCase(),
      operationId: '5f6a7b8c-9d0e-4f1a-8b2c-4d5e6f7a8b9c',
      deviceTime: TIME,
    };

    expect(print(reordered)).toBe(print(valid));
  });

  it.each([
    ['the shift', { shiftId: '5f6a7b8c-9d0e-4f1a-8b2c-4d5e6f7a8b9c' }],
    ['the folio', { folio: 'AA-000143' }],
    ['the total', { total: 13_001 }],
    ['the time', { deviceTime: '2026-10-18T15:00:01.000Z' }],
    ['a line', { lines: [{ ...valid.lines[0], quantityMilli: 3_000 }, valid.lines[1]] }],
    ['the order of the lines', { lines: [valid.lines[1], valid.lines[0]] }],
    ['the price of a line', { lines: [{ ...valid.lines[0], unitPrice: 3_400 }, valid.lines[1]] }],
    ['the discount of a line', { lines: [{ ...valid.lines[0], discount: 100 }, valid.lines[1]] }],
    ['the tax rate of a line', { lines: [{ ...valid.lines[0], taxRateBp: 500 }, valid.lines[1]] }],
    ['the product of a line', { lines: [{ ...valid.lines[0], productId: BREAD }, valid.lines[1]] }],
    ['a payment method', { payments: [{ method: 'transfer', amount: 10_000 }, valid.payments[1]] }],
    ['a payment amount', { payments: [{ method: 'cash', amount: 9_000 }, valid.payments[1]] }],
    [
      'a payment reference',
      { payments: [valid.payments[0], { method: 'card', amount: 3_000, reference: 'otro' }] },
    ],
  ])('changes with %s', (_name, change) => {
    expect(print({ ...valid, ...change })).not.toBe(print(valid));
  });
});
