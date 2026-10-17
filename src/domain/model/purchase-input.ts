import { MAX_PESOS } from './money.js';
import type { InputReader } from './validation.js';

/** Los campos de una compra y de cada una de sus lineas. */
export const PURCHASE_FIELDS = ['operationId', 'supplierId', 'note', 'lines'] as const;
export const PURCHASE_LINE_FIELDS = ['productId', 'quantityMilli', 'unitCost'] as const;

/** Cuantos productos distintos caben en una compra. */
export const MAX_PURCHASE_LINES = 200;

/** `purchase_note_shape` (ADR 0021). */
const MAX_NOTE_LENGTH = 500;
/** `purchase_line_quantity_range`: de una milesima a un millon de unidades. */
const MAX_QUANTITY_MILLI = 1_000_000_000;

export interface PurchaseLineInput {
  readonly productId: string;
  /** Milesimas de la unidad del producto. */
  readonly quantityMilli: number;
  /** Pesos enteros por unidad. */
  readonly unitCost: number;
}

/** Una compra ya leida: lo que el cliente mando, validado en su forma. Que los productos existan lo comprueba el caso de uso. */
export interface PurchaseInput {
  /** La clave de idempotencia (ADR 0019): repetir la compra con el mismo `operationId` no la duplica. */
  readonly operationId: string;
  readonly supplierId: string | null;
  readonly note: string | null;
  readonly lines: readonly PurchaseLineInput[];
}

/** Lee una compra. Los problemas quedan en el lector; el llamador llama a `finish()` antes de usar el resultado. */
export function readPurchase(reader: InputReader): PurchaseInput {
  const operationId = reader.uuid('operationId', { label: 'El identificador de la operación' });

  const supplierId = reader.isNull('supplierId')
    ? null
    : reader.uuid('supplierId', { label: 'El identificador del proveedor', optional: true });
  const note = reader.isNull('note')
    ? null
    : reader.text('note', { label: 'La nota', max: MAX_NOTE_LENGTH, optional: true });

  const items = reader.items('lines', {
    label: 'El listado de líneas',
    min: 1,
    max: MAX_PURCHASE_LINES,
  });
  const seen = new Set<string>();
  const lines: PurchaseLineInput[] = items.map((item, index) => {
    const line = reader.within(`/lines/${index}`, item, PURCHASE_LINE_FIELDS);
    const productId = line
      .uuid('productId', { label: 'El identificador del producto' })
      .toLowerCase();
    // Un producto repetido se junta en una sola linea; un identificador ya rechazado no se rechaza dos veces.
    if (productId !== '' && seen.has(productId)) {
      line.fail(
        '/productId',
        'duplicate-product',
        'Este producto ya está en otra línea: junta las cantidades en una sola.',
      );
    }
    seen.add(productId);
    return {
      productId,
      quantityMilli: line.integer('quantityMilli', {
        label: 'La cantidad',
        min: 1,
        max: MAX_QUANTITY_MILLI,
      }),
      unitCost: line.integer('unitCost', { label: 'El costo', min: 0, max: MAX_PESOS }),
    };
  });

  return {
    operationId: operationId.toLowerCase(),
    supplierId: supplierId === undefined || supplierId === null ? null : supplierId.toLowerCase(),
    note: note === undefined ? null : note,
    lines,
  };
}

/**
 * La huella de una compra: el mismo texto para la misma compra, escrita como se escriba el cuerpo (el orden de sus claves,
 * las mayusculas de sus identificadores). Se guarda con la operacion para que reusar un `operationId` con OTRO cuerpo
 * responda 409 en vez de dar por aplicado lo nuevo (ADR 0019). No incluye el `operationId`: es la llave bajo la que se compara.
 */
export function purchaseFingerprint(purchase: PurchaseInput): string {
  return JSON.stringify({
    supplierId: purchase.supplierId,
    note: purchase.note,
    lines: purchase.lines.map((line) => ({
      productId: line.productId,
      quantityMilli: line.quantityMilli,
      unitCost: line.unitCost,
    })),
  });
}
