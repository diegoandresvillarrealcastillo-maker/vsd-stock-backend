import { ApiProperty } from '@nestjs/swagger';
import type {
  CashMovementView,
  ShiftSummaryView,
  ShiftView,
} from '../../../domain/ports/in/shifts.js';

const DEVICE_TIME = {
  type: String,
  example: '2026-10-18T14:59:50.000Z',
  maxLength: 40,
  description:
    'La hora del reloj del dispositivo al hacer la operación, en ISO 8601 UTC con `Z`. El servidor la corrige con `clockOffsetMs`; una que no se puede leer no se rechaza: se usa la hora de llegada y se marca (ADR 0016).',
} as const;

const CLOCK_OFFSET = {
  type: 'integer',
  required: false,
  nullable: true,
  example: 4000,
  description:
    'Cuántos milisegundos adelanta el servidor al reloj del dispositivo en su última medición contra `GET /health`; `null` o ausente si nunca se midió. No forma parte de la huella de idempotencia: se mide de nuevo en cada intento.',
} as const;

const OPERATION_ID = {
  type: String,
  format: 'uuid',
  description:
    'La clave de idempotencia (ADR 0019): repetir la operación con el mismo `operationId` y los mismos datos no la duplica.',
} as const;

/** Lo que se manda para abrir un turno (C3-02). */
export class OpenShiftRequestDto {
  @ApiProperty(OPERATION_ID)
  readonly operationId!: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    description:
      'El identificador del turno, que crea el dispositivo para poder vender sin haber hablado con el servidor.',
  })
  readonly shiftId!: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'Un dispositivo registrado del negocio.',
  })
  readonly deviceId!: string;

  @ApiProperty({
    type: 'integer',
    minimum: 0,
    maximum: 1_000_000_000_000,
    example: 50000,
    description: 'Pesos enteros con los que arranca la caja.',
  })
  readonly openingAmount!: number;

  @ApiProperty(DEVICE_TIME)
  readonly deviceTime!: string;

  @ApiProperty(CLOCK_OFFSET)
  readonly clockOffsetMs?: number | null;
}

/** Lo que se manda para cerrar un turno: el turno va en la dirección. */
export class CloseShiftRequestDto {
  @ApiProperty(OPERATION_ID)
  readonly operationId!: string;

  @ApiProperty({
    type: 'integer',
    minimum: 0,
    maximum: 1_000_000_000_000,
    example: 187500,
    description: 'Pesos enteros que la persona contó en la caja.',
  })
  readonly countedAmount!: number;

  @ApiProperty(DEVICE_TIME)
  readonly deviceTime!: string;

  @ApiProperty(CLOCK_OFFSET)
  readonly clockOffsetMs?: number | null;
}

/** Lo que se manda para mover efectivo fuera de una venta. */
export class CashMovementRequestDto {
  @ApiProperty(OPERATION_ID)
  readonly operationId!: string;

  @ApiProperty({ type: String, format: 'uuid', description: 'Un turno ABIERTO del negocio.' })
  readonly shiftId!: string;

  @ApiProperty({
    type: String,
    enum: ['in', 'out'],
    description: '`in` entra a la caja, `out` sale.',
  })
  readonly direction!: 'in' | 'out';

  @ApiProperty({
    type: 'integer',
    minimum: 1,
    maximum: 1_000_000_000_000,
    example: 20000,
    description: 'Pesos enteros, de uno en adelante: el sentido lo dice `direction`.',
  })
  readonly amount!: number;

  @ApiProperty({
    type: String,
    maxLength: 200,
    example: 'Pago al proveedor de bebidas',
    description: 'Obligatorio: un movimiento sin motivo es un hueco en la caja.',
  })
  readonly reason!: string;
}

export class ShiftSummaryDto implements ShiftSummaryView {
  @ApiProperty({ type: String, format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  readonly deviceId!: string;

  @ApiProperty({ type: String, format: 'uuid', description: 'La persona del turno.' })
  readonly userId!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'La hora efectiva de la apertura (ADR 0016).',
  })
  readonly openedAt!: Date;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: '`null` mientras el turno sigue abierto.',
  })
  readonly closedAt!: Date | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Quien lo cerró: la persona del turno o alguien de la gerencia.',
  })
  readonly closedByUserId!: string | null;

  @ApiProperty({ type: 'integer', example: 50000 })
  readonly openingAmount!: number;

  @ApiProperty({
    type: 'integer',
    nullable: true,
    description: 'Lo que la persona contó al cerrar; `null` mientras sigue abierto.',
  })
  readonly countedAmount!: number | null;
}

export class LateSalesDto {
  @ApiProperty({ type: 'integer', example: 1 })
  readonly count!: number;

  @ApiProperty({ type: 'integer', example: 4000 })
  readonly cashAmount!: number;
}

/** El arqueo de un turno (ADR 0026). */
export class ShiftCashSummaryDto {
  @ApiProperty({ type: 'integer' })
  readonly openingAmount!: number;

  @ApiProperty({
    type: 'integer',
    description: 'Efectivo cobrado en las ventas del turno que llegaron a tiempo.',
  })
  readonly cashSales!: number;

  @ApiProperty({ type: 'integer', description: 'Efectivo que entró a la caja fuera de una venta.' })
  readonly cashIn!: number;

  @ApiProperty({
    type: 'integer',
    description: 'Efectivo que salió de la caja fuera de una venta (un pago, una devolución).',
  })
  readonly cashOut!: number;

  @ApiProperty({
    type: 'integer',
    description:
      'Lo que debía haber: lo inicial, más lo cobrado, más lo que entró, menos lo que salió.',
  })
  readonly expectedAmount!: number;

  @ApiProperty({ type: 'integer', nullable: true })
  readonly countedAmount!: number | null;

  @ApiProperty({
    type: 'integer',
    nullable: true,
    description:
      'Contado menos esperado: negativo es que falta y positivo que sobra. `null` mientras el turno sigue abierto.',
  })
  readonly difference!: number | null;

  @ApiProperty({
    type: LateSalesDto,
    description:
      'Las ventas que ocurrieron DESPUÉS de cerrarse el turno y llegaron a él (por ejemplo, de un teléfono sin conexión): no entran en lo esperado y se muestran aparte.',
  })
  readonly lateSales!: LateSalesDto;
}

export class ShiftDto extends ShiftSummaryDto implements ShiftView {
  @ApiProperty({ type: ShiftCashSummaryDto })
  readonly summary!: ShiftCashSummaryDto;
}

/** Una página de turnos (ADR 0019). */
export class ShiftPageDto {
  @ApiProperty({ type: [ShiftSummaryDto] })
  readonly items!: ShiftSummaryDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Se pasa tal cual como `cursor` para pedir la página siguiente. `null` si no hay más.',
  })
  readonly nextCursor!: string | null;
}

export class CashMovementDto implements CashMovementView {
  @ApiProperty({ type: String, format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  readonly operationId!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  readonly shiftId!: string;

  @ApiProperty({ type: String, enum: ['in', 'out'] })
  readonly direction!: 'in' | 'out';

  @ApiProperty({ type: 'integer' })
  readonly amount!: number;

  @ApiProperty({ type: String, nullable: true })
  readonly reason!: string | null;
}
