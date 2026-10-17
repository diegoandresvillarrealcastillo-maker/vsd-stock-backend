import { ApiProperty } from '@nestjs/swagger';
import type { UnitOfMeasure } from '../../../domain/model/unit-of-measure.js';
import type { CategoryView, ProductView } from '../../../domain/ports/in/catalog.js';

const UNITS = ['unit', 'kilogram', 'gram', 'pound', 'liter', 'milliliter'] as const;

/** Lo que se manda para crear o renombrar una categoria. */
export class CategoryRequestDto {
  @ApiProperty({
    type: String,
    maxLength: 120,
    example: 'Granos',
    description: 'Único en el negocio sin importar mayúsculas.',
  })
  readonly name!: string;
}

export class CategoryDto implements CategoryView {
  @ApiProperty({ type: String, format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ type: String, example: 'Granos' })
  readonly name!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  readonly createdAt!: Date;
}

/** Una página de categorías (ADR 0019). */
export class CategoryPageDto {
  @ApiProperty({ type: [CategoryDto] })
  readonly items!: CategoryDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Se pasa tal cual como `cursor` para pedir la página siguiente. `null` si no hay más.',
  })
  readonly nextCursor!: string | null;
}

/** Lo que se manda para crear un producto (ADR 0015): un producto nuevo nace activo. */
export class CreateProductRequestDto {
  @ApiProperty({ type: String, maxLength: 120, example: 'Arroz 500 g' })
  readonly name!: string;

  @ApiProperty({
    type: String,
    maxLength: 40,
    example: 'ARR-500',
    description:
      'El código interno del negocio: letras sin acento, dígitos y `. _ / -`, con espacios sueltos entre grupos. Único en el negocio sin importar mayúsculas.',
  })
  readonly sku!: string;

  @ApiProperty({
    type: String,
    required: false,
    nullable: true,
    example: '7701234567897',
    description:
      'GTIN de 8, 12, 13 o 14 dígitos con su dígito de control. Único en el negocio: un UPC-A y el EAN-13 que le antepone un cero son el mismo. `null` o ausente: sin código de barras.',
  })
  readonly barcode?: string | null;

  @ApiProperty({
    type: String,
    enum: [...UNITS],
    description: 'Cada presentación (unidad, paca, caja) es otro producto.',
  })
  readonly unit!: UnitOfMeasure;

  @ApiProperty({
    type: 'integer',
    minimum: 0,
    maximum: 1_000_000_000_000,
    example: 3200,
    description: 'Pesos enteros, con el IVA incluido (ADR 0014).',
  })
  readonly unitPrice!: number;

  @ApiProperty({
    type: 'integer',
    enum: [0, 500, 1900],
    example: 0,
    description: 'La tarifa de IVA en puntos básicos: 0 (0 %), 500 (5 %) o 1900 (19 %).',
  })
  readonly taxRateBp!: number;

  @ApiProperty({ type: String, format: 'uuid', required: false, nullable: true })
  readonly categoryId?: string | null;

  @ApiProperty({
    type: 'integer',
    minimum: 0,
    maximum: 1_000_000_000,
    required: false,
    nullable: true,
    description: 'Existencia mínima en milésimas de la unidad, para la alerta de stock mínimo.',
  })
  readonly minStockMilli?: number | null;
}

/** Lo que se manda para cambiar un producto: al menos un campo. */
export class UpdateProductRequestDto {
  @ApiProperty({ type: String, maxLength: 120, required: false })
  readonly name?: string;

  @ApiProperty({ type: String, maxLength: 40, required: false })
  readonly sku?: string;

  @ApiProperty({
    type: String,
    required: false,
    nullable: true,
    description: '`null` borra el código de barras.',
  })
  readonly barcode?: string | null;

  @ApiProperty({
    type: String,
    enum: [...UNITS],
    required: false,
    description:
      'No cambia si el producto ya tiene movimientos de existencias (409 `unit-locked`).',
  })
  readonly unit?: UnitOfMeasure;

  @ApiProperty({
    type: 'integer',
    minimum: 0,
    maximum: 1_000_000_000_000,
    required: false,
    description: 'Cambiar el precio es de la gerencia (`price:update`).',
  })
  readonly unitPrice?: number;

  @ApiProperty({ type: 'integer', enum: [0, 500, 1900], required: false })
  readonly taxRateBp?: number;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    nullable: true,
    description: '`null` quita la categoría.',
  })
  readonly categoryId?: string | null;

  @ApiProperty({
    type: 'integer',
    required: false,
    nullable: true,
    description: '`null` quita el mínimo.',
  })
  readonly minStockMilli?: number | null;

  @ApiProperty({
    type: Boolean,
    required: false,
    description:
      '`false` archiva el producto (no se vende, conserva su historia); `true` lo reactiva. Un producto no se borra.',
  })
  readonly active?: boolean;
}

export class ProductDto implements ProductView {
  @ApiProperty({ type: String, format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ type: String, example: 'Arroz 500 g' })
  readonly name!: string;

  @ApiProperty({ type: String, example: 'ARR-500' })
  readonly sku!: string;

  @ApiProperty({ type: String, nullable: true, example: '7701234567897' })
  readonly barcode!: string | null;

  @ApiProperty({ type: String, enum: [...UNITS] })
  readonly unit!: UnitOfMeasure;

  @ApiProperty({
    type: 'integer',
    example: 3200,
    description: 'Pesos enteros, con el IVA incluido.',
  })
  readonly unitPrice!: number;

  @ApiProperty({ type: 'integer', enum: [0, 500, 1900] })
  readonly taxRateBp!: number;

  @ApiProperty({ type: Boolean, description: '`false` si está archivado.' })
  readonly active!: boolean;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  readonly categoryId!: string | null;

  @ApiProperty({ type: 'integer', nullable: true, description: 'Milésimas de la unidad.' })
  readonly minStockMilli!: number | null;

  @ApiProperty({ type: String, format: 'date-time' })
  readonly createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  readonly updatedAt!: Date;
}

/** Una página de productos (ADR 0019). */
export class ProductPageDto {
  @ApiProperty({ type: [ProductDto] })
  readonly items!: ProductDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Se pasa tal cual como `cursor` para pedir la página siguiente. `null` si no hay más.',
  })
  readonly nextCursor!: string | null;
}
