import type { CashDirection } from '../../model/shift-input.js';
import type { ShiftCashTotals } from '../../model/shift-summary.js';

/** Un turno de caja tal como quedo guardado. */
export interface ShiftRecord {
  readonly id: string;
  readonly deviceId: string;
  readonly userId: string;
  readonly openedAt: Date;
  /** `null` mientras el turno sigue abierto. */
  readonly closedAt: Date | null;
  readonly closedByUserId: string | null;
  /** Pesos enteros con los que arranco la caja. */
  readonly openingAmount: number;
  /** Pesos enteros que la persona conto al cerrar; `null` mientras sigue abierto. */
  readonly countedAmount: number | null;
}

export interface NewShift {
  readonly id: string;
  readonly deviceId: string;
  readonly userId: string;
  readonly openedAt: Date;
  readonly openingAmount: number;
}

export interface ShiftClosing {
  readonly closedAt: Date;
  readonly closedByUserId: string;
  readonly countedAmount: number;
}

/** El listado va del turno mas nuevo al mas viejo; la posicion es (hora de apertura en milisegundos, id). */
export interface ShiftListRequest {
  readonly limit: number;
  readonly after?: readonly [string, string];
  /** Solo los turnos de esta persona. */
  readonly userId?: string;
  /** Solo los abiertos (`true`) o solo los cerrados (`false`). */
  readonly open?: boolean;
}

/** Puerto de salida: los turnos de caja del negocio de la unidad de trabajo (C3-02, ADR 0026). */
export interface ShiftRepository {
  find(id: string): Promise<ShiftRecord | null>;
  /**
   * Lee el turno y lo deja bloqueado en modo compartido hasta el final de la transaccion: cerrarlo espera a que la venta
   * que lo bloqueo termine, asi el arqueo no pierde ninguna (ADR 0013). Se llama al final de la venta, para que el
   * candado dure lo minimo.
   */
  lockShared(id: string): Promise<ShiftRecord | null>;
  list(request: ShiftListRequest): Promise<ShiftRecord[]>;
  /**
   * Abre el turno. Lanza `ShiftAlreadyOpenError` si la persona ya tiene uno abierto en ese dispositivo y `ShiftIdReusedError`
   * si el identificador ya es de otro turno.
   */
  open(shift: NewShift): Promise<ShiftRecord>;
  /**
   * Cierra el turno. Lanza `ShiftNotFoundError` si no existe y `ShiftClosedError` si ya estaba cerrado: cerrar espera a las
   * ventas en curso (ADR 0013), asi que el arqueo no se pierde ninguna.
   */
  close(id: string, closing: ShiftClosing): Promise<ShiftRecord>;
  /** Lo que se suma del turno para su arqueo. */
  totals(id: string): Promise<ShiftCashTotals>;
}

export interface CashMovementRecord {
  readonly id: string;
  readonly operationId: string;
  readonly shiftId: string;
  readonly direction: CashDirection;
  readonly amount: number;
  readonly reason: string | null;
}

export interface NewCashMovement {
  readonly operationId: string;
  readonly shiftId: string;
  readonly direction: CashDirection;
  readonly amount: number;
  readonly reason: string;
}

/** Puerto de salida: el efectivo que entra y sale de un turno fuera de una venta (C3-02). */
export interface CashMovementRepository {
  create(movement: NewCashMovement): Promise<CashMovementRecord>;
  findByOperation(operationId: string): Promise<CashMovementRecord | null>;
}
