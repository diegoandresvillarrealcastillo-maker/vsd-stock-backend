/** No existe ese proveedor en este negocio (o es de otro: el cliente no distingue ambos casos). */
export class SupplierNotFoundError extends Error {
  constructor() {
    super('There is no such supplier in this business');
    this.name = 'SupplierNotFoundError';
  }
}

/** El proveedor tiene compras: las compras son historia y no se tocan, asi que el proveedor se queda. */
export class SupplierInUseError extends Error {
  constructor() {
    super('The supplier still has purchases');
    this.name = 'SupplierInUseError';
  }
}

/** No existe esa compra en este negocio. */
export class PurchaseNotFoundError extends Error {
  constructor() {
    super('There is no such purchase in this business');
    this.name = 'PurchaseNotFoundError';
  }
}

/** El negocio no tiene bodega: no pasa si se creo con el flujo normal, y avisarlo es mejor que inventar una. */
export class WarehouseMissingError extends Error {
  constructor() {
    super('The business has no warehouse');
    this.name = 'WarehouseMissingError';
  }
}

/** Ese `operationId` ya se uso con OTRO cuerpo: dar por aplicada la operacion nueva seria mentir (ADR 0019). */
export class OperationIdReusedError extends Error {
  constructor() {
    super('The operation id was already used with a different request');
    this.name = 'OperationIdReusedError';
  }
}
