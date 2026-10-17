/** No existe esa categoria en este negocio (o es de otro: el cliente no distingue ambos casos). */
export class CategoryNotFoundError extends Error {
  constructor() {
    super('There is no such category in this business');
    this.name = 'CategoryNotFoundError';
  }
}

/** No existe ese producto en este negocio. */
export class ProductNotFoundError extends Error {
  constructor() {
    super('There is no such product in this business');
    this.name = 'ProductNotFoundError';
  }
}

/** Ya hay una categoria con ese nombre: el nombre es unico por negocio sin importar mayusculas (ADR 0015). */
export class CategoryNameTakenError extends Error {
  constructor() {
    super('A category with that name already exists');
    this.name = 'CategoryNameTakenError';
  }
}

/** La categoria tiene productos: se mueven o se archivan antes de borrarla. */
export class CategoryInUseError extends Error {
  constructor() {
    super('The category still has products');
    this.name = 'CategoryInUseError';
  }
}

/** Ya hay un producto con ese SKU: es unico por negocio sin importar mayusculas (ADR 0015). */
export class SkuTakenError extends Error {
  constructor() {
    super('A product with that SKU already exists');
    this.name = 'SkuTakenError';
  }
}

/** Ya hay un producto con ese codigo de barras: un UPC-A y el EAN-13 que le antepone un cero son el mismo (ADR 0015). */
export class BarcodeTakenError extends Error {
  constructor() {
    super('A product with that barcode already exists');
    this.name = 'BarcodeTakenError';
  }
}

/** La unidad de un producto con movimientos de stock no cambia: 5 kilos no pueden pasar a ser 5 unidades (ADR 0015). */
export class UnitLockedError extends Error {
  constructor() {
    super('The unit of a product with stock movements cannot change');
    this.name = 'UnitLockedError';
  }
}
