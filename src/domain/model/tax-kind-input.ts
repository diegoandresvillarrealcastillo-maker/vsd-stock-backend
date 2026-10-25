import {
  TAX_KINDS,
  TAX_KIND_RATE_CODE,
  TAX_KIND_RATE_DETAIL,
  taxKindFitsRate,
  type TaxKind,
} from './tax.js';
import type { InputReader } from './validation.js';

/** Lee el tipo tributario (ADR 0034): uno de los tres, y obligatorio donde se pide. */
export function readTaxKind(reader: InputReader): TaxKind {
  return reader.oneOf('taxKind', TAX_KINDS, { label: 'El tipo tributario' });
}

/**
 * Dice, en el campo del tipo, que el tipo y la tarifa no caben juntos (ADR 0034). Solo se mira si lo leido desde `errorsBefore`
 * sirvio: un tipo o una tarifa que ya tienen su problema traen un valor de relleno que no se debe juzgar.
 */
export function refuseTaxKindMismatch(
  reader: InputReader,
  errorsBefore: number,
  kind: TaxKind,
  rateBp: number,
): void {
  if (reader.errorCount() === errorsBefore && !taxKindFitsRate(kind, rateBp)) {
    reader.fail('/taxKind', TAX_KIND_RATE_CODE, TAX_KIND_RATE_DETAIL);
  }
}
