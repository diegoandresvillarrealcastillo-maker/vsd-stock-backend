import type { CatalogRepository } from './catalog.js';
import type { DeviceRepository } from './devices.js';
import type { OperationRegistry } from './operations.js';
import type { PeopleRepository } from './people.js';
import type { PurchaseRepository } from './purchases.js';
import type { StockLedger } from './stock.js';
import type { SupplierRepository } from './suppliers.js';

/** Lo minimo que se sabe de un negocio. */
export interface BusinessSummary {
  readonly id: string;
  readonly name: string;
}

/** Lectura del negocio de la transaccion en curso. */
export interface BusinessReader {
  /** El negocio de esta unidad de trabajo, o `null` si no existe. Nunca devuelve el de otro. */
  current(): Promise<BusinessSummary | null>;
}

/**
 * Todo lo que una unidad de trabajo puede leer y escribir, en nombre de UN negocio. Cada ticket que necesita datos
 * suma aqui su repositorio (productos, compras...); ninguno recibe el identificador del negocio como parametro:
 * el negocio es de la transaccion y no se puede cambiar a mitad de camino.
 */
export interface BusinessScope {
  readonly businessId: string;
  readonly business: BusinessReader;
  readonly people: PeopleRepository;
  readonly catalog: CatalogRepository;
  readonly suppliers: SupplierRepository;
  readonly purchases: PurchaseRepository;
  readonly stock: StockLedger;
  readonly operations: OperationRegistry;
  readonly devices: DeviceRepository;
}

/**
 * Puerto de salida: ejecutar trabajo contra la base de datos de un negocio (ADR 0005 y 0021).
 *
 * Una unidad de trabajo es UNA transaccion con el negocio ya fijado para la base: todo lo que escribe se confirma
 * junto o no queda nada, y lo que lee es solo de ese negocio. Las transacciones deben ser cortas: nada de llamadas
 * de red adentro (ADR 0013).
 */
export interface UnitOfWork {
  inBusiness<T>(businessId: string, work: (scope: BusinessScope) => Promise<T>): Promise<T>;
}
