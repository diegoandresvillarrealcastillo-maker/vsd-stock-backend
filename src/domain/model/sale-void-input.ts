import type { InputReader } from './validation.js';

/** Los campos de anular una venta. La venta es la de la ruta. */
export const SALE_VOID_FIELDS = ['operationId', 'shiftId', 'reason'] as const;

/** `sale_void_reason_shape` (ADR 0021): de 1 a 200 caracteres, sin espacios sobrantes ni saltos. */
export const MAX_VOID_REASON_LENGTH = 200;

export interface SaleVoidInput {
  /** La clave de idempotencia (ADR 0019). */
  readonly operationId: string;
  /**
   * El turno ABIERTO de quien anula, de donde sale el efectivo que se devuelve (ADR 0027, punto 15). `null` si no se nombra: solo
   * sirve si la venta no tuvo efectivo.
   */
  readonly shiftId: string | null;
  /** Por que se anula, para que quede dicho. */
  readonly reason: string;
}

/** Lee la anulacion de una venta. Los problemas quedan en el lector; el llamador llama a `finish()` antes de usar el resultado. */
export function readSaleVoid(reader: InputReader): SaleVoidInput {
  const operationId = reader.uuid('operationId', { label: 'El identificador de la operación' });
  const shiftId = reader.isNull('shiftId')
    ? undefined
    : reader.uuid('shiftId', { label: 'El identificador del turno', optional: true });
  const reason = reader.text('reason', { label: 'El motivo', max: MAX_VOID_REASON_LENGTH });
  return {
    operationId: operationId.toLowerCase(),
    shiftId: shiftId === undefined ? null : shiftId.toLowerCase(),
    reason,
  };
}

/**
 * La huella: el mismo texto para la misma peticion, escrita como se escriba el cuerpo (ADR 0019). Incluye la venta, que no va en el
 * cuerpo sino en la ruta, y no el `operationId`, que es la clave bajo la que se compara.
 */
export function saleVoidFingerprint(saleId: string, input: SaleVoidInput): string {
  return JSON.stringify({
    saleId: saleId.toLowerCase(),
    shiftId: input.shiftId,
    reason: input.reason,
  });
}
