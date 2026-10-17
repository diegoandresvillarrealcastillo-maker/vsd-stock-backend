import {
  BarcodeTakenError,
  CategoryInUseError,
  CategoryNameTakenError,
  SkuTakenError,
} from '../../../domain/model/catalog-errors.js';
import type { NewProduct, ProductChange } from '../../../domain/model/product-input.js';
import { isUnitOfMeasure } from '../../../domain/model/unit-of-measure.js';
import type {
  CatalogRepository,
  CategoryRecord,
  ListRequest,
  ProductFilter,
  ProductRecord,
} from '../../../domain/ports/out/catalog.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import type { PrismaTransaction } from './prisma-unit-of-work.js';

const CATEGORY_SELECT = { id: true, name: true, createdAt: true } as const;

const PRODUCT_SELECT = {
  id: true,
  name: true,
  sku: true,
  barcode: true,
  unit: true,
  unitPrice: true,
  taxRateBp: true,
  active: true,
  categoryId: true,
  minStockMilli: true,
  createdAt: true,
  updatedAt: true,
} as const;

interface ProductRow {
  readonly id: string;
  readonly name: string;
  readonly sku: string;
  readonly barcode: string | null;
  readonly unit: string;
  readonly unitPrice: bigint;
  readonly taxRateBp: number;
  readonly active: boolean;
  readonly categoryId: string | null;
  readonly minStockMilli: bigint | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function productOf(row: ProductRow): ProductRecord {
  if (!isUnitOfMeasure(row.unit)) {
    // La base lo impide con una restriccion; si llegara aqui, mejor caer que dar una unidad que no existe.
    throw new Error(`The product ${row.id} has a unit that does not exist`);
  }
  return {
    id: row.id,
    name: row.name,
    sku: row.sku,
    barcode: row.barcode,
    unit: row.unit,
    // La base los limita a un billon (ADR 0014): un `number` los guarda sin perder un peso.
    unitPrice: Number(row.unitPrice),
    taxRateBp: row.taxRateBp,
    active: row.active,
    categoryId: row.categoryId,
    minStockMilli: row.minStockMilli === null ? null : Number(row.minStockMilli),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Lo que dijo la base cuando una restriccion de unicidad o de clave foranea fallo, como texto para buscar su nombre. */
function violationOf(error: unknown): { code: string; text: string } | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { code, meta, message } = error as { code?: unknown; meta?: unknown; message?: unknown };
  if (code !== 'P2002' && code !== 'P2003') return undefined;
  const text =
    `${JSON.stringify(meta ?? {})} ${typeof message === 'string' ? message : ''}`.toLowerCase();
  return { code, text };
}

/** Pasa a error del dominio lo que la base rechazo por unicidad, y deja pasar todo lo demas. */
function asProductError(error: unknown): never {
  const violation = violationOf(error);
  if (violation?.code === 'P2002') {
    if (violation.text.includes('barcode')) throw new BarcodeTakenError();
    if (violation.text.includes('sku')) throw new SkuTakenError();
  }
  throw error;
}

/**
 * Prisma no escapa los comodines de LIKE: buscar «100%» o «A_R» sin esto compararia con «cualquier cosa». Con la barra
 * invertida, que es el escape por omision de PostgreSQL, se buscan como los caracteres que son.
 */
function literal(text: string): string {
  return text.replace(/[\\%_]/g, '\\$&');
}

function after(position: readonly [string, string] | undefined) {
  // Por nombre y luego por id: la misma posicion que el cursor, que no cambia si alguien se suma.
  return position === undefined
    ? {}
    : { OR: [{ name: { gt: position[0] } }, { name: position[0], id: { gt: position[1] } }] };
}

function productWhere(request: ListRequest & { filter: ProductFilter }): Prisma.ProductWhereInput {
  const { search, categoryId, active } = request.filter;
  return {
    AND: [
      after(request.after),
      ...(search === undefined
        ? []
        : [
            {
              OR: [
                { name: { contains: literal(search), mode: 'insensitive' as const } },
                { sku: { contains: literal(search), mode: 'insensitive' as const } },
                { barcode: search },
              ],
            },
          ]),
      ...(categoryId === undefined ? [] : [{ categoryId }]),
      ...(active === undefined ? [] : [{ active }]),
    ],
  };
}

/**
 * El catalogo del negocio de la transaccion, sobre Prisma. La seguridad por fila de la base deja ver y escribir solo lo de ese
 * negocio; las claves de comparacion (SKU en mayusculas, codigo de barras de 14 digitos, nombre en minusculas) las calcula la
 * base (ADR 0015), asi que ninguna ruta puede olvidarlas.
 */
export class PrismaCatalogRepository implements CatalogRepository {
  constructor(
    private readonly tx: PrismaTransaction,
    private readonly businessId: string,
  ) {}

  async listCategories(request: ListRequest): Promise<CategoryRecord[]> {
    return this.tx.category.findMany({
      where: after(request.after),
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: request.limit,
      select: CATEGORY_SELECT,
    });
  }

  async findCategory(id: string): Promise<CategoryRecord | null> {
    return this.tx.category.findFirst({ where: { id }, select: CATEGORY_SELECT });
  }

  async createCategory(name: string): Promise<CategoryRecord> {
    try {
      return await this.tx.category.create({
        data: { idNegocio: this.businessId, name },
        select: CATEGORY_SELECT,
      });
    } catch (error) {
      if (violationOf(error)?.code === 'P2002') throw new CategoryNameTakenError();
      throw error;
    }
  }

  async renameCategory(id: string, name: string): Promise<CategoryRecord> {
    try {
      return await this.tx.category.update({
        where: { id },
        data: { name },
        select: CATEGORY_SELECT,
      });
    } catch (error) {
      if (violationOf(error)?.code === 'P2002') throw new CategoryNameTakenError();
      throw error;
    }
  }

  async deleteCategory(id: string): Promise<void> {
    try {
      await this.tx.category.delete({ where: { id } });
    } catch (error) {
      if (violationOf(error)?.code === 'P2003') throw new CategoryInUseError();
      throw error;
    }
  }

  async listProducts(request: ListRequest & { filter: ProductFilter }): Promise<ProductRecord[]> {
    const rows = await this.tx.product.findMany({
      where: productWhere(request),
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: request.limit,
      select: PRODUCT_SELECT,
    });
    return rows.map(productOf);
  }

  async findProduct(id: string): Promise<ProductRecord | null> {
    const row = await this.tx.product.findFirst({ where: { id }, select: PRODUCT_SELECT });
    return row === null ? null : productOf(row);
  }

  async hasStockMovements(productId: string): Promise<boolean> {
    return (await this.tx.stockMovement.count({ where: { productId }, take: 1 })) > 0;
  }

  async createProduct(product: NewProduct): Promise<ProductRecord> {
    try {
      const row = await this.tx.product.create({
        data: {
          idNegocio: this.businessId,
          name: product.name,
          sku: product.sku.value,
          barcode: product.barcode?.value ?? null,
          unit: product.unit,
          unitPrice: BigInt(product.unitPrice),
          taxRateBp: product.taxRateBp,
          categoryId: product.categoryId,
          minStockMilli: product.minStockMilli === null ? null : BigInt(product.minStockMilli),
        },
        select: PRODUCT_SELECT,
      });
      return productOf(row);
    } catch (error) {
      return asProductError(error);
    }
  }

  async updateProduct(id: string, change: ProductChange): Promise<ProductRecord> {
    try {
      const row = await this.tx.product.update({
        where: { id },
        data: {
          ...(change.name === undefined ? {} : { name: change.name }),
          ...(change.sku === undefined ? {} : { sku: change.sku.value }),
          ...(change.barcode === undefined ? {} : { barcode: change.barcode?.value ?? null }),
          ...(change.unit === undefined ? {} : { unit: change.unit }),
          ...(change.unitPrice === undefined ? {} : { unitPrice: BigInt(change.unitPrice) }),
          ...(change.taxRateBp === undefined ? {} : { taxRateBp: change.taxRateBp }),
          ...(change.categoryId === undefined ? {} : { categoryId: change.categoryId }),
          ...(change.minStockMilli === undefined
            ? {}
            : {
                minStockMilli: change.minStockMilli === null ? null : BigInt(change.minStockMilli),
              }),
          ...(change.active === undefined ? {} : { active: change.active }),
          updatedAt: new Date(),
        },
        select: PRODUCT_SELECT,
      });
      return productOf(row);
    } catch (error) {
      return asProductError(error);
    }
  }
}
