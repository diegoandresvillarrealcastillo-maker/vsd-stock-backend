import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Logger,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import { MAX_PAGE_SIZE } from '../../../domain/model/pagination.js';
import type { Session } from '../../../domain/ports/in/authenticate.js';
import type { Sync, SyncCopy, SyncItemResult } from '../../../domain/ports/in/sync.js';
import { ApiProblemResponse } from './api-problem-response.decorator.js';
import { BearerAuthGuard, CurrentSession } from './bearer-auth.guard.js';
import { problemOfDomainError } from './domain-errors.js';
import { buildProblem, type Problem } from './problem-details.js';
import {
  ProductCopyPageDto,
  StockCopyPageDto,
  SyncRequestDto,
  SyncResponseDto,
  type SyncResultDto,
} from './sync.dto.js';
import { SYNC, SYNC_COPY } from './tokens.js';

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

const SINCE = {
  name: 'since',
  required: false,
  schema: { type: 'string', format: 'date-time', example: '2026-10-18T15:00:00.000Z' },
  description:
    'Solo lo que cambió DESPUÉS de este instante (ISO 8601 UTC con `Z`). Sin él, todo. El dispositivo usa el `asOf` de su última descarga menos un minuto.',
} as const;

/** La ruta que falla en cada resultado del lote: la del lote, no la de la operacion. */
const INSTANCE = '/v1/sync';

interface ResponseWithLocals {
  locals?: Record<string, unknown>;
}

/** El estado HTTP que habria contestado la ruta individual cuando la operacion se aplico. */
function statusOfApplied(kind: SyncItemResult['kind'], replayed: boolean): number {
  // Cerrar un turno no crea nada: 200 siempre (la primera vez y al repetir). Abrir y vender crean: 201, y 200 al repetir.
  return kind === 'shift-close' || replayed ? 200 : 201;
}

/** Adaptador de entrada HTTP: el lote de sincronizacion y la copia de lectura (C3-06, ADR 0028). */
@ApiTags('sync')
@ApiBearerAuth()
@Controller('v1/sync')
@UseGuards(BearerAuthGuard)
export class SyncController {
  private readonly logger = new Logger('Sync');

  constructor(
    @Inject(SYNC) private readonly sync: Sync,
    @Inject(SYNC_COPY) private readonly copy: SyncCopy,
  ) {}

  @Post()
  @HttpCode(200)
  @ApiProblemResponse()
  @ApiOperation({
    summary: 'Enviar un lote de operaciones hechas sin conexión',
    description:
      'De 1 a 50 operaciones (`shift-open`, `shift-close` o `sale`) con el cuerpo EXACTO de su ruta individual. Se aplican una tras otra y cada una en su propia transacción, con las reglas de su ruta, así que una que falla no deshace ni detiene a las demás (ADR 0028). Responde 200 siempre que se procesó el lote, con un resultado por operación y en el mismo orden: `status` es el estado HTTP que habría contestado la ruta suelta, `replayed` dice si ya estaba aplicada, y viene `body` (lo que la ruta devuelve) o `problem` (el error de siempre). Lo que echa abajo la petición entera (sin sesión, sin negocio, un lote que no es una lista de 1 a 50) es el error de siempre.',
  })
  @ApiBody({ type: SyncRequestDto })
  @ApiOkResponse({ type: SyncResponseDto })
  async apply(
    @CurrentSession() session: Session,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: ResponseWithLocals,
  ): Promise<SyncResponseDto> {
    const { serverTime, results } = await this.sync.apply(session, body);
    const traceId =
      typeof response.locals?.['requestId'] === 'string'
        ? response.locals['requestId']
        : randomUUID();
    return { serverTime, results: results.map((result) => this.resultOf(result, traceId)) };
  }

  @Get('products')
  @ApiProblemResponse()
  @ApiOperation({
    summary: 'Copia de lectura: el catálogo',
    description:
      'Del cambio más viejo al más nuevo (por `updatedAt` y luego `id`), con cursor, e **incluye los productos archivados** (`active: false`) para que el dispositivo los quite de su copia. Con `since`, solo lo que cambió después. Cada página dice su `asOf`. Lo leen los tres roles (un cajero necesita el catálogo para vender).',
  })
  @ApiQuery(LIMIT)
  @ApiQuery(CURSOR)
  @ApiQuery(SINCE)
  @ApiOkResponse({ type: ProductCopyPageDto })
  products(@CurrentSession() session: Session, @Query() query: unknown) {
    return this.copy.products(session, query);
  }

  @Get('stock')
  @ApiProblemResponse()
  @ApiOperation({
    summary: 'Copia de lectura: la existencia',
    description:
      'La existencia de ahora de cada producto que alguna vez se movió, ordenada por producto, con cursor. Con `since`, solo los productos con un movimiento posterior. Un producto que nunca se movió no aparece: vale cero. Cada página dice su `asOf`: la cifra que muestra el dispositivo lleva esa hora.',
  })
  @ApiQuery(LIMIT)
  @ApiQuery(CURSOR)
  @ApiQuery(SINCE)
  @ApiOkResponse({ type: StockCopyPageDto })
  stock(@CurrentSession() session: Session, @Query() query: unknown) {
    return this.copy.stock(session, query);
  }

  /** El resultado de una operacion tal como lo contestaria su ruta: el cuerpo si se aplico, el problema de siempre si no. */
  private resultOf(item: SyncItemResult, traceId: string): SyncResultDto {
    if (item.outcome.type === 'applied') {
      return {
        operationId: item.operationId,
        status: statusOfApplied(item.kind, item.outcome.replayed),
        replayed: item.outcome.replayed,
        body: item.outcome.value as Record<string, unknown>,
        problem: null,
      };
    }
    const { error } = item.outcome;
    const own = problemOfDomainError(error);
    const status = own?.getStatus() ?? 500;
    if (status >= 500) {
      // Como el filtro: lo inesperado se registra con su causa en el servidor y se contesta sin ella.
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(`${traceId} ${reason}`, error instanceof Error ? error.stack : undefined);
    }
    const problem: Problem = buildProblem({
      status,
      ...(own === undefined ? {} : { code: own.code, detail: own.detail }),
      instance: INSTANCE,
      traceId,
      ...(own?.extras.errors === undefined ? {} : { errors: own.extras.errors }),
    });
    return {
      operationId: item.operationId,
      status: problem.status,
      replayed: false,
      body: null,
      problem,
    };
  }
}
