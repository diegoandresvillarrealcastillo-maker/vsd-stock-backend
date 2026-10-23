import { ApiProperty } from '@nestjs/swagger';
import { TAX_KINDS, type TaxKind } from '../../../domain/model/tax.js';
import type {
  RateSummaryView,
  SaleSummaryView,
  SaleTotalsView,
  SaleView,
} from '../../../domain/ports/in/sales.js';
import type {
  PaymentRecord,
  SaleLineRecord,
  SaleReviewRecord,
  SaleVoidRecord,
} from '../../../domain/ports/out/sales.js';

const MAX_PESOS = 1_000_000_000_000;

/** Una línea tal como el dispositivo la vendió. */
export class SaleLineRequestDto {
  @ApiProperty({ type: String, format: 'uuid' })
  readonly productId!: string;

  @ApiProperty({
    type: 'integer',
    minimum: 1,
    maximum: 1_000_000_000,
    example: 1500,
    description:
      'Milésimas de la unidad del producto: 1,5 kg = 1500. Un producto que se cuenta en unidades enteras no admite decimales.',
  })
  readonly quantityMilli!: number;

  @ApiProperty({
    type: 'integer',
    minimum: 0,
    maximum: MAX_PESOS,
    example: 4000,
    description:
      'Pesos enteros por unidad, IVA incluido, TAL COMO LOS VIO EL CLIENTE. El servidor respeta este precio aunque el catálogo ya cambió, y marca la venta con `price-differs` si no es el de hoy.',
  })
  readonly unitPrice!: number;

  @ApiProperty({
    type: 'integer',
    minimum: 0,
    maximum: MAX_PESOS,
    example: 0,
    description:
      'Rebaja de la línea en pesos, con el IVA incluido. No puede pasar del valor de la línea.',
  })
  readonly discount!: number;

  @ApiProperty({
    type: 'integer',
    enum: [0, 500, 1900],
    example: 1900,
    description: 'Tarifa de IVA con que se vendió, en puntos básicos.',
  })
  readonly taxRateBp!: number;

  @ApiProperty({
    type: String,
    enum: [...TAX_KINDS],
    example: 'taxed',
    description:
      'El tipo tributario con que se vendió (ADR 0034): `taxed` lleva 5 % o 19 %; `exempt` y `excluded` llevan 0 %. Es obligatorio: una venta sin él no se podría clasificar después. Si no es el del catálogo de hoy, la venta se acepta con el que trae y se marca `price-differs`.',
  })
  readonly taxKind!: TaxKind;
}

/** Un cobro. */
export class PaymentRequestDto {
  @ApiProperty({ type: String, enum: ['cash', 'card', 'transfer'] })
  readonly method!: 'cash' | 'card' | 'transfer';

  @ApiProperty({
    type: 'integer',
    minimum: 1,
    maximum: MAX_PESOS,
    example: 10000,
    description:
      'Pesos enteros que quedaron en la caja o en la cuenta: SIN el vuelto. El efectivo de la caja es la suma de los cobros en efectivo.',
  })
  readonly amount!: number;

  @ApiProperty({
    type: String,
    required: false,
    nullable: true,
    maxLength: 100,
    example: 'aprobación 77123',
    description: 'El comprobante de la tarjeta o de la transferencia.',
  })
  readonly reference?: string | null;
}

/** Lo que se manda para registrar una venta (C3-03). */
export class SaleRequestDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description:
      'La clave de idempotencia (ADR 0019): repetir la venta con el mismo `operationId` y los mismos datos no la duplica.',
  })
  readonly operationId!: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    description:
      'El turno de quien vende, ABIERTO o ya cerrado: una venta que llega a un turno cerrado se acepta y se marca `late-shift`.',
  })
  readonly shiftId!: string;

  @ApiProperty({
    type: String,
    example: 'AA-000142',
    maxLength: 40,
    description:
      'El folio con que el dispositivo ya le dio el comprobante al cliente (ADR 0016). Si ya es de otra venta, la venta se guarda con otro folio y se marca como conflicto.',
  })
  readonly folio!: string;

  @ApiProperty({
    type: 'integer',
    minimum: 0,
    maximum: MAX_PESOS,
    example: 13000,
    description:
      'El total que el dispositivo le cobró al cliente. El servidor calcula el suyo de las líneas y los compara: si difieren, guarda el del servidor y marca `total-differs`.',
  })
  readonly total!: number;

  @ApiProperty({ type: [SaleLineRequestDto], minItems: 1, maxItems: 200 })
  readonly lines!: SaleLineRequestDto[];

  @ApiProperty({
    type: [PaymentRequestDto],
    maxItems: 10,
    description:
      'Puede estar vacío solo en una venta de cero pesos. Si no suman el total, la venta se acepta y se marca `payment-mismatch`.',
  })
  readonly payments!: PaymentRequestDto[];

  @ApiProperty({
    type: String,
    example: '2026-10-18T14:59:50.000Z',
    maxLength: 40,
    description:
      'La hora del reloj del dispositivo al vender, en ISO 8601 UTC con `Z`. El servidor la corrige con `clockOffsetMs`; una que no se puede leer no se rechaza: se usa la hora de llegada y se marca (ADR 0016).',
  })
  readonly deviceTime!: string;

  @ApiProperty({
    type: 'integer',
    required: false,
    nullable: true,
    example: 4000,
    description:
      'Cuántos milisegundos adelanta el servidor al reloj del dispositivo en su última medición; `null` o ausente si nunca se midió. No forma parte de la huella de idempotencia.',
  })
  readonly clockOffsetMs?: number | null;
}

export class SaleLineDto implements SaleLineRecord {
  @ApiProperty({ type: String, format: 'uuid' })
  readonly productId!: string;

  @ApiProperty({ type: 'integer' })
  readonly quantityMilli!: number;

  @ApiProperty({ type: 'integer' })
  readonly unitPrice!: number;

  @ApiProperty({ type: 'integer' })
  readonly discount!: number;

  @ApiProperty({ type: 'integer', enum: [0, 500, 1900] })
  readonly taxRateBp!: number;

  @ApiProperty({ type: String, enum: [...TAX_KINDS] })
  readonly taxKind!: TaxKind;
}

export class PaymentDto implements PaymentRecord {
  @ApiProperty({ type: String, enum: ['cash', 'card', 'transfer'] })
  readonly method!: 'cash' | 'card' | 'transfer';

  @ApiProperty({ type: 'integer' })
  readonly amount!: number;

  @ApiProperty({ type: String, nullable: true })
  readonly reference!: string | null;
}

export class RateSummaryDto implements RateSummaryView {
  @ApiProperty({ type: 'integer', enum: [0, 500, 1900] })
  readonly rateBp!: number;

  @ApiProperty({ type: 'integer', description: 'Lo vendido a esta tarifa, con el IVA incluido.' })
  readonly total!: number;

  @ApiProperty({ type: 'integer', description: 'La base gravable.' })
  readonly base!: number;

  @ApiProperty({ type: 'integer', description: 'El IVA: lo que queda del total tras la base.' })
  readonly tax!: number;
}

export class SaleTotalsDto implements SaleTotalsView {
  @ApiProperty({ type: 'integer' })
  readonly total!: number;

  @ApiProperty({ type: 'integer' })
  readonly base!: number;

  @ApiProperty({ type: 'integer' })
  readonly tax!: number;

  @ApiProperty({ type: [RateSummaryDto], description: 'Un renglón por tarifa, de menor a mayor.' })
  readonly byRate!: RateSummaryDto[];
}

const SALE_FLAGS = [
  'price-differs',
  'total-differs',
  'payment-mismatch',
  'late-shift',
  'revoked-device',
  'folio-device',
] as const;

export class SaleReviewDto implements SaleReviewRecord {
  @ApiProperty({ type: String, format: 'date-time', description: 'Cuándo se revisó.' })
  readonly reviewedAt!: Date;

  @ApiProperty({ type: String, format: 'uuid', description: 'Quién la revisó.' })
  readonly reviewedByUserId!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    maxLength: 200,
    description: 'Lo que anotó quien la revisó.',
  })
  readonly note!: string | null;
}

export class SaleVoidDto implements SaleVoidRecord {
  @ApiProperty({
    type: String,
    example: 'ANU-000001',
    description:
      'El folio propio de la anulación (ADR 0036): `ANU-` y el número de anulación del negocio, con seis cifras como mínimo. Es la secuencia del negocio, sin saltos y en el orden en que se anotaron, y no se parece al folio de ninguna venta.',
  })
  readonly folio!: string;

  @ApiProperty({ type: String, format: 'date-time', description: 'Cuándo se anuló.' })
  readonly voidedAt!: Date;

  @ApiProperty({ type: String, format: 'uuid', description: 'Quién la anuló.' })
  readonly voidedByUserId!: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'La operación de anular: bajo ella quedaron los movimientos que compensan.',
  })
  readonly operationId!: string;

  @ApiProperty({ type: String, maxLength: 200, description: 'Por qué se anuló.' })
  readonly reason!: string;
}

/** Lo que una venta de la lista y una venta completa tienen en común. */
export class SaleHeaderDto {
  @ApiProperty({ type: String, format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  readonly operationId!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  readonly shiftId!: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'El dispositivo del turno.',
  })
  readonly deviceId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', description: 'Quien la registró.' })
  readonly userId!: string;

  @ApiProperty({
    type: String,
    example: 'AA-000142',
    description:
      'El folio con que se guardó: el que trajo el dispositivo, o ese mismo con `~` y ocho caracteres de la operación si estaba repetido.',
  })
  readonly folio!: string;

  @ApiProperty({
    type: String,
    example: 'AA-000142',
    description: 'El folio que trajo el dispositivo, tal cual.',
  })
  readonly folioReported!: string;

  @ApiProperty({ type: Boolean, description: 'El folio ya era de otra venta (ADR 0016).' })
  readonly folioConflict!: boolean;

  @ApiProperty({ type: 'integer', description: 'El total que calculó el servidor.' })
  readonly total!: number;

  @ApiProperty({
    type: Boolean,
    description:
      'Algún producto quedó con existencia menor que cero con esta venta: hay que ajustar el inventario (ADR 0013).',
  })
  readonly needsAdjustment!: boolean;

  @ApiProperty({
    type: [String],
    enum: SALE_FLAGS,
    description: 'Lo que el servidor encontró raro al compararla con lo que sabe (ADR 0027).',
  })
  readonly flags!: (typeof SALE_FLAGS)[number][];

  @ApiProperty({
    type: [String],
    enum: ['clock-skew', 'clock-unverified', 'future', 'stale', 'unreadable'],
    description: 'Lo raro de la hora de la operación (ADR 0016).',
  })
  readonly timeFlags!: ('clock-skew' | 'clock-unverified' | 'future' | 'stale' | 'unreadable')[];

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'La hora efectiva de la venta (ADR 0016).',
  })
  readonly occurredAt!: Date;

  @ApiProperty({ type: String, format: 'date-time', description: 'Cuándo se enteró el servidor.' })
  readonly receivedAt!: Date;

  @ApiProperty({
    type: SaleReviewDto,
    nullable: true,
    description: '`null` mientras nadie la haya revisado (ADR 0027).',
  })
  readonly review!: SaleReviewDto | null;

  @ApiProperty({
    type: SaleVoidDto,
    nullable: true,
    description:
      '`null` mientras no esté anulada (ADR 0027). Una venta anulada no se borra ni se edita.',
  })
  readonly voided!: SaleVoidDto | null;

  @ApiProperty({
    type: Boolean,
    description:
      'Está en la bandeja «Requiere atención»: pide atención (existencia en negativo, folio repetido, una marca del servidor o una hora que no es de fiar) y nadie la ha revisado.',
  })
  readonly attention!: boolean;
}

/** Una venta de la lista: sin líneas ni cobros. */
export class SaleSummaryDto extends SaleHeaderDto implements SaleSummaryView {}

/** Una venta completa. */
export class SaleDto extends SaleHeaderDto implements SaleView {
  @ApiProperty({
    type: [SaleLineDto],
    description: 'En el orden en que el dispositivo las vendió.',
  })
  readonly lines!: SaleLineDto[];

  @ApiProperty({ type: [PaymentDto], description: 'En el orden en que el dispositivo los cobró.' })
  readonly payments!: PaymentDto[];

  @ApiProperty({ type: SaleTotalsDto })
  readonly summary!: SaleTotalsDto;
}

/** Una página de ventas (ADR 0019). */
export class SalePageDto {
  @ApiProperty({ type: [SaleSummaryDto] })
  readonly items!: SaleSummaryDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Se pasa tal cual como `cursor` para pedir la página siguiente. `null` si no hay más.',
  })
  readonly nextCursor!: string | null;
}

/** Lo que se manda al revisar una venta. */
export class SaleReviewRequestDto {
  @ApiProperty({
    type: String,
    required: false,
    nullable: true,
    maxLength: 200,
    example: 'Se ajustó el inventario de gaseosas',
    description: 'Lo que se hizo con la venta, para que quede dicho. Una línea, sin saltos.',
  })
  readonly note?: string | null;
}

/** La revisión de una venta: de qué venta es, quién la hizo, cuándo y qué anotó. */
export class SaleReviewResponseDto extends SaleReviewDto {
  @ApiProperty({ type: String, format: 'uuid', description: 'La venta que se revisó.' })
  readonly saleId!: string;
}

/** Lo que se manda al anular una venta. */
export class SaleVoidRequestDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'La clave de idempotencia, creada una sola vez (ADR 0019).',
  })
  readonly operationId!: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    nullable: true,
    description:
      'Un turno ABIERTO de quien anula, de donde sale el efectivo que se devuelve. Hace falta si la venta tuvo efectivo (409 `shift-required` si no); sin efectivo se puede omitir.',
  })
  readonly shiftId?: string | null;

  @ApiProperty({
    type: String,
    maxLength: 200,
    example: 'Se equivocó de producto',
    description: 'Por qué se anula, para que quede dicho. Una línea.',
  })
  readonly reason!: string;
}
