import type { Page } from '../../model/pagination.js';
import type { PurchaseRecord, PurchaseSummary } from '../out/purchases.js';
import type { WarehouseRecord } from '../out/stock.js';
import type { SupplierRecord } from '../out/suppliers.js';
import type { Session } from './authenticate.js';

export type SupplierView = SupplierRecord;
export type PurchaseView = PurchaseRecord;
export type PurchaseSummaryView = PurchaseSummary;
export type WarehouseView = WarehouseRecord;

/** El resultado de registrar una compra: si `replayed`, ya existia (mismo `operationId`, mismo cuerpo) y no se hizo nada. */
export interface PurchaseOutcome {
  readonly purchase: PurchaseView;
  readonly replayed: boolean;
}

/**
 * Puertos de entrada de proveedores y compras (C2-06). Cada metodo recibe la sesion de quien llama y lo que mando SIN
 * validar (`unknown`). Todo esto es de la gerencia (`purchase:create`); la bodega la ven los tres roles (`stock:view`).
 */
export interface Suppliers {
  list(session: Session, query: unknown): Promise<Page<SupplierView>>;
  create(session: Session, body: unknown): Promise<SupplierView>;
  update(session: Session, supplierId: string, body: unknown): Promise<SupplierView>;
  remove(session: Session, supplierId: string): Promise<void>;
}

export interface Purchases {
  create(session: Session, body: unknown): Promise<PurchaseOutcome>;
  list(session: Session, query: unknown): Promise<Page<PurchaseSummaryView>>;
  get(session: Session, purchaseId: string): Promise<PurchaseView>;
}

export interface Warehouses {
  get(session: Session): Promise<WarehouseView>;
}
