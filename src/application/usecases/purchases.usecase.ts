import {
  type FieldError,
  InputReader,
  ValidationFailedError,
} from '../../domain/model/validation.js';
import { pageOf, readPageRequest, timeThenUuid, type Page } from '../../domain/model/pagination.js';
import {
  PURCHASE_FIELDS,
  purchaseFingerprint,
  readPurchase,
  type PurchaseInput,
} from '../../domain/model/purchase-input.js';
import {
  OperationIdReusedError,
  PurchaseNotFoundError,
} from '../../domain/model/purchase-errors.js';
import { isWholeOnly } from '../../domain/model/unit-of-measure.js';
import { isUuid } from '../../domain/model/uuid.js';
import type { Session } from '../../domain/ports/in/authenticate.js';
import type {
  PurchaseOutcome,
  PurchaseSummaryView,
  PurchaseView,
  Purchases,
} from '../../domain/ports/in/purchasing.js';
import type { BusinessScope, UnitOfWork } from '../../domain/ports/out/unit-of-work.js';
import { ensureCan, requireMember } from '../session-guards.js';

/** Los problemas que solo la base puede decir: aparecen con el puntero del campo que los causa, como los demas. */
const UNKNOWN_SUPPLIER: FieldError = {
  pointer: '/supplierId',
  code: 'unknown-supplier',
  detail: 'No existe ese proveedor en este negocio.',
};

const unknownProduct = (index: number): FieldError => ({
  pointer: `/lines/${index}/productId`,
  code: 'unknown-product',
  detail: 'No existe ese producto en este negocio.',
});

const archivedProduct = (index: number): FieldError => ({
  pointer: `/lines/${index}/productId`,
  code: 'archived-product',
  detail: 'Este producto está archivado: reactívalo antes de comprarlo.',
});

const notWhole = (index: number): FieldError => ({
  pointer: `/lines/${index}/quantityMilli`,
  code: 'not-whole',
  detail: 'Este producto se cuenta en unidades enteras: la cantidad no lleva decimales.',
});

/** Una unidad entera son mil milesimas. */
const MILLI_PER_UNIT = 1000;

/**
 * Lo que la compra nombra tiene que existir en ESTE negocio y poderse comprar: el proveedor, los productos (activos) y
 * cantidades que la unidad de cada producto admita. Junta todos los problemas, en el orden del cuerpo.
 */
async function checkAgainstBusiness(scope: BusinessScope, purchase: PurchaseInput): Promise<void> {
  const errors: FieldError[] = [];
  if (purchase.supplierId !== null && (await scope.suppliers.find(purchase.supplierId)) === null) {
    errors.push(UNKNOWN_SUPPLIER);
  }
  const found = await scope.catalog.findProducts(purchase.lines.map((line) => line.productId));
  const byId = new Map(found.map((product) => [product.id, product]));
  purchase.lines.forEach((line, index) => {
    const product = byId.get(line.productId);
    if (product === undefined) {
      errors.push(unknownProduct(index));
    } else if (!product.active) {
      errors.push(archivedProduct(index));
    } else if (isWholeOnly(product.unit) && line.quantityMilli % MILLI_PER_UNIT !== 0) {
      errors.push(notWhole(index));
    }
  });
  if (errors.length > 0) throw new ValidationFailedError(errors);
}

/**
 * Casos de uso de las compras (C2-06, ADR 0013 y 0019). Registrar una compra es UNA operacion idempotente: la compra,
 * sus lineas y los movimientos que suben la existencia se guardan en la misma transaccion o no se guarda nada. La
 * gerencia las hace y las ve (`purchase:create`); son historia: no se editan ni se anulan.
 */
export class PurchasesUseCase implements Purchases {
  constructor(private readonly work: UnitOfWork) {}

  async create(session: Session, body: unknown): Promise<PurchaseOutcome> {
    const actor = requireMember(session);
    ensureCan(actor, 'purchase:create');

    const reader = new InputReader(body, PURCHASE_FIELDS);
    const purchase = readPurchase(reader);
    reader.finish();
    const fingerprint = purchaseFingerprint(purchase);

    return this.work.inBusiness(actor.businessId, async (scope) => {
      // Primero se reclama la operacion: dos peticiones iguales a la vez se turnan en este punto, y la segunda ve
      // lo que la primera dejo. Si algo falla despues, el reclamo se deshace con todo lo demas.
      const claim = await scope.operations.claim({
        operationId: purchase.operationId,
        kind: 'purchase',
        userId: actor.userId,
        fingerprint,
      });
      if (claim === 'conflict') throw new OperationIdReusedError();
      if (claim === 'replay') {
        // Repetida: se entrega lo que ya se hizo, sin volver a mirar si los productos siguen vigentes.
        const existing = await scope.purchases.findByOperation(purchase.operationId);
        if (existing === null) {
          throw new Error(`The operation ${purchase.operationId} is claimed but has no purchase`);
        }
        return { purchase: existing, replayed: true };
      }

      await checkAgainstBusiness(scope, purchase);
      const warehouse = await scope.stock.warehouse();
      const saved = await scope.purchases.create({
        operationId: purchase.operationId,
        userId: actor.userId,
        warehouseId: warehouse.id,
        supplierId: purchase.supplierId,
        note: purchase.note,
        lines: purchase.lines,
      });
      await scope.stock.addMovements(
        purchase.operationId,
        purchase.lines.map((line) => ({
          productId: line.productId,
          delta: line.quantityMilli,
          reason: 'purchase' as const,
          note: purchase.note,
        })),
      );
      return { purchase: saved, replayed: false };
    });
  }

  async list(session: Session, query: unknown): Promise<Page<PurchaseSummaryView>> {
    const actor = requireMember(session);
    ensureCan(actor, 'purchase:create');

    const reader = new InputReader(query, ['limit', 'cursor']);
    const request = readPageRequest(reader, 2, timeThenUuid);
    reader.finish();

    const [afterAt, afterId] = request.after ?? [];
    const rows = await this.work.inBusiness(actor.businessId, (scope) =>
      scope.purchases.list({
        // Una de mas: si llega, hay otra pagina.
        limit: request.limit + 1,
        ...(afterAt !== undefined && afterId !== undefined
          ? { after: [afterAt, afterId] as const }
          : {}),
      }),
    );
    return pageOf(rows, request.limit, (purchase) => [
      purchase.createdAt.toISOString(),
      purchase.id,
    ]);
  }

  async get(session: Session, purchaseId: string): Promise<PurchaseView> {
    const actor = requireMember(session);
    ensureCan(actor, 'purchase:create');
    // Un identificador que no es un UUID no es de nadie: no se le pregunta nada a la base.
    if (!isUuid(purchaseId)) throw new PurchaseNotFoundError();
    const purchase = await this.work.inBusiness(actor.businessId, (scope) =>
      scope.purchases.find(purchaseId),
    );
    if (purchase === null) throw new PurchaseNotFoundError();
    return purchase;
  }
}
