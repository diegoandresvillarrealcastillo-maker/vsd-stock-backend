import type { UnitOfMeasure } from '../../model/unit-of-measure.js';
import type { ListRequest } from './catalog.js';

export interface WarehouseRecord {
  readonly id: string;
  readonly name: string;
}

/** Un cambio de existencia de un producto. Positivo suma, negativo resta; nunca cero. */
export interface StockChange {
  readonly productId: string;
  /** Milesimas de la unidad del producto. */
  readonly delta: number;
  readonly reason: 'purchase' | 'adjustment' | 'sale' | 'void';
  readonly note: string | null;
}

/** La existencia de un producto: lo que hay (la suma de sus movimientos) y el minimo que el negocio fijo. */
export interface StockRecord {
  readonly productId: string;
  readonly name: string;
  readonly sku: string;
  readonly unit: UnitOfMeasure;
  /** `false` si el producto esta archivado. */
  readonly active: boolean;
  /** Milesimas de la unidad. Un producto sin movimientos tiene cero. */
  readonly quantityMilli: number;
  /** Milesimas de la unidad, o `null` si el negocio no fijo un minimo. */
  readonly minStockMilli: number | null;
  /** Hay un minimo y la existencia esta por debajo de el (estrictamente menos: igual al minimo no avisa). */
  readonly belowMinimum: boolean;
}

export interface StockFilter {
  /** Parte del nombre o del SKU, sin importar mayusculas, o el codigo de barras completo. */
  readonly search?: string;
  readonly categoryId?: string;
  readonly active?: boolean;
  /** Solo los que tienen minimo y estan por debajo de el. */
  readonly belowMinimum?: boolean;
}

export type StockMovementKind = 'sale' | 'purchase' | 'adjustment' | 'void';

/** Un movimiento del libro, tal como quedo escrito. Nunca se edita. */
export interface StockMovementRecord {
  readonly id: string;
  readonly operationId: string;
  readonly productId: string;
  readonly kind: StockMovementKind;
  /** Milesimas de la unidad; negativo si resta. */
  readonly deltaMilli: number;
  /** La nota del movimiento: en un ajuste, el motivo; en una compra, la nota de la compra. */
  readonly reason: string | null;
  readonly createdAt: Date;
}

/** El historial va de lo mas nuevo a lo mas viejo; la posicion es (instante al milisegundo, id). */
export interface MovementListRequest {
  readonly limit: number;
  readonly after?: readonly [string, string];
}

/** La existencia de un producto, para la copia de lectura del dispositivo. */
export interface StockLevel {
  readonly productId: string;
  /** Milesimas de la unidad del producto; puede ser negativa (ADR 0013). */
  readonly quantityMilli: number;
}

/** La descarga incremental de existencias (ADR 0028). */
export interface ChangedStockRequest {
  readonly limit: number;
  /** El ultimo producto de la pagina anterior. */
  readonly after?: string;
  /** Solo los productos con un movimiento DESPUES de este instante; sin el, todos los que alguna vez se movieron. */
  readonly since?: Date;
}

/**
 * Puerto de salida: el libro de existencias del negocio (ADR 0013). La existencia no se edita: se agregan movimientos
 * y el saldo lo mantiene la base en la misma transaccion.
 */
export interface StockLedger {
  /** La bodega unica del negocio. Lanza `WarehouseMissingError` si no hay. */
  warehouse(): Promise<WarehouseRecord>;
  /**
   * Agrega los movimientos de una operacion. Los aplica EN EL ORDEN DE LOS PRODUCTOS (por identificador), sea cual sea
   * el orden en que llegan, para que dos transacciones que tocan los mismos productos se turnen en vez de bloquearse
   * una a la otra.
   */
  addMovements(operationId: string, changes: readonly StockChange[]): Promise<void>;
  /**
   * Lo que hay ahora de esos productos (milesimas), leido dentro de la transaccion: despues de `addMovements` ve los
   * saldos ya actualizados, bajo el candado que esos movimientos tomaron (ADR 0013). Un producto sin movimientos vale cero.
   */
  quantitiesOf(productIds: readonly string[]): Promise<ReadonlyMap<string, number>>;
  /** La existencia de cada producto, por nombre e id. Un producto sin movimientos aparece con cero. */
  list(request: ListRequest & { filter: StockFilter }): Promise<StockRecord[]>;
  /**
   * Los productos que se movieron (despues de `since`, si se dice) con su existencia de ahora, ordenados por producto. Un producto
   * que nunca se movio no aparece: vale cero.
   */
  listStockChanged(request: ChangedStockRequest): Promise<StockLevel[]>;
  /** El historial de un producto: de lo mas nuevo a lo mas viejo. */
  movements(productId: string, request: MovementListRequest): Promise<StockMovementRecord[]>;
  /** El primer movimiento que escribio una operacion, o `null` si no escribio ninguno. */
  movementOfOperation(operationId: string): Promise<StockMovementRecord | null>;
}
