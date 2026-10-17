/**
 * Las unidades en que se cuenta un producto (ADR 0015): un conjunto cerrado de unidad, peso y volumen.
 *
 * No hay caja, paca ni docena a proposito: cada presentacion es un producto con su propio codigo y
 * no existe conversion entre ellas.
 *
 * `whole` dice si la unidad solo se cuenta en enteros (no existe media unidad) o admite milesimas
 * (un kilo y medio, un cuarto de litro).
 */
export const UNITS_OF_MEASURE = {
  unit: { symbol: 'und', whole: true },
  kilogram: { symbol: 'kg', whole: false },
  gram: { symbol: 'g', whole: false },
  pound: { symbol: 'lb', whole: false },
  liter: { symbol: 'l', whole: false },
  milliliter: { symbol: 'ml', whole: false },
} as const;

export type UnitOfMeasure = keyof typeof UNITS_OF_MEASURE;

export function isUnitOfMeasure(value: unknown): value is UnitOfMeasure {
  // hasOwn y no `in`: «toString» y «__proto__» no son unidades.
  return typeof value === 'string' && Object.hasOwn(UNITS_OF_MEASURE, value);
}

export function unitSymbol(unit: UnitOfMeasure): string {
  return UNITS_OF_MEASURE[unit].symbol;
}

/** `true` si la unidad solo se cuenta en enteros. */
export function isWholeOnly(unit: UnitOfMeasure): boolean {
  return UNITS_OF_MEASURE[unit].whole;
}
