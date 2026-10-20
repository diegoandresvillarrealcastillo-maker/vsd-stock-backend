import { Folio } from './folio.js';
import type { InputReader } from './validation.js';

/** Los parametros de la lista de ventas, ademas de `limit` y `cursor`. */
export const SALE_FILTER_FIELDS = ['shiftId', 'attention', 'folio'] as const;

const ATTENTION_VALUES = ['true', 'false'] as const;

/** Un folio escrito (`AA-000142`) mide mucho menos de cuarenta caracteres. */
const MAX_FOLIO_LENGTH = 40;
/** `sale_review_note_shape` (ADR 0027): una nota corta, sin saltos ni caracteres de control. */
export const MAX_REVIEW_NOTE_LENGTH = 200;

/** Lo que se pide de la lista de ventas. Lo que no se pidio no aparece. */
export interface SaleFilter {
  /** Solo las ventas de este turno. */
  readonly shiftId?: string;
  /** `true`: solo las que piden atencion y nadie ha revisado (la bandeja). `false`: solo las que no. */
  readonly attention?: boolean;
  /** El folio exacto, tal como el dispositivo lo trajo o como quedo guardado. */
  readonly folio?: string;
}

/** Lee los filtros de la lista de ventas. Los problemas quedan en el lector; el llamador llama a `finish()` antes de usarlos. */
export function readSaleFilter(reader: InputReader): SaleFilter {
  const filter: { shiftId?: string; attention?: boolean; folio?: string } = {};
  if (reader.raw('shiftId') !== undefined) {
    filter.shiftId = reader.uuid('shiftId', { label: 'El identificador del turno' }).toLowerCase();
  }
  if (reader.raw('attention') !== undefined) {
    filter.attention =
      reader.oneOf('attention', ATTENTION_VALUES, { label: 'El filtro de atencion' }) === 'true';
  }
  if (reader.raw('folio') !== undefined) {
    const before = reader.errorCount();
    const text = reader.text('folio', { label: 'El folio', max: MAX_FOLIO_LENGTH });
    // Un folio que esta en blanco o es demasiado largo ya tiene su problema; no se le suma el de «no es un folio».
    const folio =
      reader.errorCount() > before
        ? null
        : reader.convert(
            'folio',
            {
              code: 'invalid-folio',
              detail:
                'El folio debe ser el código del dispositivo, un guion y la serie, como AA-000142.',
            },
            () => Folio.parse(text),
            null,
          );
    if (folio !== null) filter.folio = folio.toString();
  }
  return filter;
}

/** Lo que se manda al revisar una venta. */
export const SALE_REVIEW_FIELDS = ['note'] as const;

export interface SaleReviewInput {
  /** Para que quede dicho que se hizo (por ejemplo, «se ajusto el inventario»), o `null`. */
  readonly note: string | null;
}

/** Lee la revision de una venta. Los problemas quedan en el lector; el llamador llama a `finish()` antes de usarla. */
export function readSaleReview(reader: InputReader): SaleReviewInput {
  const note = reader.isNull('note')
    ? null
    : reader.text('note', { label: 'La nota', max: MAX_REVIEW_NOTE_LENGTH, optional: true });
  return { note: note === undefined ? null : note };
}
