import { Money } from './money.js';
import { divideRounded } from './rounding.js';
import { assertTaxRate, splitTaxIncluded } from './tax.js';

/** La cantidad mas grande de una linea, en milesimas: un millon de unidades. */
export const MAX_QUANTITY_MILLI = 1_000_000_000;

const MILLI = 1000n;
const BASIS_POINTS = 10_000;

/** Una linea de venta tal como la ve el calculo (ADR 0014). La cantidad va en milesimas: 1,5 kg = 1500. */
export interface SaleLine {
  readonly unitPrice: Money;
  readonly quantityMilli: number;
  /** Rebaja de la linea en pesos, ya con el IVA incluido. */
  readonly discount: Money;
  /** Tarifa del producto en puntos basicos: 0, 500 o 1900. */
  readonly rateBp: number;
}

export interface RateSummary {
  readonly rateBp: number;
  readonly total: Money;
  readonly base: Money;
  readonly tax: Money;
}

export interface SaleSummary {
  readonly total: Money;
  readonly base: Money;
  readonly tax: Money;
  /** Un renglon por tarifa presente, de menor a mayor. */
  readonly byRate: readonly RateSummary[];
}

/**
 * Convierte un resultado exacto en dinero. Si pasa del maximo, `Money.of` lo rechaza: un
 * `bigint` enorme se vuelve un `number` impreciso, pero siempre mayor que el maximo.
 */
function toMoney(value: bigint): Money {
  return Money.of(Number(value));
}

/** Precio por cantidad, redondeado al peso. Lanza RangeError si la cantidad o el precio no son validos. */
export function grossLineTotal(unitPrice: Money, quantityMilli: number): Money {
  if (!Number.isInteger(quantityMilli) || quantityMilli < 1 || quantityMilli > MAX_QUANTITY_MILLI) {
    throw new RangeError(
      `A quantity is whole thousandths between 1 and ${MAX_QUANTITY_MILLI}: ${String(quantityMilli)}`,
    );
  }
  if (unitPrice.isNegative()) {
    throw new RangeError('The unit price cannot be negative');
  }
  return toMoney(divideRounded(BigInt(unitPrice.amount) * BigInt(quantityMilli), MILLI));
}

/** Un porcentaje, en puntos basicos (15 % = 1500), de un monto, redondeado al peso. */
export function percentOf(amount: Money, percentBp: number): Money {
  assertTaxRate(percentBp);
  return toMoney(divideRounded(BigInt(amount.amount) * BigInt(percentBp), BigInt(BASIS_POINTS)));
}

/** Lo que cuesta la linea: el bruto menos el descuento, que no puede ser negativo ni pasar del bruto. */
export function lineTotal(line: SaleLine): Money {
  const gross = grossLineTotal(line.unitPrice, line.quantityMilli);
  if (line.discount.isNegative() || line.discount.compareTo(gross) > 0) {
    throw new RangeError('The discount must be between zero and the amount of the line');
  }
  return gross.subtract(line.discount);
}

/**
 * Totaliza una venta. Las lineas de una misma tarifa se suman ANTES de sacar el IVA, una
 * vez por tarifa: el error de redondeo es de medio peso por tarifa y no por linea.
 */
export function summarizeSale(lines: readonly SaleLine[]): SaleSummary {
  const totalsByRate = new Map<number, Money>();
  for (const line of lines) {
    const previous = totalsByRate.get(line.rateBp) ?? Money.zero();
    totalsByRate.set(line.rateBp, previous.add(lineTotal(line)));
  }

  const byRate: RateSummary[] = [...totalsByRate.entries()]
    .sort(([a], [b]) => a - b)
    .map(([rateBp, total]) => ({ rateBp, total, ...splitTaxIncluded(total, rateBp) }));

  const sum = (pick: (row: RateSummary) => Money): Money =>
    byRate.reduce((accumulated, row) => accumulated.add(pick(row)), Money.zero());
  return {
    total: sum((row) => row.total),
    base: sum((row) => row.base),
    tax: sum((row) => row.tax),
    byRate,
  };
}
