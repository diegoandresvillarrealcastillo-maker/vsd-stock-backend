/** No existe esa venta en este negocio (o es de un turno ajeno y la persona no puede verlo: el cliente no distingue los casos). */
export class SaleNotFoundError extends Error {
  constructor() {
    super('There is no such sale in this business');
    this.name = 'SaleNotFoundError';
  }
}
