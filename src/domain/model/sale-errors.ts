/** No existe esa venta en este negocio (o es de un turno ajeno y la persona no puede verlo: el cliente no distingue los casos). */
export class SaleNotFoundError extends Error {
  constructor() {
    super('There is no such sale in this business');
    this.name = 'SaleNotFoundError';
  }
}

/** La venta ya esta anulada: se anula una sola vez (ADR 0027, punto 13). */
export class SaleVoidedError extends Error {
  constructor() {
    super('The sale is already voided');
    this.name = 'SaleVoidedError';
  }
}
