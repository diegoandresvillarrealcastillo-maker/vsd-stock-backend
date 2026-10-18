import type { ListRequest } from './catalog.js';

export interface PurchaseLineRecord {
  readonly productId: string;
  /** Milesimas de la unidad del producto. */
  readonly quantityMilli: number;
  /** Pesos enteros por unidad. */
  readonly unitCost: number;
}

/** Una compra con todas sus lineas, tal como quedo guardada. */
export interface PurchaseRecord {
  readonly id: string;
  readonly operationId: string;
  readonly warehouseId: string;
  readonly supplierId: string | null;
  readonly note: string | null;
  readonly createdAt: Date;
  readonly createdByUserId: string | null;
  readonly lines: readonly PurchaseLineRecord[];
}

/** Una compra para el listado: sin el detalle de las lineas, que se pide aparte. */
export type PurchaseSummary = Omit<PurchaseRecord, 'lines'> & { readonly lineCount: number };

export interface NewPurchase {
  readonly operationId: string;
  readonly userId: string;
  readonly warehouseId: string;
  readonly supplierId: string | null;
  readonly note: string | null;
  readonly lines: readonly PurchaseLineRecord[];
}

/** El listado va de la mas nueva a la mas vieja; la posicion es (hora de creacion en microsegundos, id). */
export interface PurchaseListRequest extends Omit<ListRequest, 'after'> {
  readonly after?: readonly [string, string];
}

/** Puerto de salida: las compras del negocio de la unidad de trabajo (C2-06). Son historia: no se editan ni se borran. */
export interface PurchaseRepository {
  create(purchase: NewPurchase): Promise<PurchaseRecord>;
  find(id: string): Promise<PurchaseRecord | null>;
  findByOperation(operationId: string): Promise<PurchaseRecord | null>;
  list(request: PurchaseListRequest): Promise<PurchaseSummary[]>;
}
