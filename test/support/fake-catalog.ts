import {
  BarcodeTakenError,
  CategoryInUseError,
  CategoryNameTakenError,
  CategoryNotFoundError,
  ProductNotFoundError,
  SkuTakenError,
} from '../../src/domain/model/catalog-errors.js';
import type { NewProduct, ProductChange } from '../../src/domain/model/product-input.js';
import type {
  CatalogRepository,
  CategoryRecord,
  ListRequest,
  ProductFilter,
  ProductRecord,
} from '../../src/domain/ports/out/catalog.js';

const byNameThenId = <T extends { name: string; id: string }>(a: T, b: T): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

const after = <T extends { name: string; id: string }>(
  rows: T[],
  position: readonly [string, string] | undefined,
): T[] =>
  position === undefined
    ? rows
    : rows.filter(
        (row) => row.name > position[0] || (row.name === position[0] && row.id > position[1]),
      );

/** El catalogo de un negocio en memoria. Hace lo mismo que el adaptador de Prisma, sin base. */
export class FakeCatalog implements CatalogRepository {
  readonly categories: CategoryRecord[] = [];
  readonly products: ProductRecord[] = [];
  /** Productos que ya tienen movimientos de stock. */
  readonly moved = new Set<string>();
  private counter = 0;

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}-0000-4000-8000-${String(this.counter).padStart(12, '0')}`;
  }

  listCategories(request: ListRequest): Promise<CategoryRecord[]> {
    const sorted = [...this.categories].sort(byNameThenId);
    return Promise.resolve(after(sorted, request.after).slice(0, request.limit));
  }

  findCategory(id: string): Promise<CategoryRecord | null> {
    return Promise.resolve(this.categories.find((category) => category.id === id) ?? null);
  }

  createCategory(name: string): Promise<CategoryRecord> {
    if (this.categories.some((category) => category.name.toLowerCase() === name.toLowerCase())) {
      return Promise.reject(new CategoryNameTakenError());
    }
    const category = {
      id: this.nextId('c0000000'),
      name,
      createdAt: new Date('2026-10-17T12:00:00.000Z'),
    };
    this.categories.push(category);
    return Promise.resolve(category);
  }

  renameCategory(id: string, name: string): Promise<CategoryRecord> {
    const index = this.categories.findIndex((category) => category.id === id);
    const current = this.categories[index];
    if (current === undefined) return Promise.reject(new CategoryNotFoundError());
    if (
      this.categories.some(
        (category) => category.id !== id && category.name.toLowerCase() === name.toLowerCase(),
      )
    ) {
      return Promise.reject(new CategoryNameTakenError());
    }
    const renamed = { ...current, name };
    this.categories[index] = renamed;
    return Promise.resolve(renamed);
  }

  deleteCategory(id: string): Promise<void> {
    if (this.products.some((product) => product.categoryId === id)) {
      return Promise.reject(new CategoryInUseError());
    }
    const index = this.categories.findIndex((category) => category.id === id);
    if (index < 0) return Promise.reject(new CategoryNotFoundError());
    this.categories.splice(index, 1);
    return Promise.resolve();
  }

  listProducts(request: ListRequest & { filter: ProductFilter }): Promise<ProductRecord[]> {
    const { search, categoryId, active } = request.filter;
    let rows = [...this.products].sort(byNameThenId);
    if (search !== undefined) {
      const needle = search.toLowerCase();
      rows = rows.filter(
        (product) =>
          product.name.toLowerCase().includes(needle) ||
          product.sku.toLowerCase().includes(needle) ||
          product.barcode === search,
      );
    }
    if (categoryId !== undefined)
      rows = rows.filter((product) => product.categoryId === categoryId);
    if (active !== undefined) rows = rows.filter((product) => product.active === active);
    return Promise.resolve(after(rows, request.after).slice(0, request.limit));
  }

  findProduct(id: string): Promise<ProductRecord | null> {
    return Promise.resolve(this.products.find((product) => product.id === id) ?? null);
  }

  hasStockMovements(productId: string): Promise<boolean> {
    return Promise.resolve(this.moved.has(productId));
  }

  createProduct(product: NewProduct): Promise<ProductRecord> {
    const clash = this.clash(undefined, product.sku.key, product.barcode?.key);
    if (clash !== undefined) return Promise.reject(clash);
    const record: ProductRecord = {
      id: this.nextId('f0000000'),
      name: product.name,
      sku: product.sku.value,
      barcode: product.barcode?.value ?? null,
      unit: product.unit,
      unitPrice: product.unitPrice,
      taxRateBp: product.taxRateBp,
      active: true,
      categoryId: product.categoryId,
      minStockMilli: product.minStockMilli,
      createdAt: new Date('2026-10-17T12:00:00.000Z'),
      updatedAt: new Date('2026-10-17T12:00:00.000Z'),
    };
    this.products.push(record);
    return Promise.resolve(record);
  }

  updateProduct(id: string, change: ProductChange): Promise<ProductRecord> {
    const index = this.products.findIndex((product) => product.id === id);
    const current = this.products[index];
    if (current === undefined) return Promise.reject(new ProductNotFoundError());
    const clash = this.clash(
      id,
      change.sku?.key,
      change.barcode === undefined || change.barcode === null ? undefined : change.barcode.key,
    );
    if (clash !== undefined) return Promise.reject(clash);
    const updated: ProductRecord = {
      ...current,
      name: change.name ?? current.name,
      sku: change.sku?.value ?? current.sku,
      barcode: change.barcode === undefined ? current.barcode : (change.barcode?.value ?? null),
      unit: change.unit ?? current.unit,
      unitPrice: change.unitPrice ?? current.unitPrice,
      taxRateBp: change.taxRateBp ?? current.taxRateBp,
      active: change.active ?? current.active,
      categoryId: change.categoryId === undefined ? current.categoryId : change.categoryId,
      minStockMilli:
        change.minStockMilli === undefined ? current.minStockMilli : change.minStockMilli,
      updatedAt: new Date('2026-10-18T12:00:00.000Z'),
    };
    this.products[index] = updated;
    return Promise.resolve(updated);
  }

  /** El error de unicidad que pondria la base, o nada. Los codigos de barras se comparan por sus 14 digitos. */
  private clash(
    ownId: string | undefined,
    skuKey: string | undefined,
    barcodeKey: string | undefined,
  ): Error | undefined {
    for (const product of this.products) {
      if (product.id === ownId) continue;
      if (skuKey !== undefined && product.sku.toUpperCase() === skuKey) return new SkuTakenError();
      if (
        barcodeKey !== undefined &&
        product.barcode !== null &&
        product.barcode.padStart(14, '0') === barcodeKey
      ) {
        return new BarcodeTakenError();
      }
    }
    return undefined;
  }
}
