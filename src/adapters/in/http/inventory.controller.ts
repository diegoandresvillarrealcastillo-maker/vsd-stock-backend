import { Body, Controller, Get, Inject, Post, Query, Res, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { MAX_PAGE_SIZE, type Page } from '../../../domain/model/pagination.js';
import type { Session } from '../../../domain/ports/in/authenticate.js';
import type {
  Stock,
  StockAdjustments,
  StockMovementView,
  StockView,
} from '../../../domain/ports/in/inventory.js';
import { ApiProblemResponse } from './api-problem-response.decorator.js';
import { BearerAuthGuard, CurrentSession } from './bearer-auth.guard.js';
import {
  CreateStockAdjustmentRequestDto,
  StockMovementDto,
  StockMovementPageDto,
  StockPageDto,
} from './inventory.dto.js';
import { IDEMPOTENT_REPLAYED_HEADER } from './purchasing.controller.js';
import { STOCK, STOCK_ADJUSTMENTS } from './tokens.js';

const LIMIT = {
  name: 'limit',
  required: false,
  schema: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE, default: 50 },
} as const;

const CURSOR = {
  name: 'cursor',
  required: false,
  schema: { type: 'string' },
  description: 'El `nextCursor` de la página anterior, tal cual.',
} as const;

/** Lo poco que se usa de la respuesta de Express: el estado y los encabezados. */
interface ResponseWithStatus {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
}

/** Adaptador de entrada HTTP: la existencia de cada producto (C2-07). */
@ApiTags('inventory')
@ApiBearerAuth()
@Controller('v1/stock')
@UseGuards(BearerAuthGuard)
export class StockController {
  constructor(@Inject(STOCK) private readonly stock: Stock) {}

  @Get()
  @ApiProblemResponse()
  @ApiOperation({
    summary: 'La existencia de cada producto',
    description:
      'Ordenada por nombre. La ven los tres roles. `search` busca una parte del nombre o del SKU sin importar mayúsculas, o un código de barras completo; `belowMinimum=true` deja solo los que tienen mínimo y están por debajo de él. Un producto que nunca se movió aparece con cero. Pagina por cursor (ADR 0019).',
  })
  @ApiQuery(LIMIT)
  @ApiQuery(CURSOR)
  @ApiQuery({ name: 'search', required: false, schema: { type: 'string', maxLength: 80 } })
  @ApiQuery({ name: 'categoryId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({
    name: 'active',
    required: false,
    schema: { type: 'string', enum: ['true', 'false'] },
    description: 'Sin este filtro se devuelven activos y archivados.',
  })
  @ApiQuery({
    name: 'belowMinimum',
    required: false,
    schema: { type: 'string', enum: ['true', 'false'] },
    description: '`true`: solo los que están por debajo de su mínimo. `false` no filtra.',
  })
  @ApiOkResponse({ type: StockPageDto })
  list(@CurrentSession() session: Session, @Query() query: unknown): Promise<Page<StockView>> {
    return this.stock.list(session, query);
  }
}

/** Adaptador de entrada HTTP: el historial de movimientos de un producto (C2-07). */
@ApiTags('inventory')
@ApiBearerAuth()
@Controller('v1/stock-movements')
@UseGuards(BearerAuthGuard)
export class StockMovementsController {
  constructor(@Inject(STOCK) private readonly stock: Stock) {}

  @Get()
  @ApiProblemResponse()
  @ApiOperation({
    summary: 'El historial de un producto',
    description:
      'Los movimientos del libro de un producto, del más nuevo al más viejo: ventas, compras, ajustes y anulaciones. Lo ven los tres roles. `productId` es obligatorio; si el producto no existe, 404 `product-not-found`. Pagina por cursor (ADR 0019).',
  })
  @ApiQuery({ name: 'productId', required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery(LIMIT)
  @ApiQuery(CURSOR)
  @ApiOkResponse({ type: StockMovementPageDto })
  list(
    @CurrentSession() session: Session,
    @Query() query: unknown,
  ): Promise<Page<StockMovementView>> {
    return this.stock.movements(session, query);
  }
}

/** Adaptador de entrada HTTP: los ajustes de existencia (C2-07, ADR 0013 y 0019). */
@ApiTags('inventory')
@ApiBearerAuth()
@Controller('v1/stock-adjustments')
@UseGuards(BearerAuthGuard)
export class StockAdjustmentsController {
  constructor(@Inject(STOCK_ADJUSTMENTS) private readonly adjustments: StockAdjustments) {}

  @Post()
  @ApiProblemResponse()
  @ApiOperation({
    summary: 'Ajustar la existencia de un producto',
    description:
      'Es de la gerencia (`stock:adjust`). Un ajuste es **un movimiento nuevo del libro** con su motivo, nunca una edición del saldo: el saldo lo sube o baja el disparador de la base en la misma transacción. Es idempotente por `operationId` (ADR 0019): la primera vez responde 201; repetirlo con los mismos datos responde 200 con el mismo movimiento y `Idempotent-Replayed: true`, sin ajustar otra vez; con otros datos, 409 `operation-id-reused`. La existencia puede quedar en negativo: el libro cuenta lo que pasó.',
  })
  @ApiBody({ type: CreateStockAdjustmentRequestDto })
  @ApiCreatedResponse({ type: StockMovementDto })
  @ApiResponse({
    status: 200,
    description: 'El ajuste ya se había registrado con este `operationId`: es el mismo de antes.',
    type: StockMovementDto,
    headers: {
      [IDEMPOTENT_REPLAYED_HEADER]: {
        description: 'Siempre `true` en esta respuesta.',
        schema: { type: 'string', enum: ['true'] },
      },
    },
  })
  async create(
    @CurrentSession() session: Session,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: ResponseWithStatus,
  ): Promise<StockMovementView> {
    const { movement, replayed } = await this.adjustments.adjust(session, body);
    if (replayed) {
      response.status(200);
      response.setHeader(IDEMPOTENT_REPLAYED_HEADER, 'true');
    }
    return movement;
  }
}
