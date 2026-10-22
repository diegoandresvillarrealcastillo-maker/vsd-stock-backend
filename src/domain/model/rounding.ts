/**
 * Divide y redondea al entero mas cercano; la mitad exacta se aleja de cero
 * (2,5 -> 3 y -2,5 -> -3). Es la unica regla de redondeo del dinero (ADR 0014):
 * al ser simetrica, la anulacion de una venta suma exactamente lo contrario.
 *
 * Usa `bigint` a proposito: multiplicar un precio por una cantidad o por 10.000
 * se sale de los enteros seguros de un `number` mucho antes que el dinero.
 */
export function divideRounded(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new RangeError('The denominator must be positive');
  }
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  // piso((2n + d) / 2d): por debajo de la mitad baja, desde la mitad sube.
  const rounded = (2n * magnitude + denominator) / (2n * denominator);
  return negative ? -rounded : rounded;
}
