import { ApiProperty } from '@nestjs/swagger';
import type {
  PurchaseSummaryView,
  PurchaseView,
  SupplierView,
  WarehouseView,
} from '../../../domain/ports/in/purchasing.js';

/** Lo que se manda para crear un proveedor (C2-06). Para cambiarlo se manda lo mismo, y al menos un campo. */
export class SupplierRequestDto {
  @ApiProperty({ type: String, maxLength: 120, example: 'Distribuidora El Sol' })
  readonly name!: string;

  @ApiProperty({
    type: String,
    maxLength: 200,
    required: false,
    nullable: true,
    example: '300 123 4567',
    description: 'Un teléfono, un correo o lo que sirva para llamar. Al cambiar, `null` lo borra.',
  })
  readonly contact?: string | null;
}

export class SupplierDto implements SupplierView {
  @ApiProperty({ type: String, format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ type: String, example: 'Distribuidora El Sol' })
  readonly name!: string;

  @ApiProperty({ type: String, nullable: true, example: '300 123 4567' })
  readonly contact!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  readonly createdAt!: Date;
}

/** Una página de proveedores (ADR 0019). */
export class SupplierPageDto {
  @ApiProperty({ type: [SupplierDto] })
  readonly items!: SupplierDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Se pasa tal cual como `cursor` para pedir la página siguiente. `null` si no hay más.',
  })
  readonly nextCursor!: string | null;
}

export class WarehouseDto implements WarehouseView {
  @ApiProperty({ type: String, format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ type: String, example: 'Principal' })
  readonly name!: string;
}

/** Una línea de la compra que se manda: un producto, cuánto y a cómo salió cada unidad. */
export class PurchaseLineRequestDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'Un producto activo del negocio. No puede repetirse en otra línea: júntalas.',
  })
  readonly productId!: string;

  @ApiProperty({
    type: 'integer',
    minimum: 1,
    maximum: 1_000_000_000,
    example: 24_000,
    description:
      'Milésimas de la unidad del producto: 24 unidades son 24000 y kilo y medio es 1500. Los productos que se cuentan en unidades enteras no admiten decimales.',
  })
  readonly quantityMilli!: number;

  @ApiProperty({
    type: 'integer',
    minimum: 0,
    maximum: 1_000_000_000_000,
    example: 2500,
    description: 'Pesos enteros que costó cada unidad.',
  })
  readonly unitCost!: number;
}

/** Lo que se manda para registrar una compra (C2-06, ADR 0019). */
export class CreatePurchaseRequestDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description:
      'La llave de idempotencia: la genera el cliente una vez por compra. Repetir la petición con el mismo `operationId` y los mismos datos devuelve la misma compra (200 y `Idempotent-Replayed: true`) sin sumar de nuevo; con otros datos, 409 `operation-id-reused`.',
  })
  readonly operationId!: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    nullable: true,
    description: 'Un proveedor del negocio. Es opcional.',
  })
  readonly supplierId?: string | null;

  @ApiProperty({ type: String, maxLength: 500, required: false, nullable: true })
  readonly note?: string | null;

  @ApiProperty({
    type: [PurchaseLineRequestDto],
    minItems: 1,
    maxItems: 200,
    description: 'Un producto por línea.',
  })
  readonly lines!: PurchaseLineRequestDto[];
}

export class PurchaseLineDto {
  @ApiProperty({ type: String, format: 'uuid' })
  readonly productId!: string;

  @ApiProperty({ type: 'integer', description: 'Milésimas de la unidad del producto.' })
  readonly quantityMilli!: number;

  @ApiProperty({ type: 'integer', description: 'Pesos enteros por unidad.' })
  readonly unitCost!: number;
}

/** Una compra para el listado: sin el detalle de las líneas, que se pide aparte. */
export class PurchaseSummaryDto implements PurchaseSummaryView {
  @ApiProperty({ type: String, format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  readonly operationId!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  readonly warehouseId!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  readonly supplierId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  readonly note!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  readonly createdAt!: Date;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  readonly createdByUserId!: string | null;

  @ApiProperty({ type: 'integer', description: 'Cuántas líneas tiene la compra.' })
  readonly lineCount!: number;
}

export class PurchaseDto implements PurchaseView {
  @ApiProperty({ type: String, format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  readonly operationId!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  readonly warehouseId!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  readonly supplierId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  readonly note!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  readonly createdAt!: Date;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  readonly createdByUserId!: string | null;

  @ApiProperty({ type: [PurchaseLineDto], description: 'Ordenadas por producto.' })
  readonly lines!: PurchaseLineDto[];
}

/** Una página de compras (ADR 0019). */
export class PurchasePageDto {
  @ApiProperty({ type: [PurchaseSummaryDto] })
  readonly items!: PurchaseSummaryDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Se pasa tal cual como `cursor` para pedir la página siguiente. `null` si no hay más.',
  })
  readonly nextCursor!: string | null;
}
