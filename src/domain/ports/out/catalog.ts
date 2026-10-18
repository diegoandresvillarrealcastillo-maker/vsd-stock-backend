import type { NewProduct, ProductChange } from '../../model/product-input.js';
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
  findProduct(id: string): Promise<ProductRecord | null>;
  /** Si el producto ya tiene movimientos de stock: desde entonces su unidad no cambia. */
  hasStockMovements(productId: string): Promise<boolean>;
  /** Lanza `SkuTakenError` o `BarcodeTakenError`. */
  createProduct(product: NewProduct): Promise<ProductRecord>;
  /** Lanza `SkuTakenError` o `BarcodeTakenError`. */
  updateProduct(id: string, change: ProductChange): Promise<ProductRecord>;
}
