import {
  endsInUuid,
  pageOf,
  readPageRequest,
  timeThenUuid,
} from '../../domain/model/pagination.js';
import { COPY_FIELDS, readCopySince } from '../../domain/model/sync-input.js';
import { InputReader } from '../../domain/model/validation.js';
import type { Session } from '../../domain/ports/in/authenticate.js';
import type { CopyPage, StockCopyRecord, SyncCopy } from '../../domain/ports/in/sync.js';
import type { ProductRecord } from '../../domain/ports/out/catalog.js';
import type { Clock } from '../../domain/ports/out/clock.js';
import type { UnitOfWork } from '../../domain/ports/out/unit-of-work.js';
import { ensureCan, requireMember } from '../session-guards.js';

/**
 * La copia de lectura que el dispositivo guarda para vender sin red (C3-06, ADR 0028): el catalogo y la existencia, completos o
 * solo lo que cambio despues de `since`. Cada pagina dice la hora del servidor al leerla (`asOf`), tomada ANTES de leer, para que
 * el dispositivo la use como `since` la proxima vez sin perder lo que cambio mientras se leia. Los tres roles la leen: un cajero
 * necesita el catalogo para vender (ADR 0017).
 */
export class SyncCopyUseCase implements SyncCopy {
  constructor(
    private readonly work: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  async products(session: Session, query: unknown): Promise<CopyPage<ProductRecord>> {
    const actor = requireMember(session);
    ensureCan(actor, 'product:view');
    const reader = new InputReader(query, COPY_FIELDS);
    const page = readPageRequest(reader, 2, timeThenUuid);
    const since = readCopySince(reader);
    reader.finish();

    const asOf = this.clock.now();
    const [afterAt, afterId] = page.after ?? [];
    const rows = await this.work.inBusiness(actor.businessId, (scope) =>
      scope.catalog.listProductsChanged({
        // Una de mas: si llega, hay otra pagina.
        limit: page.limit + 1,
        ...(afterAt !== undefined && afterId !== undefined
          ? { after: [afterAt, afterId] as const }
          : {}),
        ...(since === undefined ? {} : { since }),
      }),
    );
    return {
      asOf,
      ...pageOf(rows, page.limit, (product) => [product.updatedAt.toISOString(), product.id]),
    };
  }

  async stock(session: Session, query: unknown): Promise<CopyPage<StockCopyRecord>> {
    const actor = requireMember(session);
    ensureCan(actor, 'stock:view');
    const reader = new InputReader(query, COPY_FIELDS);
    const page = readPageRequest(reader, 1, endsInUuid);
    const since = readCopySince(reader);
    reader.finish();

    const asOf = this.clock.now();
    const [after] = page.after ?? [];
    const rows = await this.work.inBusiness(actor.businessId, (scope) =>
      scope.stock.listStockChanged({
        limit: page.limit + 1,
        ...(after === undefined ? {} : { after }),
        ...(since === undefined ? {} : { since }),
      }),
    );
    return { asOf, ...pageOf(rows, page.limit, (level) => [level.productId]) };
  }
}
