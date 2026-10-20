import type { TimeFlag } from './operation-time.js';
import type { SaleFlag } from './sale-flags.js';

/**
 * Las marcas de la hora que piden atencion (ADR 0027, punto 11): un reloj desviado, una hora del futuro o una que no se puede
 * leer. `clock-unverified` y `stale` solo informan: un dispositivo que todavia no midio su reloj es lo normal, y una operacion
 * que espero horas es lo que pasa sin conexion.
 */
export const ATTENTION_TIME_FLAGS = [
  'clock-skew',
  'future',
  'unreadable',
] as const satisfies readonly TimeFlag[];

/** Lo que se sabe de una venta para decidir si pide atencion. */
export interface SaleSignals {
  readonly needsAdjustment: boolean;
  readonly folioConflict: boolean;
  readonly flags: readonly SaleFlag[];
  readonly timeFlags: readonly TimeFlag[];
}

/**
 * Si una venta pide que alguien la mire: existencia en negativo, folio repetido, cualquier marca del servidor o una hora en
 * la que no se puede confiar. Es lo que la bandeja «Requiere atencion» busca; la consulta SQL de `PrismaSaleRepository` dice
 * lo mismo y una prueba contra la base real comprueba que no se separen. Una venta ya revisada deja de aparecer en la bandeja,
 * pero sigue pidiendo atencion: la revision es otra fila, no un cambio de la venta.
 */
export function requiresAttention(sale: SaleSignals): boolean {
  return (
    sale.needsAdjustment ||
    sale.folioConflict ||
    sale.flags.length > 0 ||
    sale.timeFlags.some((flag) => (ATTENTION_TIME_FLAGS as readonly string[]).includes(flag))
  );
}
