import type { NewProduct, ProductChange } from '../../model/product-input.js';
import type { TaxKind } from '../../model/tax.js';
import type { UnitOfMeasure } from '../../model/unit-of-measure.js';

export interface CategoryRecord {
  readonly id: string;
  readonly name: string;
  readonly createdAt: Date;
}

/** Un producto del catalogo, tal como lo guarda la base. El precio ya incluye el IVA (ADR 0014). */
export interface ProductRecord {
  readonly id: string;
  readonly name: string;
  readonly sku: string;
  readonly barcode: string | null;
  readonly unit: UnitOfMeasure;
  /** Pesos enteros, IVA incluido. */
  readonly unitPrice: number;
  /** Puntos basicos: 0, 500 o 1900. */
  readonly taxRateBp: number;
  /** Gravado, exento o excluido (ADR 0034). */
  readonly taxKind: TaxKind;
  /** `false` si esta archivado: no se vende pero conserva su historia. */
  readonly active: boolean;
  readonly categoryId: string | null;
  /** Milesimas de la unidad. */
  readonly minStockMilli: number | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ProductFilter {
  /** Parte del nombre o del SKU, sin importar mayusculas, o el codigo de barras completo. */
  readonly search?: string;
  readonly categoryId?: string;
  readonly active?: boolean;
}

export interface ListRequest {
  readonly limit: number;
  /** La posicion (nombre, id) tras la que sigue la pagina. */
  readonly after?: readonly [string, string];
}

/** La descarga incremental del catalogo para la copia de lectura del dispositivo (ADR 0028). */
export interface ChangedProductsRequest {
  readonly limit: number;
  /** La posicion (hora del cambio al milisegundo, id) tras la que sigue la pagina. */
  readonly after?: readonly [string, string];
  /** Solo lo que cambio DESPUES de este instante; sin el, todo. */
  readonly since?: Date;
}

/**
 * Puerto de salida: el catalogo del negocio de la unidad de trabajo (ADR 0015). Ninguna operacion recibe el negocio.
 * Los errores de unicidad y de uso los lanza el adaptador como errores del dominio.
 */
export interface CatalogRepository {
  listCategories(request: ListRequest): Promise<CategoryRecord[]>;
  findCategory(id: string): Promise<CategoryRecord | null>;
  /** Lanza `CategoryNameTakenError`. */
  createCategory(name: string): Promise<CategoryRecord>;
  /** Lanza `CategoryNameTakenError`. */
  renameCategory(id: string, name: string): Promise<CategoryRecord>;
  /** Lanza `CategoryInUseError` si tiene productos. */
  deleteCategory(id: string): Promise<void>;

  listProducts(request: ListRequest & { filter: ProductFilter }): Promise<ProductRecord[]>;
  /**
   * Los productos que cambiaron, del cambio mas viejo al mas nuevo (y por id si son de la misma hora). Incluye los archivados:
   * el dispositivo los quita de su copia. La hora se compara al milisegundo, como la lleva el cursor.
   */
  listProductsChanged(request: ChangedProductsRequest): Promise<ProductRecord[]>;
  findProduct(id: string): Promise<ProductRecord | null>;
  /** Los productos de esos identificadores que existen en el negocio, en cualquier orden y sin repetir. */
  findProducts(ids: readonly string[]): Promise<ProductRecord[]>;
  /** Si el producto ya tiene movimientos de stock: desde entonces su unidad no cambia. */
  hasStockMovements(productId: string): Promise<boolean>;
  /** Lanza `SkuTakenError` o `BarcodeTakenError`. */
  createProduct(product: NewProduct): Promise<ProductRecord>;
  /** Lanza `SkuTakenError` o `BarcodeTakenError`. */
  updateProduct(id: string, change: ProductChange): Promise<ProductRecord>;
}
