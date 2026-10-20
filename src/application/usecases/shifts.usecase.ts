import { OperationIdReusedError } from '../../domain/model/purchase-errors.js';
import { resolveReceivedOperation } from '../../domain/model/operation-time-input.js';
import { pageOf, readPageRequest, timeThenUuid, type Page } from '../../domain/model/pagination.js';
import { can } from '../../domain/model/role.js';
import {
  SHIFT_CLOSING_FIELDS,
  SHIFT_OPENING_FIELDS,
  readShiftClosing,
  readShiftOpening,
  shiftClosingFingerprint,
  shiftOpeningFingerprint,
} from '../../domain/model/shift-input.js';
import { ShiftClosedError, ShiftNotFoundError } from '../../domain/model/shift-errors.js';
import { summarizeShift } from '../../domain/model/shift-summary.js';
import { isUuid } from '../../domain/model/uuid.js';
import { InputReader, ValidationFailedError } from '../../domain/model/validation.js';
import type { Session } from '../../domain/ports/in/authenticate.js';
import type {
  ShiftOutcome,
  ShiftSummaryView,
  ShiftView,
  Shifts,
} from '../../domain/ports/in/shifts.js';
import type { Clock } from '../../domain/ports/out/clock.js';
import type { ShiftRecord } from '../../domain/ports/out/shifts.js';
import type { BusinessScope, UnitOfWork } from '../../domain/ports/out/unit-of-work.js';
import { ensureCan, requireMember } from '../session-guards.js';

const OPEN_FILTER = ['true', 'false'] as const;

const UNKNOWN_DEVICE = {
  pointer: '/deviceId',
  code: 'unknown-device',
  detail: 'No existe ese dispositivo en este negocio.',
} as const;

/** El turno con su arqueo: lo guardado mas lo que la base suma de el. */
async function viewOf(scope: BusinessScope, shift: ShiftRecord): Promise<ShiftView> {
  const totals = await scope.shifts.totals(shift.id);
  return { ...shift, summary: summarizeShift(shift, totals) };
}

/**
 * Casos de uso de los turnos de caja (C3-02, ADR 0026). Abrir y cerrar son operaciones idempotentes con la hora del
 * dispositivo (ADR 0016 y 0019): las hace cualquier persona, y las que un dispositivo hizo sin conexion llegan por aqui
 * mismo. La persona ve sus turnos; la gerencia, los de todos (`sale:view-all`).
 */
export class ShiftsUseCase implements Shifts {
  constructor(
    private readonly work: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  async open(session: Session, body: unknown): Promise<ShiftOutcome> {
    const actor = requireMember(session);
    ensureCan(actor, 'shift:open');

    const reader = new InputReader(body, SHIFT_OPENING_FIELDS);
    const opening = readShiftOpening(reader);
    reader.finish();
    const times = resolveReceivedOperation(opening.time, this.clock.now());

    return this.work.inBusiness(actor.businessId, async (scope) => {
      // El dispositivo se mira antes de reclamar: la operacion lo nombra y la base lo exige.
      if ((await scope.devices.find(opening.deviceId)) === null) {
        throw new ValidationFailedError([UNKNOWN_DEVICE]);
      }
      const claim = await scope.operations.claim({
        operationId: opening.operationId,
        kind: 'shift_open',
        userId: actor.userId,
        fingerprint: shiftOpeningFingerprint(opening),
        deviceId: opening.deviceId,
        times,
      });
      if (claim === 'conflict') throw new OperationIdReusedError();
      if (claim === 'replay') {
        const existing = await scope.shifts.find(opening.shiftId);
        if (existing === null) {
          throw new Error(`The operation ${opening.operationId} is claimed but has no shift`);
        }
        return { shift: await viewOf(scope, existing), replayed: true };
      }

      const shift = await scope.shifts.open({
        id: opening.shiftId,
        deviceId: opening.deviceId,
        userId: actor.userId,
        openedAt: times.occurredAt,
        openingAmount: opening.openingAmount,
      });
      return { shift: await viewOf(scope, shift), replayed: false };
    });
  }

  async close(session: Session, shiftId: string, body: unknown): Promise<ShiftOutcome> {
    const actor = requireMember(session);

    const reader = new InputReader(body, SHIFT_CLOSING_FIELDS);
    const closing = readShiftClosing(reader);
    reader.finish();
    // Un identificador que no es un UUID no es de nadie: no se le pregunta nada a la base.
    if (!isUuid(shiftId)) throw new ShiftNotFoundError();
    const id = shiftId.toLowerCase();
    const times = resolveReceivedOperation(closing.time, this.clock.now());

    return this.work.inBusiness(actor.businessId, async (scope) => {
      const shift = await scope.shifts.find(id);
      if (shift === null) throw new ShiftNotFoundError();
      // Cerrar el propio turno es de todos; cerrar el de otra persona es de la gerencia (ADR 0017).
      ensureCan(actor, shift.userId === actor.userId ? 'shift:close' : 'shift:close-other');

      const claim = await scope.operations.claim({
        operationId: closing.operationId,
        kind: 'shift_close',
        userId: actor.userId,
        fingerprint: shiftClosingFingerprint(id, closing),
        times,
      });
      if (claim === 'conflict') throw new OperationIdReusedError();
      if (claim === 'replay') {
        // Se vuelve a leer: si otra peticion igual la tenia reclamada, esta espero a que terminara y el turno que se leyo
        // arriba es el de antes de su cierre.
        const closed = await scope.shifts.find(id);
        if (closed === null) throw new Error(`The shift ${id} vanished inside its transaction`);
        return { shift: await viewOf(scope, closed), replayed: true };
      }
      if (shift.closedAt !== null) throw new ShiftClosedError();

      const closed = await scope.shifts.close(id, {
        // Un reloj que se fue hacia atras no cierra un turno antes de abrirlo.
        closedAt: times.occurredAt < shift.openedAt ? shift.openedAt : times.occurredAt,
        closedByUserId: actor.userId,
        countedAmount: closing.countedAmount,
      });
      return { shift: await viewOf(scope, closed), replayed: false };
    });
  }

  async list(session: Session, query: unknown): Promise<Page<ShiftSummaryView>> {
    const actor = requireMember(session);
    ensureCan(actor, 'sale:view-own-shift');

    const reader = new InputReader(query, ['limit', 'cursor', 'open']);
    const request = readPageRequest(reader, 2, timeThenUuid);
    const open =
      reader.raw('open') === undefined
        ? undefined
        : reader.oneOf('open', OPEN_FILTER, { label: 'El filtro de abiertos' }) === 'true';
    reader.finish();

    const [afterAt, afterId] = request.after ?? [];
    const rows = await this.work.inBusiness(actor.businessId, (scope) =>
      scope.shifts.list({
        // Una de mas: si llega, hay otra pagina.
        limit: request.limit + 1,
        ...(afterAt !== undefined && afterId !== undefined
          ? { after: [afterAt, afterId] as const }
          : {}),
        ...(can(actor.role, 'sale:view-all') ? {} : { userId: actor.userId }),
        ...(open === undefined ? {} : { open }),
      }),
    );
    return pageOf(rows, request.limit, (shift) => [shift.openedAt.toISOString(), shift.id]);
  }

  async get(session: Session, shiftId: string): Promise<ShiftView> {
    const actor = requireMember(session);
    ensureCan(actor, 'sale:view-own-shift');
    if (!isUuid(shiftId)) throw new ShiftNotFoundError();

    return this.work.inBusiness(actor.businessId, async (scope) => {
      const shift = await scope.shifts.find(shiftId.toLowerCase());
      // El turno de otra persona no existe para quien no puede verlos todos: no se le dice que existe.
      if (shift === null || (!can(actor.role, 'sale:view-all') && shift.userId !== actor.userId)) {
        throw new ShiftNotFoundError();
      }
      return viewOf(scope, shift);
    });
  }
}
