import { OperationIdReusedError } from '../../domain/model/purchase-errors.js';
import { ShiftClosedError } from '../../domain/model/shift-errors.js';
import {
  CASH_MOVEMENT_FIELDS,
  cashMovementFingerprint,
  readCashMovement,
} from '../../domain/model/shift-input.js';
import { InputReader, ValidationFailedError } from '../../domain/model/validation.js';
import type { Session } from '../../domain/ports/in/authenticate.js';
import type { CashMovementOutcome, CashMovements } from '../../domain/ports/in/shifts.js';
import type { UnitOfWork } from '../../domain/ports/out/unit-of-work.js';
import { ensureCan, requireMember } from '../session-guards.js';

const UNKNOWN_SHIFT = {
  pointer: '/shiftId',
  code: 'unknown-shift',
  detail: 'No existe ese turno en este negocio.',
} as const;

/**
 * Casos de uso del efectivo que entra y sale de un turno fuera de una venta (C3-02, ADR 0026). Es de la gerencia
 * (`cash-movement:create`) y necesita conexion (ADR 0017). Es una operacion idempotente, como una compra. Solo se mueve el
 * efectivo de un turno abierto: el de uno cerrado ya se conto.
 */
export class CashMovementsUseCase implements CashMovements {
  constructor(private readonly work: UnitOfWork) {}

  async create(session: Session, body: unknown): Promise<CashMovementOutcome> {
    const actor = requireMember(session);
    ensureCan(actor, 'cash-movement:create');

    const reader = new InputReader(body, CASH_MOVEMENT_FIELDS);
    const movement = readCashMovement(reader);
    reader.finish();

    return this.work.inBusiness(actor.businessId, async (scope) => {
      const claim = await scope.operations.claim({
        operationId: movement.operationId,
        kind: 'cash_movement',
        userId: actor.userId,
        fingerprint: cashMovementFingerprint(movement),
      });
      if (claim === 'conflict') throw new OperationIdReusedError();
      if (claim === 'replay') {
        const existing = await scope.cashMovements.findByOperation(movement.operationId);
        if (existing === null) {
          throw new Error(`The operation ${movement.operationId} is claimed but has no movement`);
        }
        return { movement: existing, replayed: true };
      }

      const shift = await scope.shifts.find(movement.shiftId);
      if (shift === null) throw new ValidationFailedError([UNKNOWN_SHIFT]);
      if (shift.closedAt !== null) throw new ShiftClosedError();

      return { movement: await scope.cashMovements.create(movement), replayed: false };
    });
  }
}
