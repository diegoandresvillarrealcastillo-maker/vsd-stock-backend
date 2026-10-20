import type { Page } from '../../model/pagination.js';
import type { ShiftCashSummary } from '../../model/shift-summary.js';
import type { CashMovementRecord, ShiftRecord } from '../out/shifts.js';
import type { Session } from './authenticate.js';

export type CashMovementView = CashMovementRecord;

/** Un turno con su arqueo. */
export interface ShiftView extends ShiftRecord {
  readonly summary: ShiftCashSummary;
}

/** Un turno del listado: sin el arqueo, que se pide aparte. */
export type ShiftSummaryView = ShiftRecord;

/** El resultado de abrir o cerrar un turno: si `replayed`, ya se habia hecho (mismo `operationId`, mismo cuerpo). */
export interface ShiftOutcome {
  readonly shift: ShiftView;
  readonly replayed: boolean;
}

export interface CashMovementOutcome {
  readonly movement: CashMovementView;
  readonly replayed: boolean;
}

/**
 * Puertos de entrada de los turnos de caja y del efectivo (C3-02). Cada metodo recibe la sesion de quien llama y lo que
 * mando SIN validar (`unknown`). Abrir y cerrar son operaciones idempotentes (ADR 0019) que un dispositivo tambien hace sin
 * conexion; mover efectivo fuera de una venta es de la gerencia y necesita conexion (ADR 0017).
 */
export interface Shifts {
  open(session: Session, body: unknown): Promise<ShiftOutcome>;
  close(session: Session, shiftId: string, body: unknown): Promise<ShiftOutcome>;
  list(session: Session, query: unknown): Promise<Page<ShiftSummaryView>>;
  get(session: Session, shiftId: string): Promise<ShiftView>;
}

export interface CashMovements {
  create(session: Session, body: unknown): Promise<CashMovementOutcome>;
}
