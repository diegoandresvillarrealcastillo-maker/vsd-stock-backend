import { ValidationFailedError, InputReader } from '../../domain/model/validation.js';
import { OperationIdReusedError } from '../../domain/model/purchase-errors.js';
import {
  ADJUSTMENT_FIELDS,
  adjustmentFingerprint,
  readAdjustment,
} from '../../domain/model/stock-input.js';
import { isWholeOnly } from '../../domain/model/unit-of-measure.js';
import type { Session } from '../../domain/ports/in/authenticate.js';
import type { AdjustmentOutcome, StockAdjustments } from '../../domain/ports/in/inventory.js';
import { ensureCan, requireMember } from '../session-guards.js';
import type { UnitOfWork } from '../../domain/ports/out/unit-of-work.js';

const UNKNOWN_PRODUCT = {
  pointer: '/productId',
  code: 'unknown-product',
  detail: 'No existe ese producto en este negocio.',
} as const;

const NOT_WHOLE = {
  pointer: '/deltaMilli',
  code: 'not-whole',
  detail: 'Este producto se cuenta en unidades enteras: la cantidad no lleva decimales.',
} as const;

/** Una unidad entera son mil milesimas. */
const MILLI_PER_UNIT = 1000;

/**
 * Casos de uso de los ajustes de existencia (C2-07, ADR 0013 y 0019). Un ajuste es UN movimiento nuevo del libro con su
 * motivo: nunca una edicion del saldo, que el disparador de la base mantiene. Es de la gerencia (`stock:adjust`, ADR 0017)
 * y una operacion idempotente, como una compra.
 */
export class StockAdjustmentsUseCase implements StockAdjustments {
  constructor(private readonly work: UnitOfWork) {}

  async adjust(session: Session, body: unknown): Promise<AdjustmentOutcome> {
    const actor = requireMember(session);
    ensureCan(actor, 'stock:adjust');

    const reader = new InputReader(body, ADJUSTMENT_FIELDS);
    const adjustment = readAdjustment(reader);
    reader.finish();

    return this.work.inBusiness(actor.businessId, async (scope) => {
      // Primero se reclama la operacion (ver `PurchasesUseCase`): repetida con el mismo cuerpo devuelve lo hecho.
      const claim = await scope.operations.claim({
        operationId: adjustment.operationId,
        kind: 'adjustment',
        userId: actor.userId,
        fingerprint: adjustmentFingerprint(adjustment),
      });
      if (claim === 'conflict') throw new OperationIdReusedError();
      if (claim === 'replay') {
        const existing = await scope.stock.movementOfOperation(adjustment.operationId);
        if (existing === null) {
          throw new Error(`The operation ${adjustment.operationId} is claimed but has no movement`);
        }
        return { movement: existing, replayed: true };
      }

      // Un producto archivado tambien se ajusta: lo que le queda hay que poder darlo de baja.
      const product = await scope.catalog.findProduct(adjustment.productId);
      if (product === null) throw new ValidationFailedError([UNKNOWN_PRODUCT]);
      if (isWholeOnly(product.unit) && adjustment.deltaMilli % MILLI_PER_UNIT !== 0) {
        throw new ValidationFailedError([NOT_WHOLE]);
      }

      await scope.stock.addMovements(adjustment.operationId, [
        {
          productId: adjustment.productId,
          delta: adjustment.deltaMilli,
          reason: 'adjustment',
          note: adjustment.reason,
        },
      ]);
      const movement = await scope.stock.movementOfOperation(adjustment.operationId);
      if (movement === null) {
        throw new Error(`The adjustment ${adjustment.operationId} vanished inside its transaction`);
      }
      return { movement, replayed: false };
    });
  }
}
