/** El prefijo de los folios de las anulaciones. Lleva una `U`, que ningun codigo de dispositivo puede tener (ADR 0016). */
export const VOID_FOLIO_PREFIX = 'ANU';

/**
 * El ultimo numero de anulacion que el contador de un negocio puede dar (ADR 0036). El contador guarda el SIGUIENTE numero en una
 * columna `integer` de PostgreSQL, cuyo maximo es 2 147 483 647: por eso el ultimo que da es uno menos.
 */
export const MAX_VOID_NUMBER = 2_147_483_646;

const PADDING = 6;

/**
 * El folio de una anulacion, como `ANU-000001` (ADR 0036): el prefijo, un guion y el numero de anulacion del
 * negocio, con seis cifras como minimo. Es la secuencia del negocio, sin saltos, en el orden en que se
 * anotaron las anulaciones, y no se parece al folio de ninguna venta porque ningun codigo de dispositivo
 * puede ser `ANU`.
 *
 * Lanza RangeError si el numero no es un entero de 1 a 2 147 483 646.
 */
export function voidFolio(number: number): string {
  if (!Number.isInteger(number) || number < 1 || number > MAX_VOID_NUMBER) {
    throw new RangeError(
      `A void number is a whole number from 1 to ${String(MAX_VOID_NUMBER)}: ${String(number)}`,
    );
  }
  return `${VOID_FOLIO_PREFIX}-${String(number).padStart(PADDING, '0')}`;
}
