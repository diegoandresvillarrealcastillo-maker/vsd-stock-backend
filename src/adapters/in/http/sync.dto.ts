import { ApiProperty } from '@nestjs/swagger';
import {
  SYNC_KINDS,
  MAX_SYNC_OPERATIONS,
  type SyncKind,
} from '../../../domain/model/sync-input.js';
import type { StockCopyRecord } from '../../../domain/ports/in/sync.js';
import { ProductDto } from './catalog.dto.js';
import { ProblemDetailsDto } from './problem-details.dto.js';

/** Una operacion del lote: la clase y EXACTAMENTE el cuerpo de la ruta individual de esa clase. */
export class SyncOperationDto {
  @ApiProperty({
    type: String,
    enum: [...SYNC_KINDS],
    description:
      'Lo que se hizo sin conexión: `shift-open` (`POST /v1/shifts`), `shift-close` (`POST /v1/shifts/{id}/close`) o `sale` (`POST /v1/sales`).',
  })
  readonly kind!: SyncKind;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description:
      'Solo al cerrar un turno (`shift-close`): el turno que se cierra, que en la ruta individual va en el camino.',
  })
  readonly shiftId?: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'El cuerpo exacto de la ruta individual de esa clase, con su `operationId`. Se valida con las mismas reglas.',
  })
  readonly body!: Record<string, unknown>;
}

export class SyncRequestDto {
  @ApiProperty({
    type: [SyncOperationDto],
    minItems: 1,
    maxItems: MAX_SYNC_OPERATIONS,
    description:
      'Las operaciones, en el orden en que se hicieron. Se aplican una tras otra, cada una en su propia transacción: una que falla no deshace ni detiene a las demás.',
  })
  readonly operations!: SyncOperationDto[];
}

export class SyncResultDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'El `operationId` de la operación, o `null` si su cuerpo ni siquiera lo traía.',
  })
  readonly operationId!: string | null;

  @ApiProperty({
    type: 'integer',
    example: 201,
    description:
      'El estado HTTP que habría contestado la ruta individual: 201 si se aplicó, 200 si ya estaba aplicada (o al cerrar un turno), y el 4xx o 5xx que corresponda si no. El dispositivo decide con él como con una respuesta suelta (ADR 0009).',
  })
  readonly status!: number;

  @ApiProperty({
    type: Boolean,
    description:
      '`true` si el servidor ya la había aplicado antes: se perdió la respuesta, no la operación. Sustituye a la cabecera `Idempotent-Replayed`.',
  })
  readonly replayed!: boolean;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description:
      'Lo que la ruta individual devuelve (el turno o la venta) cuando se aplicó; `null` si no.',
  })
  readonly body!: Record<string, unknown> | null;

  @ApiProperty({
    type: ProblemDetailsDto,
    nullable: true,
    description:
      'El error de siempre (`application/problem+json`) cuando no se aplicó; `null` si sí.',
  })
  readonly problem!: ProblemDetailsDto | null;
}

export class SyncResponseDto {
  @ApiProperty({
    type: String,
    format: 'date-time',
    description:
      'La hora del servidor al contestar: con ella y las horas de salida y llegada, el dispositivo mide su reloj (ADR 0016).',
  })
  readonly serverTime!: Date;

  @ApiProperty({
    type: [SyncResultDto],
    description: 'Un resultado por operación, en el mismo orden en que llegaron.',
  })
  readonly results!: SyncResultDto[];
}

const ASOF = {
  type: String,
  format: 'date-time',
  description:
    'La hora del servidor al leer esta página. El dispositivo guarda la de la PRIMERA página de una descarga, le resta un minuto y la usa como `since` la próxima vez.',
} as const;

const NEXT_CURSOR = {
  type: String,
  nullable: true,
  description:
    'Se pasa tal cual como `cursor` para pedir la página siguiente. `null` si no hay más.',
} as const;

/** Una página de la copia de productos (ADR 0028): del cambio más viejo al más nuevo, con los archivados. */
export class ProductCopyPageDto {
  @ApiProperty(ASOF)
  readonly asOf!: Date;

  @ApiProperty({ type: [ProductDto] })
  readonly items!: ProductDto[];

  @ApiProperty(NEXT_CURSOR)
  readonly nextCursor!: string | null;
}

export class StockLevelDto implements StockCopyRecord {
  @ApiProperty({ type: String, format: 'uuid' })
  readonly productId!: string;

  @ApiProperty({
    type: 'integer',
    description:
      'La existencia de ahora, en milésimas de la unidad del producto. Puede ser negativa.',
  })
  readonly quantityMilli!: number;
}

/** Una página de la copia de existencias (ADR 0028): por producto. Un producto que nunca se movió no aparece: vale cero. */
export class StockCopyPageDto {
  @ApiProperty(ASOF)
  readonly asOf!: Date;

  @ApiProperty({ type: [StockLevelDto] })
  readonly items!: StockLevelDto[];

  @ApiProperty(NEXT_CURSOR)
  readonly nextCursor!: string | null;
}
