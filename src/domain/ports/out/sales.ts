import type { TimeFlag } from '../../model/operation-time.js';
import type { SaleFlag } from '../../model/sale-flags.js';
import type { PaymentMethod } from '../../model/sale-input.js';

/** Una linea tal como se vendio: el precio y la tarifa quedan los que el cliente vio (ADR 0027). */
export interface SaleLineRecord {
  readonly productId: string;
  /** Milesimas de la unidad del producto. */
  readonly quantityMilli: number;
  /** Pesos enteros por unidad, IVA incluido. */
  readonly unitPrice: number;
  /** Rebaja de la linea en pesos, ya con el IVA incluido. */
  readonly discount: number;
  /** Puntos basicos: 0, 500 o 1900. */
  readonly taxRateBp: number;
}

export interface PaymentRecord {
  readonly method: PaymentMethod;
  /** Pesos enteros que quedaron en la caja o en la cuenta: sin el vuelto. */
  readonly amount: number;
  readonly reference: string | null;
}

export interface NewSale {
  readonly operationId: string;
  readonly shiftId: string;
  /** El folio que el dispositivo trajo. Si ya es de otra venta, el adaptador guarda uno distinto y lo marca. */
  readonly folio: string;
  /** El total que el servidor calculo. */
  readonly total: number;
  /** Algun producto quedo con existencia menor que cero (ADR 0013). */
  readonly needsAdjustment: boolean;
  readonly flags: readonly SaleFlag[];
  readonly lines: readonly SaleLineRecord[];
  readonly payments: readonly PaymentRecord[];
}

/** La revision de una venta: quien la miro, cuando y que anoto (ADR 0027). Una fila de solo agregar. */
export interface SaleReviewRecord {
  readonly reviewedAt: Date;
  readonly reviewedByUserId: string;
  readonly note: string | null;
}

/** La anulacion de una venta: quien la hizo, cuando y por que (ADR 0027). Una fila de solo agregar. */
export interface SaleVoidRecord {
  readonly voidedAt: Date;
  readonly voidedByUserId: string;
  /** La operacion de anular: bajo ella quedaron los movimientos que compensan. */
  readonly operationId: string;
  readonly reason: string;
}

/** Lo que se escribe al anular una venta que ya existe. La operacion ya debe estar reclamada. */
export interface NewSaleVoid {
  readonly saleId: string;
  readonly operationId: string;
  readonly reason: string;
}

/**
 * Una venta sin sus lineas ni sus cobros: lo que se ve en una lista. Con la operacion que la trajo (quien, en que
 * dispositivo y a que hora) y su revision, si alguien ya la miro.
 */
export interface SaleHeader {
  readonly id: string;
  readonly operationId: string;
  readonly shiftId: string;
  /** El dispositivo del turno. */
  readonly deviceId: string | null;
  /** Quien la registro. */
  readonly userId: string;
  /** El folio con que se guardo: igual al reportado, o con `~` y ocho caracteres de la operacion si estaba repetido. */
  readonly folio: string;
  /** El folio que el dispositivo trajo, tal cual. */
  readonly folioReported: string;
  readonly folioConflict: boolean;
  readonly total: number;
  readonly needsAdjustment: boolean;
  readonly flags: readonly SaleFlag[];
  /** Las marcas de la hora de la operacion (ADR 0016). */
  readonly timeFlags: readonly TimeFlag[];
  /** Cuando ocurrio y cuando llego al servidor. */
  readonly occurredAt: Date;
  readonly receivedAt: Date;
  /** `null` mientras nadie la haya revisado. */
  readonly review: SaleReviewRecord | null;
  /** `null` mientras no este anulada. */
  readonly voided: SaleVoidRecord | null;
}

/** Una venta tal como quedo guardada. */
export interface SaleRecord extends SaleHeader {
  /** En el orden en que el dispositivo las vendio. */
  readonly lines: readonly SaleLineRecord[];
  readonly payments: readonly PaymentRecord[];
}

/** El listado va de la venta mas reciente a la mas vieja; la posicion es (hora efectiva en milisegundos, id). */
export interface SaleListRequest {
  readonly limit: number;
  readonly after?: readonly [string, string];
  /** Solo las ventas de turnos de esta persona (un cajero ve las suyas). */
  readonly shiftOwnerId?: string;
  readonly shiftId?: string;
  /** `true`: las que piden atencion y nadie ha revisado. `false`: las demas. */
  readonly attention?: boolean;
  /** El folio exacto, el guardado o el que trajo el dispositivo. */
  readonly folio?: string;
}

/** Puerto de salida: las ventas del negocio de la unidad de trabajo (C3-03, ADR 0027). */
export interface SaleRepository {
  /**
   * Guarda la venta, sus lineas y sus cobros. Un folio que ya es de otra venta no la rechaza: la venta se guarda con
   * otro folio (`AA-000142~0a1b2c3d`) y marcada como conflicto (ADR 0016). La operacion ya debe estar reclamada.
   */
  create(sale: NewSale): Promise<SaleRecord>;
  /** La venta que una operacion registro, o `null` si no registro ninguna. */
  findByOperation(operationId: string): Promise<SaleRecord | null>;
  find(id: string): Promise<SaleRecord | null>;
  /** La venta que una operacion de anular anulo, o `null` si esa operacion no anulo ninguna. */
  findByVoid(operationId: string): Promise<SaleRecord | null>;
  list(request: SaleListRequest): Promise<SaleHeader[]>;
  /**
   * Agrega la revision de una venta que ya existe. Una venta se revisa una vez: si ya tenia revision, no agrega otra y
   * devuelve la que habia (`created: false`).
   */
  review(
    saleId: string,
    userId: string,
    note: string | null,
  ): Promise<{ review: SaleReviewRecord; created: boolean }>;
  /**
   * Agrega la anulacion de la venta y la devuelve tal como queda. Una venta se anula una vez: si ya lo estaba (por ejemplo, otra
   * peticion la anulo a la vez), lanza `SaleVoidedError` y la transaccion entera se deshace.
   */
  recordVoid(request: NewSaleVoid): Promise<SaleRecord>;
}
