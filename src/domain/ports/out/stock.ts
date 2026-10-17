export interface WarehouseRecord {
  readonly id: string;
  readonly name: string;
}

/** Un cambio de existencia de un producto. Positivo suma, negativo resta; nunca cero. */
export interface StockChange {
  readonly productId: string;
  /** Milesimas de la unidad del producto. */
  readonly delta: number;
  readonly reason: 'purchase' | 'adjustment';
  readonly note: string | null;
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
}
