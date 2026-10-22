import { Money } from './money.js';
import { divideRounded } from './rounding.js';

/**
 * Las tarifas de IVA del catalogo, en puntos basicos (1 % = 100): exento o excluido,
 * reducida y general. Un contador reviso la mecanica y estas tarifas (ADR 0032); la
 * aritmetica sirve para cualquier tarifa. Hoy no distingue exento de excluido (ADR 0032).
 */
export const TAX_RATES_BP: readonly number[] = [0, 500, 1900];

const BASIS_POINTS = 10_000;

export interface TaxBreakdown {
  /** Base gravable: el precio sin el impuesto, redondeada al peso. */
  readonly base: Money;
  /** El impuesto: lo que queda del total despues de la base. */
  readonly tax: Money;
}

/** Lanza RangeError si la tarifa no es un numero entero de puntos basicos entre 0 y 10.000. */
export function assertTaxRate(rateBp: number): void {
  if (!Number.isInteger(rateBp) || rateBp < 0 || rateBp > BASIS_POINTS) {
    throw new RangeError(
      `A tax rate is whole basis points between 0 and ${BASIS_POINTS}: ${String(rateBp)}`,
    );
  }
}

/**
 * Separa el impuesto de un total que ya lo incluye (ADR 0014).
 *
 * La base se redondea al peso mas cercano y el impuesto es lo que sobra, no un segundo
 * redondeo: asi `base + impuesto == total` siempre, sin un peso de mas ni de menos, y
 * ninguno de los dos se aleja mas de medio peso de su valor exacto.
 */
export function splitTaxIncluded(total: Money, rateBp: number): TaxBreakdown {
  assertTaxRate(rateBp);
  const base = divideRounded(
    BigInt(total.amount) * BigInt(BASIS_POINTS),
    BigInt(BASIS_POINTS + rateBp),
  );
  const taxableBase = Money.of(Number(base));
  return { base: taxableBase, tax: total.subtract(taxableBase) };
}
