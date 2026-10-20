import { Folio } from './folio.js';
import { Money, MAX_PESOS } from './money.js';
import {
  OPERATION_TIME_FIELDS,
  readOperationTime,
  type OperationTimeInput,
} from './operation-time-input.js';
import {
  MAX_QUANTITY_MILLI,
  grossLineTotal,
  summarizeSale,
  type SaleSummary,
} from './sale-totals.js';
import { TAX_RATES_BP } from './tax.js';
import type { InputReader } from './validation.js';

/** Los campos de una venta, de cada una de sus lineas y de cada uno de sus cobros. */
export const SALE_FIELDS = [
  'operationId',
  'shiftId',
  'folio',
  'total',
  'lines',
  'payments',
  ...OPERATION_TIME_FIELDS,
] as const;
export const SALE_LINE_FIELDS = [
  'productId',
  'quantityMilli',
  'unitPrice',
  'discount',
  'taxRateBp',
] as const;
export const PAYMENT_FIELDS = ['method', 'amount', 'reference'] as const;

export const PAYMENT_METHODS = ['cash', 'card', 'transfer'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Cuantas lineas y cuantos cobros caben en una venta. */
export const MAX_SALE_LINES = 200;
export const MAX_PAYMENTS = 10;

/** `payment_reference_shape` (ADR 0021). */
const MAX_REFERENCE_LENGTH = 100;
/** Un folio escrito (`AA-000142`) mide mucho menos de cuarenta caracteres. */
const MAX_FOLIO_LENGTH = 40;

/** Una linea tal como el dispositivo la vendio: el precio y la tarifa son los que el cliente vio (ADR 0027). */
export interface SaleLineInput {
  readonly productId: string;
  /** Milesimas de la unidad del producto. */
  readonly quantityMilli: number;
  /** Pesos enteros por unidad, IVA incluido. */
  readonly unitPrice: number;
  /** Rebaja de la linea en pesos, ya con el IVA incluido. */
  readonly discount: number;
  /** Puntos basicos: 0, 500 o 1900. */
  readonly taxRateBp: number;
}

export interface PaymentInput {
  readonly method: PaymentMethod;
  /** Pesos enteros que quedaron en la caja o en la cuenta: sin el vuelto. */
  readonly amount: number;
  readonly reference: string | null;
}

/** Una venta ya leida: lo que el dispositivo mando, validado en su forma. Que lo nombrado exista lo comprueba el caso de uso. */
export interface SaleInput {
  /** La clave de idempotencia (ADR 0019). */
  readonly operationId: string;
  readonly shiftId: string;
  /** El folio como se escribe en el comprobante, `AA-000142`. */
  readonly folio: string;
  /** El codigo del dispositivo que lleva el folio. */
  readonly folioDevice: string;
  /** El total que el dispositivo le cobro al cliente. El servidor calcula el suyo y los compara. */
  readonly claimedTotal: number;
  readonly lines: readonly SaleLineInput[];
  readonly payments: readonly PaymentInput[];
  /** El total que el servidor calcula de las lineas, con el IVA desglosado por tarifa (ADR 0014). */
  readonly summary: SaleSummary;
  readonly time: OperationTimeInput;
}

const NOTHING = summarizeSale([]);

/** Lee una venta. Los problemas quedan en el lector; el llamador llama a `finish()` antes de usar el resultado. */
export function readSale(reader: InputReader): SaleInput {
  const operationId = reader.uuid('operationId', { label: 'El identificador de la operación' });
  const shiftId = reader.uuid('shiftId', { label: 'El identificador del turno' });

  const beforeFolio = reader.errorCount();
  const folioText = reader.text('folio', { label: 'El folio', max: MAX_FOLIO_LENGTH });
  // Un folio que falta o es demasiado largo ya tiene su problema; no se le suma el de «no es un folio».
  const folio =
    reader.errorCount() > beforeFolio
      ? null
      : reader.convert(
          'folio',
          {
            code: 'invalid-folio',
            detail:
              'El folio debe ser el código del dispositivo, un guion y la serie, como AA-000142.',
          },
          () => Folio.parse(folioText),
          null,
        );

  const claimedTotal = reader.integer('total', { label: 'El total', min: 0, max: MAX_PESOS });

  const lineItems = reader.items('lines', {
    label: 'El listado de líneas',
    min: 1,
    max: MAX_SALE_LINES,
  });
  let linesAreSound = true;
  const lines: SaleLineInput[] = lineItems.map((item, index) => {
    const line = reader.within(`/lines/${index}`, item, SALE_LINE_FIELDS);
    const before = reader.errorCount();
    const read: SaleLineInput = {
      productId: line.uuid('productId', { label: 'El identificador del producto' }).toLowerCase(),
      quantityMilli: line.integer('quantityMilli', {
        label: 'La cantidad',
        min: 1,
        max: MAX_QUANTITY_MILLI,
      }),
      unitPrice: line.integer('unitPrice', { label: 'El precio', min: 0, max: MAX_PESOS }),
      discount: line.integer('discount', { label: 'El descuento', min: 0, max: MAX_PESOS }),
      taxRateBp: readTaxRate(line),
    };
    if (reader.errorCount() === before) {
      checkLineAmounts(line, read);
    }
    linesAreSound = linesAreSound && reader.errorCount() === before;
    return read;
  });

  const summary = linesAreSound ? summarizeLines(reader, lines) : NOTHING;

  const paymentItems = reader.items('payments', {
    label: 'El listado de cobros',
    min: 0,
    max: MAX_PAYMENTS,
  });
  const payments: PaymentInput[] = paymentItems.map((item, index) => {
    const payment = reader.within(`/payments/${index}`, item, PAYMENT_FIELDS);
    const method = payment.oneOf('method', PAYMENT_METHODS, { label: 'El medio de pago' });
    const amount = payment.integer('amount', { label: 'El monto', min: 1, max: MAX_PESOS });
    const reference = payment.isNull('reference')
      ? undefined
      : payment.text('reference', {
          label: 'La referencia',
          max: MAX_REFERENCE_LENGTH,
          optional: true,
        });
    return { method, amount, reference: reference ?? null };
  });

  return {
    operationId: operationId.toLowerCase(),
    shiftId: shiftId.toLowerCase(),
    folio: folio === null ? '' : folio.toString(),
    folioDevice: folio === null ? '' : folio.device.value,
    claimedTotal,
    lines,
    payments,
    summary,
    time: readOperationTime(reader),
  };
}

/** La tarifa de IVA de una linea: un entero de los que el catalogo conoce. */
function readTaxRate(line: InputReader): number {
  const rate = line.integer('taxRateBp', { label: 'La tarifa de IVA', min: 0, max: 10_000 });
  // Si no sirvio, el valor de relleno es 0, que es una tarifa valida: no se le suma el problema de «tarifa desconocida».
  if (!TAX_RATES_BP.includes(rate)) {
    line.fail(
      '/taxRateBp',
      'invalid-value',
      `La tarifa de IVA debe ser una de: ${TAX_RATES_BP.join(', ')}.`,
    );
  }
  return rate;
}

/** Lo que una linea no puede pasar: valer mas de lo que la base guarda, o rebajar mas de lo que vale. */
function checkLineAmounts(line: InputReader, read: SaleLineInput): void {
  let gross: Money;
  try {
    gross = grossLineTotal(Money.of(read.unitPrice), read.quantityMilli);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    line.fail(
      '/unitPrice',
      'line-too-large',
      'El valor de esta línea pasa de lo que se puede registrar.',
    );
    return;
  }
  if (read.discount > gross.amount) {
    line.fail(
      '/discount',
      'discount-too-large',
      'El descuento no puede pasar del valor de la línea.',
    );
  }
}

/** Totaliza las lineas ya revisadas una por una; si todas juntas pasan de lo que la base guarda, lo dice en `/lines`. */
function summarizeLines(reader: InputReader, lines: readonly SaleLineInput[]): SaleSummary {
  try {
    return summarizeSale(
      lines.map((line) => ({
        unitPrice: Money.of(line.unitPrice),
        quantityMilli: line.quantityMilli,
        discount: Money.of(line.discount),
        rateBp: line.taxRateBp,
      })),
    );
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    reader.fail(
      '/lines',
      'total-too-large',
      'El total de la venta pasa de lo que se puede registrar.',
    );
    return NOTHING;
  }
}

/**
 * La huella de una venta: el mismo texto para la misma venta, escrita como se escriba el cuerpo. Se guarda con la operacion
 * para que reusar un `operationId` con OTRA venta responda 409 (ADR 0019). No incluye el `operationId` ni la diferencia
 * del reloj: el dispositivo la mide de nuevo en cada intento y un reintento sigue siendo la misma venta.
 */
export function saleFingerprint(sale: SaleInput): string {
  return JSON.stringify({
    shiftId: sale.shiftId,
    folio: sale.folio,
    total: sale.claimedTotal,
    lines: sale.lines.map((line) => ({
      productId: line.productId,
      quantityMilli: line.quantityMilli,
      unitPrice: line.unitPrice,
      discount: line.discount,
      taxRateBp: line.taxRateBp,
    })),
    payments: sale.payments.map((payment) => ({
      method: payment.method,
      amount: payment.amount,
      reference: payment.reference,
    })),
    deviceTime: sale.time.deviceTime,
  });
}
