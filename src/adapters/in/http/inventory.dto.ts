import { ApiProperty } from '@nestjs/swagger';
import type { UnitOfMeasure } from '../../../domain/model/unit-of-measure.js';
import type { StockMovementView, StockView } from '../../../domain/ports/in/inventory.js';
import type { StockMovementKind } from '../../../domain/ports/out/stock.js';

const UNITS = ['unit', 'kilogram', 'gram', 'pound', 'liter', 'milliliter'] as const;
const KINDS = ['sale', 'purchase', 'adjustment', 'void'] as const;

/** Lo que se manda para ajustar la existencia de un producto (C2-07, ADR 0013 y 0019). */
export class CreateStockAdjustmentRequestDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description:
      'La llave de idempotencia: la genera el cliente una vez por ajuste. Repetir la petición con el mismo `operationId` y los mismos datos devuelve el mismo movimiento (200 y `Idempotent-Replayed: true`) sin ajustar de nuevo; con otros datos, 409 `operation-id-reused`.',
  })
  readonly operationId!: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'Un producto del negocio, archivado o no.',
  })
  readonly productId!: string;

  @ApiProperty({
    type: 'integer',
    minimum: -1_000_000_000,
    maximum: 1_000_000_000,
    example: -2000,
    description:
      'Cuánto sube (positivo) o baja (negativo) la existencia, en milésimas de la unidad del producto; nunca cero. Los productos que se cuentan en unidades enteras no admiten decimales. **No es el saldo nuevo:** el saldo no se edita, el ajuste es un movimiento.',
  })
  readonly deltaMilli!: number;

  @ApiProperty({
    type: String,
    maxLength: 500,
    example: 'Se cayeron dos paquetes',
    description: 'Por qué se ajusta. Es obligatorio y queda escrito en el movimiento.',
  })
  readonly reason!: string;
}

export class StockMovementDto implements StockMovementView {
  @ApiProperty({ type: String, format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  readonly operationId!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  readonly productId!: string;

  @ApiProperty({ type: String, enum: [...KINDS], description: 'Qué lo originó.' })
  readonly kind!: StockMovementKind;

  @ApiProperty({
    type: 'integer',
    description: 'Milésimas de la unidad del producto; negativo si resta.',
  })
  readonly deltaMilli!: number;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'La nota del movimiento: en un ajuste, el motivo; en una compra, la nota de la compra.',
  })
  readonly reason!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  readonly createdAt!: Date;
}

/** Una página del historial de un producto (ADR 0019). */
export class StockMovementPageDto {
  @ApiProperty({ type: [StockMovementDto] })
  readonly items!: StockMovementDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Se pasa tal cual como `cursor` para pedir la página siguiente. `null` si no hay más.',
  })
  readonly nextCursor!: string | null;
}

export class StockDto implements StockView {
  @ApiProperty({ type: String, format: 'uuid' })
  readonly productId!: string;

  @ApiProperty({ type: String, example: 'Arroz 500 g' })
  readonly name!: string;

  @ApiProperty({ type: String, example: 'ARR-500' })
  readonly sku!: string;

  @ApiProperty({ type: String, enum: [...UNITS] })
  readonly unit!: UnitOfMeasure;

  @ApiProperty({ type: Boolean, description: '`false` si el producto está archivado.' })
  readonly active!: boolean;

  @ApiProperty({
    type: 'integer',
    description:
      'Lo que hay: la suma de los movimientos del producto, en milésimas de su unidad. Un producto que nunca se movió tiene cero; puede ser negativa (una venta sin conexión que se aceptó).',
  })
  readonly quantityMilli!: number;

  @ApiProperty({
    type: 'integer',
    nullable: true,
    description: 'El mínimo que fijó el negocio, o `null` si no fijó uno.',
  })
  readonly minStockMilli!: number | null;

  @ApiProperty({
    type: Boolean,
    description:
      'Hay un mínimo y la existencia está **por debajo** de él (igual al mínimo no avisa).',
  })
  readonly belowMinimum!: boolean;
}

/** Una página de existencias (ADR 0019). */
export class StockPageDto {
  @ApiProperty({ type: [StockDto] })
  readonly items!: StockDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Se pasa tal cual como `cursor` para pedir la página siguiente. `null` si no hay más.',
  })
  readonly nextCursor!: string | null;
}
