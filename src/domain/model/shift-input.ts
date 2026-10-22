import { MAX_PESOS } from './money.js';
import {
  OPERATION_TIME_FIELDS,
  readOperationTime,
  type OperationTimeInput,
} from './operation-time-input.js';
import type { InputReader } from './validation.js';

/** Los campos de cada operacion de la caja. La hora del dispositivo viaja con las que el dispositivo hace sin conexion. */
export const SHIFT_OPENING_FIELDS = [
  'operationId',
  'shiftId',
  'deviceId',
  'openingAmount',
  ...OPERATION_TIME_FIELDS,
] as const;
/** El turno que se cierra va en la direccion, no en el cuerpo. */
export const SHIFT_CLOSING_FIELDS = [
  'operationId',
  'countedAmount',
  ...OPERATION_TIME_FIELDS,
] as const;
export const CASH_MOVEMENT_FIELDS = [
  'operationId',
  'shiftId',
  'direction',
  'amount',
  'reason',
] as const;

/** `cash_movement_reason_shape` (ADR 0021). */
const MAX_REASON_LENGTH = 200;

export const CASH_DIRECTIONS = ['in', 'out'] as const;
export type CashDirection = (typeof CASH_DIRECTIONS)[number];

export interface ShiftOpeningInput {
  /** La clave de idempotencia (ADR 0019). */
  readonly operationId: string;
  /** El identificador del turno, que crea el dispositivo para poder vender sin haber hablado con el servidor (ADR 0026). */
  readonly shiftId: string;
  readonly deviceId: string;
  /** Pesos enteros con los que arranca la caja. */
  readonly openingAmount: number;
  readonly time: OperationTimeInput;
}

export interface ShiftClosingInput {
  readonly operationId: string;
  /** Pesos enteros que la persona conto en la caja. */
  readonly countedAmount: number;
  readonly time: OperationTimeInput;
}

export interface CashMovementInput {
  readonly operationId: string;
  readonly shiftId: string;
  readonly direction: CashDirection;
  /** Pesos enteros, de uno en adelante: el sentido lo dice `direction`. */
  readonly amount: number;
  readonly reason: string;
}

/** Lee la apertura de un turno. Los problemas quedan en el lector; el llamador llama a `finish()` antes de usar el resultado. */
export function readShiftOpening(reader: InputReader): ShiftOpeningInput {
  const operationId = reader.uuid('operationId', { label: 'El identificador de la operación' });
  const shiftId = reader.uuid('shiftId', { label: 'El identificador del turno' });
  const deviceId = reader.uuid('deviceId', { label: 'El identificador del dispositivo' });
  const openingAmount = reader.integer('openingAmount', {
    label: 'El efectivo inicial',
    min: 0,
    max: MAX_PESOS,
  });
  return {
    operationId: operationId.toLowerCase(),
    shiftId: shiftId.toLowerCase(),
    deviceId: deviceId.toLowerCase(),
    openingAmount,
    time: readOperationTime(reader),
  };
}

/** Lee el cierre de un turno. Los problemas quedan en el lector; el llamador llama a `finish()` antes de usar el resultado. */
export function readShiftClosing(reader: InputReader): ShiftClosingInput {
  const operationId = reader.uuid('operationId', { label: 'El identificador de la operación' });
  const countedAmount = reader.integer('countedAmount', {
    label: 'El efectivo contado',
    min: 0,
    max: MAX_PESOS,
  });
  return {
    operationId: operationId.toLowerCase(),
    countedAmount,
    time: readOperationTime(reader),
  };
}

/** Lee un movimiento de efectivo. Los problemas quedan en el lector; el llamador llama a `finish()` antes de usar el resultado. */
export function readCashMovement(reader: InputReader): CashMovementInput {
  const operationId = reader.uuid('operationId', { label: 'El identificador de la operación' });
  const shiftId = reader.uuid('shiftId', { label: 'El identificador del turno' });
  const direction = reader.oneOf('direction', CASH_DIRECTIONS, { label: 'El sentido' });
  const amount = reader.integer('amount', { label: 'El monto', min: 1, max: MAX_PESOS });
  const reason = reader.text('reason', { label: 'El motivo', max: MAX_REASON_LENGTH });
  return {
    operationId: operationId.toLowerCase(),
    shiftId: shiftId.toLowerCase(),
    direction,
    amount,
    reason,
  };
}

/**
 * Las huellas: el mismo texto para la misma peticion, escrita como se escriba el cuerpo. Se guardan con la operacion para
 * que reusar un `operationId` con OTRO cuerpo responda 409 (ADR 0019). No incluyen el `operationId`. La diferencia del reloj
 * (`clockOffsetMs`) tampoco: el dispositivo la mide de nuevo en cada intento, y un reintento sigue siendo el mismo cuerpo.
 */
export function shiftOpeningFingerprint(opening: ShiftOpeningInput): string {
  return JSON.stringify({
    shiftId: opening.shiftId,
    deviceId: opening.deviceId,
    openingAmount: opening.openingAmount,
    deviceTime: opening.time.deviceTime,
  });
}

export function shiftClosingFingerprint(shiftId: string, closing: ShiftClosingInput): string {
  return JSON.stringify({
    shiftId: shiftId.toLowerCase(),
    countedAmount: closing.countedAmount,
    deviceTime: closing.time.deviceTime,
  });
}

export function cashMovementFingerprint(movement: CashMovementInput): string {
  return JSON.stringify({
    shiftId: movement.shiftId,
    direction: movement.direction,
    amount: movement.amount,
    reason: movement.reason,
  });
}
