import type { TaxKind } from './tax.js';

/**
 * Las marcas que el servidor le pone a una venta que acepta (ADR 0027). Una venta ya ocurrio en el mostrador, asi que
 * nunca se rechaza por algo que el servidor sabe y el dispositivo no (ADR 0009): se acepta y se marca para que alguien la
 * mire. Aqui estan las que salen de comparar la venta con lo que el servidor sabe; «requiere ajuste» (existencia en
 * negativo) y «folio repetido» tienen su propia columna, y las de la hora viven en la operacion (ADR 0016).
 *
 * El orden de esta lista es el orden en que se guardan y se muestran.
 */
export const SALE_FLAGS = [
  'price-differs',
  'total-differs',
  'payment-mismatch',
  'late-shift',
  'revoked-device',
  'folio-device',
] as const;

export type SaleFlag = (typeof SALE_FLAGS)[number];

/** Lo que el servidor sabe de una venta al momento de aceptarla. */
export interface SaleFacts {
  /** Alguna linea se vendio a un precio, con una tarifa o con un tipo tributario que no son los del catalogo de hoy. */
  readonly priceDiffers: boolean;
  /** El total que el dispositivo le cobro al cliente. */
  readonly claimedTotal: number;
  /** El total que el servidor calculo de las lineas. */
  readonly computedTotal: number;
  /** Lo que suman los cobros. */
  readonly paidTotal: number;
  /** La hora efectiva de la venta (ADR 0016). */
  readonly occurredAt: Date;
  /** Cuando se cerro el turno, o `null` si sigue abierto. */
  readonly shiftClosedAt: Date | null;
  /** Cuando dieron de baja el dispositivo, o `null` si sigue activo. */
  readonly deviceRevokedAt: Date | null;
  /** El codigo del dispositivo que lleva el folio. */
  readonly folioDeviceCode: string;
  /** El codigo del dispositivo del turno. */
  readonly deviceCode: string;
}

/**
 * Las marcas de una venta. `late-shift` y `revoked-device` miran la hora en que la venta ocurrio, no la de llegada: una
 * venta hecha antes del cierre o de la baja y enviada despues es una venta normal.
 */
export function flagsOfSale(facts: SaleFacts): SaleFlag[] {
  const flags: SaleFlag[] = [];
  if (facts.priceDiffers) flags.push('price-differs');
  if (facts.claimedTotal !== facts.computedTotal) flags.push('total-differs');
  if (facts.paidTotal !== facts.computedTotal) flags.push('payment-mismatch');
  if (facts.shiftClosedAt !== null && facts.occurredAt > facts.shiftClosedAt) {
    flags.push('late-shift');
  }
  if (facts.deviceRevokedAt !== null && facts.occurredAt >= facts.deviceRevokedAt) {
    flags.push('revoked-device');
  }
  if (facts.folioDeviceCode !== facts.deviceCode) flags.push('folio-device');
  return flags;
}

/** Si la linea se vendio al precio, con la tarifa y con el tipo tributario que el producto tiene hoy en el catalogo (ADR 0034). */
export function soldAtCatalogPrice(
  line: { readonly unitPrice: number; readonly taxRateBp: number; readonly taxKind: TaxKind },
  product: { readonly unitPrice: number; readonly taxRateBp: number; readonly taxKind: TaxKind },
): boolean {
  return (
    line.unitPrice === product.unitPrice &&
    line.taxRateBp === product.taxRateBp &&
    line.taxKind === product.taxKind
  );
}
