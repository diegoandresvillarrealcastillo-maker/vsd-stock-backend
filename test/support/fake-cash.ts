import {
  ShiftAlreadyOpenError,
  ShiftClosedError,
  ShiftIdReusedError,
  ShiftNotFoundError,
} from '../../src/domain/model/shift-errors.js';
import type { ShiftCashTotals } from '../../src/domain/model/shift-summary.js';
import type {
  CashMovementRecord,
  CashMovementRepository,
  NewCashMovement,
  NewShift,
  ShiftClosing,
  ShiftListRequest,
  ShiftRecord,
  ShiftRepository,
} from '../../src/domain/ports/out/shifts.js';

export const NO_TOTALS: ShiftCashTotals = {
  cashSales: 0,
  cashIn: 0,
  cashOut: 0,
  late: { count: 0, cashAmount: 0 },
};

const newestFirst = (a: ShiftRecord, b: ShiftRecord): number =>
  b.openedAt.getTime() - a.openedAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/** Los turnos de un negocio en memoria. Hace lo mismo que el adaptador de Prisma, sin base. */
export class FakeShifts implements ShiftRepository {
  readonly records: ShiftRecord[] = [];
  /** Lo que «la base» suma de cada turno; la prueba lo fija a mano. */
  readonly totalsOf = new Map<string, ShiftCashTotals>();

  find(id: string): Promise<ShiftRecord | null> {
    return Promise.resolve(this.records.find((shift) => shift.id === id) ?? null);
  }

  /** Cuantas veces se bloqueo un turno para una venta, por turno. */
  readonly locked: string[] = [];

  lockShared(id: string): Promise<ShiftRecord | null> {
    this.locked.push(id);
    return this.find(id);
  }

  list(request: ShiftListRequest): Promise<ShiftRecord[]> {
    const after = request.after;
    const rows = [...this.records]
      .sort(newestFirst)
      .filter((shift) => request.userId === undefined || shift.userId === request.userId)
      .filter((shift) => request.open === undefined || (shift.closedAt === null) === request.open)
      .filter(
        (shift) =>
          after === undefined ||
          shift.openedAt.toISOString() < after[0] ||
          (shift.openedAt.toISOString() === after[0] && shift.id < after[1]),
      );
    return Promise.resolve(rows.slice(0, request.limit));
  }

  open(shift: NewShift): Promise<ShiftRecord> {
    if (this.records.some((existing) => existing.id === shift.id)) {
      return Promise.reject(new ShiftIdReusedError());
    }
    if (
      this.records.some(
        (existing) =>
          existing.closedAt === null &&
          existing.deviceId === shift.deviceId &&
          existing.userId === shift.userId,
      )
    ) {
      return Promise.reject(new ShiftAlreadyOpenError());
    }
    const record: ShiftRecord = {
      id: shift.id,
      deviceId: shift.deviceId,
      userId: shift.userId,
      openedAt: shift.openedAt,
      closedAt: null,
      closedByUserId: null,
      openingAmount: shift.openingAmount,
      countedAmount: null,
    };
    this.records.push(record);
    return Promise.resolve(record);
  }

  close(id: string, closing: ShiftClosing): Promise<ShiftRecord> {
    const index = this.records.findIndex((shift) => shift.id === id);
    const current = this.records[index];
    if (current === undefined) return Promise.reject(new ShiftNotFoundError());
    if (current.closedAt !== null) return Promise.reject(new ShiftClosedError());
    const closed: ShiftRecord = { ...current, ...closing };
    this.records[index] = closed;
    return Promise.resolve(closed);
  }

  totals(id: string): Promise<ShiftCashTotals> {
    return Promise.resolve(this.totalsOf.get(id) ?? NO_TOTALS);
  }
}

/** El efectivo que entra y sale de un turno, en memoria. */
export class FakeCashMovements implements CashMovementRepository {
  readonly records: CashMovementRecord[] = [];
  private counter = 0;

  create(movement: NewCashMovement): Promise<CashMovementRecord> {
    this.counter += 1;
    const record: CashMovementRecord = {
      id: `cc000000-0000-4000-8000-${String(this.counter).padStart(12, '0')}`,
      ...movement,
    };
    this.records.push(record);
    return Promise.resolve(record);
  }

  findByOperation(operationId: string): Promise<CashMovementRecord | null> {
    return Promise.resolve(
      this.records.find((movement) => movement.operationId === operationId) ?? null,
    );
  }
}

/** La caja de un negocio de mentira: turnos y movimientos de efectivo, ya conectados entre si. */
export class FakeCash {
  readonly shifts = new FakeShifts();
  readonly movements = new FakeCashMovements();
}
