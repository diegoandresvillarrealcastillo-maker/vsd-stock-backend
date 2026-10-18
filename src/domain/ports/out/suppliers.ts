import type { NewSupplier, SupplierChange } from '../../model/supplier-input.js';
import type { ListRequest } from './catalog.js';

export interface SupplierRecord {
  readonly id: string;
  readonly name: string;
  readonly contact: string | null;
  readonly createdAt: Date;
}

/**
 * Puerto de salida: los proveedores del negocio de la unidad de trabajo (C2-06). Ninguna operacion recibe el negocio.
 * Los proveedores no tienen unicidad: dos con el mismo nombre son dos tiendas distintas.
 */
export interface SupplierRepository {
  list(request: ListRequest): Promise<SupplierRecord[]>;
  find(id: string): Promise<SupplierRecord | null>;
  create(supplier: NewSupplier): Promise<SupplierRecord>;
  /** Lanza `SupplierNotFoundError`. */
  update(id: string, change: SupplierChange): Promise<SupplierRecord>;
  /** Lanza `SupplierNotFoundError` y `SupplierInUseError` si tiene compras. */
  remove(id: string): Promise<void>;
}
