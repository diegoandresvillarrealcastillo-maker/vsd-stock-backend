import { ProductNotFoundError } from '../../domain/model/catalog-errors.js';
import {
  endsInUuid,
  pageOf,
  readPageRequest,
  timeThenUuid,
  type Page,
} from '../../domain/model/pagination.js';
import { InputReader } from '../../domain/model/validation.js';
import type { Session } from '../../domain/ports/in/authenticate.js';
import type { Stock, StockMovementView, StockView } from '../../domain/ports/in/inventory.js';
import type { StockFilter } from '../../domain/ports/out/stock.js';
import type { UnitOfWork } from '../../domain/ports/out/unit-of-work.js';
import { ensureCan, requireMember } from '../session-guards.js';

const MAX_SEARCH_LENGTH = 80;

/**
 * Consultas de la existencia (C2-07, ADR 0013): lo que hay de cada producto y la historia de cada uno. La existencia es
 * la suma del libro; aqui solo se lee. La ven los tres roles (`stock:view`, ADR 0017).
 */
export class StockUseCase implements Stock {
  constructor(private readonly work: UnitOfWork) {}

  async list(session: Session, query: unknown): Promise<Page<StockView>> {
    const actor = requireMember(session);
    ensureCan(actor, 'stock:view');

    const reader = new InputReader(query, [
      'limit',
      'cursor',
      'search',
      'categoryId',
      'active',
      'belowMinimum',
    ]);
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
    const belowMinimum = reader.oneOf('belowMinimum', ['true', 'false'] as const, {
      label: 'El filtro de existencia mínima',
      optional: true,
    });
    reader.finish();

    const filter: StockFilter = {
      ...(search === undefined ? {} : { search }),
      ...(categoryId === undefined ? {} : { categoryId }),
      ...(active === undefined ? {} : { active: active === 'true' }),
      ...(belowMinimum === undefined ? {} : { belowMinimum: belowMinimum === 'true' }),
    };
    const [afterName, afterId] = request.after ?? [];
    const rows = await this.work.inBusiness(actor.businessId, (scope) =>
      scope.stock.list({
        // Una de mas: si llega, hay otra pagina.
        limit: request.limit + 1,
        filter,
        ...(afterName !== undefined && afterId !== undefined
          ? { after: [afterName, afterId] as const }
          : {}),
      }),
    );
    return pageOf(rows, request.limit, (stock) => [stock.name, stock.productId]);
  }

  async movements(session: Session, query: unknown): Promise<Page<StockMovementView>> {
    const actor = requireMember(session);
    ensureCan(actor, 'stock:view');

    const reader = new InputReader(query, ['limit', 'cursor', 'productId']);
    const request = readPageRequest(reader, 2, timeThenUuid);
    const productId = reader.uuid('productId', { label: 'El identificador del producto' });
    reader.finish();

    const [afterAt, afterId] = request.after ?? [];
    const rows = await this.work.inBusiness(actor.businessId, async (scope) => {
      // El historial de lo que no existe no es una lista vacia: es otra cosa, y se dice.
      if ((await scope.catalog.findProduct(productId)) === null) throw new ProductNotFoundError();
      return scope.stock.movements(productId, {
        // Una de mas: si llega, hay otra pagina.
        limit: request.limit + 1,
        ...(afterAt !== undefined && afterId !== undefined
          ? { after: [afterAt, afterId] as const }
          : {}),
      });
    });
    return pageOf(rows, request.limit, (movement) => [
      movement.createdAt.toISOString(),
      movement.id,
    ]);
  }
}
