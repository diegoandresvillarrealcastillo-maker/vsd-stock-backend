import { ProductNotFoundError, UnitLockedError } from '../../domain/model/catalog-errors.js';
import { endsInUuid, pageOf, readPageRequest, type Page } from '../../domain/model/pagination.js';
import {
  NEW_PRODUCT_FIELDS,
  PRODUCT_CHANGE_FIELDS,
  readNewProduct,
  readProductChange,
} from '../../domain/model/product-input.js';
import { isUuid } from '../../domain/model/uuid.js';
import { InputReader, ValidationFailedError } from '../../domain/model/validation.js';
import type { Session } from '../../domain/ports/in/authenticate.js';
import type { ProductView, Products } from '../../domain/ports/in/catalog.js';
import type { ProductFilter } from '../../domain/ports/out/catalog.js';
import type { BusinessScope, UnitOfWork } from '../../domain/ports/out/unit-of-work.js';
import { ensureCan, requireMember } from '../session-guards.js';

const MAX_SEARCH_LENGTH = 80;

const UNKNOWN_CATEGORY = {
  pointer: '/categoryId',
  code: 'unknown-category',
  detail: 'No existe esa categoría en este negocio.',
} as const;

/** Si la categoria se nombra, tiene que existir en este negocio: es un problema de ESE campo, no un 404 de la ruta. */
async function requireCategory(
  scope: BusinessScope,
  categoryId: string | null | undefined,
): Promise<void> {
  if (categoryId === undefined || categoryId === null) return;
  if ((await scope.catalog.findCategory(categoryId)) === null) {
    throw new ValidationFailedError([UNKNOWN_CATEGORY]);
  }
}

/**
 * Casos de uso de los productos (ADR 0015). Los ven los tres roles; los crea y los cambia la gerencia
 * (`product:manage`) y cambiar el precio pide ademas `price:update` (ADR 0017). No se borran: se archivan con
 * `active: false`, porque tienen historia.
 */
export class ProductsUseCase implements Products {
  constructor(private readonly work: UnitOfWork) {}

  async list(session: Session, query: unknown): Promise<Page<ProductView>> {
    const actor = requireMember(session);
    ensureCan(actor, 'product:view');

    const reader = new InputReader(query, ['limit', 'cursor', 'search', 'categoryId', 'active']);
    const request = readPageRequest(reader, 2, endsInUuid);
    const search = reader.text('search', {
      label: 'La búsqueda',
      max: MAX_SEARCH_LENGTH,
      optional: true,
    });
    const categoryId = reader.uuid('categoryId', {
      label: 'El identificador de la categoría',
      optional: true,
    });
    const active = reader.oneOf('active', ['true', 'false'] as const, {
      label: 'El filtro de alta',
      optional: true,
    });
    reader.finish();

    const filter: ProductFilter = {
      ...(search === undefined ? {} : { search }),
      ...(categoryId === undefined ? {} : { categoryId }),
      ...(active === undefined ? {} : { active: active === 'true' }),
    };
    const [afterName, afterId] = request.after ?? [];
    const rows = await this.work.inBusiness(actor.businessId, (scope) =>
      scope.catalog.listProducts({
        // Una de mas: si llega, hay otra pagina.
        limit: request.limit + 1,
        filter,
        ...(afterName !== undefined && afterId !== undefined
          ? { after: [afterName, afterId] as const }
          : {}),
      }),
    );
    return pageOf(rows, request.limit, (product) => [product.name, product.id]);
  }

  async get(session: Session, productId: string): Promise<ProductView> {
    const actor = requireMember(session);
    ensureCan(actor, 'product:view');
    // Un identificador que no es un UUID no es de nadie: no se le pregunta nada a la base.
    if (!isUuid(productId)) throw new ProductNotFoundError();
    const product = await this.work.inBusiness(actor.businessId, (scope) =>
      scope.catalog.findProduct(productId),
    );
    if (product === null) throw new ProductNotFoundError();
    return product;
  }

  async create(session: Session, body: unknown): Promise<ProductView> {
    const actor = requireMember(session);
    ensureCan(actor, 'product:manage');

    const reader = new InputReader(body, NEW_PRODUCT_FIELDS);
    const product = readNewProduct(reader);
    reader.finish();

    return this.work.inBusiness(actor.businessId, async (scope) => {
      await requireCategory(scope, product.categoryId);
      return scope.catalog.createProduct(product);
    });
  }

  async update(session: Session, productId: string, body: unknown): Promise<ProductView> {
    const actor = requireMember(session);
    ensureCan(actor, 'product:manage');

    const reader = new InputReader(body, PRODUCT_CHANGE_FIELDS);
    const change = readProductChange(reader);
    reader.finish();
    if (change.unitPrice !== undefined) ensureCan(actor, 'price:update');
    if (!isUuid(productId)) throw new ProductNotFoundError();

    return this.work.inBusiness(actor.businessId, async (scope) => {
      const current = await scope.catalog.findProduct(productId);
      if (current === null) throw new ProductNotFoundError();
      await requireCategory(scope, change.categoryId);
      // La unidad no cambia si ya hay movimientos: la base lo impide tambien, pero aqui se dice con su nombre.
      if (
        change.unit !== undefined &&
        change.unit !== current.unit &&
        (await scope.catalog.hasStockMovements(productId))
      ) {
        throw new UnitLockedError();
      }
      return scope.catalog.updateProduct(productId, change);
    });
  }
}
