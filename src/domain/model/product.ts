import { Barcode } from './barcode.js';
import { Money } from './money.js';
import { Sku } from './sku.js';
import { TAX_RATES_BP } from './tax.js';
import { isUnitOfMeasure, type UnitOfMeasure } from './unit-of-measure.js';

const MAX_NAME_LENGTH = 120;

// eslint-disable-next-line no-control-regex -- justamente lo que se quiere rechazar
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;

/** Lo que llega de un formulario o de una peticion: todo sin validar. */
export interface ProductInput {
  name: string;
  sku: string;
  barcode?: string | null;
  unit: string;
  unitPrice: number;
  rateBp: number;
}

/**
 * Un producto del catalogo (ADR 0015): sin variantes, con una sola unidad, un precio con el IVA
 * incluido y la tarifa de ese IVA (ADR 0014). Cada presentacion (unidad, paca, caja) es otro producto.
 */
export interface Product {
  readonly name: string;
  readonly sku: Sku;
  readonly barcode: Barcode | null;
  readonly unit: UnitOfMeasure;
  readonly unitPrice: Money;
  readonly rateBp: number;
}

function parseName(name: string): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_NAME_LENGTH ||
    CONTROL_CHARACTERS.test(trimmed)
  ) {
    throw new RangeError(
      `A product name has 1 to ${MAX_NAME_LENGTH} characters and no control characters`,
    );
  }
  return trimmed;
}

/** Valida todas las partes y arma el producto. Lanza RangeError con lo primero que no sirve. */
export function createProduct(input: ProductInput): Product {
  const name = parseName(input.name);
  const sku = Sku.parse(input.sku);
  // Un formulario manda un texto vacio cuando no hay codigo de barras: es lo mismo que no tenerlo.
  const barcodeText = input.barcode ?? '';
  const barcode = barcodeText.trim() === '' ? null : Barcode.parse(barcodeText);
  if (!isUnitOfMeasure(input.unit)) {
    throw new RangeError(`Unknown unit of measure: ${String(input.unit)}`);
  }
  const unitPrice = Money.of(input.unitPrice);
  if (unitPrice.isNegative()) {
    throw new RangeError('A price cannot be negative');
  }
  if (!TAX_RATES_BP.includes(input.rateBp)) {
    throw new RangeError(
      `The tax rate of a product is one of ${TAX_RATES_BP.join(', ')} basis points: ${String(input.rateBp)}`,
    );
  }
  return Object.freeze({ name, sku, barcode, unit: input.unit, unitPrice, rateBp: input.rateBp });
}
