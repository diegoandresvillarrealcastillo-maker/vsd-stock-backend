import type { InputReader } from './validation.js';

/** Los campos de un ajuste de existencias. El saldo no es uno: no se edita, se agrega un movimiento. */
export const ADJUSTMENT_FIELDS = ['operationId', 'productId', 'deltaMilli', 'reason'] as const;

/** `stock_movement_delta_range`: hasta un millon de unidades, hacia arriba o hacia abajo. */
const MAX_DELTA_MILLI = 1_000_000_000;
/** `stock_movement_note_shape`: el motivo se guarda como la nota del movimiento. */
const MAX_REASON_LENGTH = 500;

/** Un ajuste ya leido: lo que el cliente mando, validado en su forma. Que el producto exista lo comprueba el caso de uso. */
export interface AdjustmentInput {
  /** La clave de idempotencia (ADR 0019): repetir el ajuste con el mismo `operationId` no lo duplica. */
  readonly operationId: string;
  readonly productId: string;
  /** Milesimas de la unidad del producto; negativo resta y positivo suma. Nunca cero. */
  readonly deltaMilli: number;
  /** Por que se ajusta: obligatorio, porque un ajuste sin motivo es un hueco en el libro. */
  readonly reason: string;
}

/** Lee un ajuste. Los problemas quedan en el lector; el llamador llama a `finish()` antes de usar el resultado. */
export function readAdjustment(reader: InputReader): AdjustmentInput {
  const operationId = reader.uuid('operationId', { label: 'El identificador de la operación' });
  const productId = reader.uuid('productId', { label: 'El identificador del producto' });
  const deltaMilli = reader.integer('deltaMilli', {
    label: 'La cantidad',
    min: -MAX_DELTA_MILLI,
    max: MAX_DELTA_MILLI,
  });
  // Cuando el campo no sirve, `integer` devuelve el minimo y no cero: aqui solo llega un cero que la persona escribio.
  if (deltaMilli === 0) {
    reader.fail(
      '/deltaMilli',
      'zero-delta',
      'La cantidad del ajuste no puede ser cero: no cambiaría nada.',
    );
  }
  const reason = reader.text('reason', { label: 'El motivo', max: MAX_REASON_LENGTH });
  return {
    operationId: operationId.toLowerCase(),
    productId: productId.toLowerCase(),
    deltaMilli,
    reason,
  };
}

/**
 * La huella de un ajuste: el mismo texto para el mismo ajuste, escrito como se escriba el cuerpo. Se guarda con la
 * operacion para que reusar un `operationId` con OTRO cuerpo responda 409 (ADR 0019). No incluye el `operationId`.
 */
export function adjustmentFingerprint(adjustment: AdjustmentInput): string {
  return JSON.stringify({
    productId: adjustment.productId,
    deltaMilli: adjustment.deltaMilli,
    reason: adjustment.reason,
  });
}
