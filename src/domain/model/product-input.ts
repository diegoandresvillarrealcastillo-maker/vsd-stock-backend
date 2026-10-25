import { Barcode } from './barcode.js';
import { MAX_PESOS } from './money.js';
import { Sku } from './sku.js';
import { TAX_RATES_BP, type TaxKind } from './tax.js';
import { readTaxKind, refuseTaxKindMismatch } from './tax-kind-input.js';
import { UNITS_OF_MEASURE, type UnitOfMeasure } from './unit-of-measure.js';
import type { InputReader } from './validation.js';

/** Los campos que se aceptan al crear un producto: uno nuevo nace activo, asi que `active` no va. */
export const NEW_PRODUCT_FIELDS = [
  'name',
  'sku',
  'barcode',
  'unit',
  'unitPrice',
  'taxRateBp',
  'taxKind',
  'categoryId',
  'minStockMilli',
] as const;

/** Los que se aceptan al cambiarlo. */
export const PRODUCT_CHANGE_FIELDS = [...NEW_PRODUCT_FIELDS, 'active'] as const;

const MAX_NAME_LENGTH = 120;
const MAX_SKU_LENGTH = 40;
/** Largo de lo escrito como codigo de barras que se mira: mas que esto ya no es un GTIN y el dominio lo rechaza con su frase. */
const MAX_BARCODE_TEXT_LENGTH = 32;
/** `product_min_stock_range` de la base (ADR 0021). */
const MAX_MIN_STOCK_MILLI = 1_000_000_000;

const UNIT_NAMES = Object.keys(UNITS_OF_MEASURE) as unknown as readonly [
  UnitOfMeasure,
  ...UnitOfMeasure[],
];

/** Un producto nuevo, ya validado (ADR 0015): los valores ya son del dominio. */
export interface NewProduct {
  readonly name: string;
  readonly sku: Sku;
  readonly barcode: Barcode | null;
  readonly unit: UnitOfMeasure;
  readonly unitPrice: number;
  readonly taxRateBp: number;
  /** Gravado, exento o excluido; lleva una tarifa que le quepa (ADR 0034). */
  readonly taxKind: TaxKind;
  readonly categoryId: string | null;
  readonly minStockMilli: number | null;
}

/** Lo que cambia de un producto. Lo que no aparece, no cambia; `null` borra el codigo de barras, la categoria o el minimo. */
export interface ProductChange {
  readonly name?: string;
  readonly sku?: Sku;
  readonly barcode?: Barcode | null;
  readonly unit?: UnitOfMeasure;
  readonly unitPrice?: number;
  readonly taxRateBp?: number;
  /** Solo, se compara con la tarifa que el producto ya tiene (lo hace el caso de uso); junto con la tarifa, se compara aqui. */
  readonly taxKind?: TaxKind;
  readonly categoryId?: string | null;
  readonly minStockMilli?: number | null;
  readonly active?: boolean;
}

/** «0, 500 o 1900». */
function listOr(values: readonly (number | string)[]): string {
  const head = values.slice(0, -1).join(', ');
  const last = values[values.length - 1];
  return head === '' ? String(last) : `${head} o ${String(last)}`;
}

const TAX_RATE_DETAIL = `La tarifa de IVA debe ser ${listOr(TAX_RATES_BP)} puntos básicos (${listOr(
  TAX_RATES_BP.map((rate) => `${rate / 100} %`),
)}).`;

const present = (reader: InputReader, key: string): boolean => reader.raw(key) !== undefined;

// ---------- lectura campo por campo ----------

function name(reader: InputReader, required: boolean): string | undefined {
  if (!required && !present(reader, 'name')) return undefined;
  return reader.text('name', { label: 'El nombre', max: MAX_NAME_LENGTH });
}

function sku(reader: InputReader, required: boolean): Sku | undefined {
  if (!required && !present(reader, 'sku')) return undefined;
  const text = reader.text('sku', { label: 'El SKU', max: MAX_SKU_LENGTH });
  // Un texto que el lector ya rechazo viene vacio: no se rechaza dos veces.
  if (text === '') return undefined;
  return reader.convert(
    'sku',
    {
      code: 'invalid-sku',
      detail:
        'El SKU solo lleva letras sin acento, dígitos y . _ / - (con espacios sueltos entre grupos).',
    },
    () => Sku.parse(text),
    undefined,
  );
}

function barcode(reader: InputReader): Barcode | null | undefined {
  if (reader.isNull('barcode')) return null;
  if (!present(reader, 'barcode')) return undefined;
  const text = reader.text('barcode', {
    label: 'El código de barras',
    max: MAX_BARCODE_TEXT_LENGTH,
  });
  if (text === '') return undefined;
  return reader.convert(
    'barcode',
    {
      code: 'invalid-barcode',
      detail:
        'El código de barras no es un GTIN válido: 8, 12, 13 o 14 dígitos con su dígito de control.',
    },
    () => Barcode.parse(text),
    undefined,
  );
}

function unit(reader: InputReader, required: boolean): UnitOfMeasure | undefined {
  if (!required && !present(reader, 'unit')) return undefined;
  return reader.oneOf('unit', UNIT_NAMES, { label: 'La unidad' });
}

function unitPrice(reader: InputReader, required: boolean): number | undefined {
  if (!required && !present(reader, 'unitPrice')) return undefined;
  return reader.integer('unitPrice', { label: 'El precio', min: 0, max: MAX_PESOS });
}

function taxRate(reader: InputReader, required: boolean): number | undefined {
  if (!required && !present(reader, 'taxRateBp')) return undefined;
  const rate = reader.integer('taxRateBp', { label: 'La tarifa de IVA', min: 0, max: 10_000 });
  // Una tarifa que el lector ya rechazo viene como 0, que es una tarifa valida: no se rechaza dos veces.
  if (!TAX_RATES_BP.includes(rate)) {
    reader.fail('/taxRateBp', 'invalid-value', TAX_RATE_DETAIL);
  }
  return rate;
}

function taxKind(reader: InputReader, required: boolean): TaxKind | undefined {
  if (!required && !present(reader, 'taxKind')) return undefined;
  return readTaxKind(reader);
}

function category(reader: InputReader): string | null | undefined {
  if (reader.isNull('categoryId')) return null;
  if (!present(reader, 'categoryId')) return undefined;
  const id = reader.uuid('categoryId', { label: 'El identificador de la categoría' });
  // Un identificador que el lector ya rechazo viene vacio: no se rechaza dos veces.
  return id === '' ? undefined : id;
}

function minStock(reader: InputReader): number | null | undefined {
  if (reader.isNull('minStockMilli')) return null;
  if (!present(reader, 'minStockMilli')) return undefined;
  return reader.integer('minStockMilli', {
    label: 'El stock mínimo',
    min: 0,
    max: MAX_MIN_STOCK_MILLI,
  });
}

// ---------- lo que se arma ----------

/** Lee un producto nuevo. Los problemas quedan en el lector; el llamador llama a `finish()` antes de usar el resultado. */
export function readNewProduct(reader: InputReader): NewProduct {
  const head = {
    name: name(reader, true) as string,
    sku: sku(reader, true) as Sku,
    barcode: barcode(reader) ?? null,
    unit: unit(reader, true) as UnitOfMeasure,
    unitPrice: unitPrice(reader, true) as number,
  };
  // La tarifa y el tipo se leen juntos para decir si caben (ADR 0034).
  const taxStart = reader.errorCount();
  const taxRateBp = taxRate(reader, true) as number;
  const kind = taxKind(reader, true) as TaxKind;
  refuseTaxKindMismatch(reader, taxStart, kind, taxRateBp);
  return {
    ...head,
    taxRateBp,
    taxKind: kind,
    categoryId: category(reader) ?? null,
    minStockMilli: minStock(reader) ?? null,
  };
}

/** Lee lo que cambia de un producto. Pide al menos un campo. */
export function readProductChange(reader: InputReader): ProductChange {
  const draft: { -readonly [K in keyof ProductChange]: ProductChange[K] } = {};
  const nameValue = name(reader, false);
  if (nameValue !== undefined) draft.name = nameValue;
  const skuValue = sku(reader, false);
  if (skuValue !== undefined) draft.sku = skuValue;
  const barcodeValue = barcode(reader);
  if (barcodeValue !== undefined) draft.barcode = barcodeValue;
  const unitValue = unit(reader, false);
  if (unitValue !== undefined) draft.unit = unitValue;
  const priceValue = unitPrice(reader, false);
  if (priceValue !== undefined) draft.unitPrice = priceValue;
  const taxStart = reader.errorCount();
  const rateValue = taxRate(reader, false);
  if (rateValue !== undefined) draft.taxRateBp = rateValue;
  const kindValue = taxKind(reader, false);
  if (kindValue !== undefined) draft.taxKind = kindValue;
  // Los dos juntos se comparan aqui; uno solo, contra el producto que ya existe, en el caso de uso (ADR 0034).
  if (rateValue !== undefined && kindValue !== undefined) {
    refuseTaxKindMismatch(reader, taxStart, kindValue, rateValue);
  }
  const categoryValue = category(reader);
  if (categoryValue !== undefined) draft.categoryId = categoryValue;
  const minStockValue = minStock(reader);
  if (minStockValue !== undefined) draft.minStockMilli = minStockValue;
  if (present(reader, 'active')) {
    draft.active = reader.boolean('active', { label: 'El estado activo' });
  }
  if (!PRODUCT_CHANGE_FIELDS.some((field) => present(reader, field))) {
    reader.fail('', 'empty-change', 'Indica al menos un dato para cambiar.');
  }
  return draft;
}
