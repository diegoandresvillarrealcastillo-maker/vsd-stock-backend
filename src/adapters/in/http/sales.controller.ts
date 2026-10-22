import { Body, Controller, Get, Inject, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { MAX_PAGE_SIZE, type Page } from '../../../domain/model/pagination.js';
import type { Session } from '../../../domain/ports/in/authenticate.js';
import type { SaleSummaryView, SaleView, Sales } from '../../../domain/ports/in/sales.js';
import { ApiProblemResponse } from './api-problem-response.decorator.js';
import { BearerAuthGuard, CurrentSession } from './bearer-auth.guard.js';
import { IDEMPOTENT_REPLAYED_HEADER } from './purchasing.controller.js';
import {
  SaleDto,
  SalePageDto,
  SaleRequestDto,
  SaleReviewRequestDto,
  SaleReviewResponseDto,
  SaleVoidRequestDto,
} from './sales.dto.js';
import { SALES } from './tokens.js';

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

const SHIFT = {
  name: 'shiftId',
  required: false,
  schema: { type: 'string', format: 'uuid' },
  description: 'Solo las ventas de este turno.',
} as const;

const ATTENTION = {
  name: 'attention',
  required: false,
  schema: { type: 'string', enum: ['true', 'false'] },
  description:
    '`true` es la bandeja «Requiere atención»: las ventas que piden atención y nadie ha revisado. `false`, todas las demás. Es de la gerencia (`sale:view-all`).',
} as const;

const FOLIO = {
  name: 'folio',
  required: false,
  schema: { type: 'string', example: 'AA-000142' },
  description:
    'El folio exacto, tal como lo trajo el dispositivo: encuentra también una venta cuyo folio estaba repetido y se guardó con otro.',
} as const;

const REPLAYED_RESPONSE = {
  [IDEMPOTENT_REPLAYED_HEADER]: {
    description: 'Siempre `true` en esta respuesta.',
    schema: { type: 'string', enum: ['true'] },
  },
};

/** Lo poco que se usa de la respuesta de Express: el estado y los encabezados, para que `Res` no ate el adaptador a su tipo. */
interface ResponseWithStatus {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
}

/** Adaptador de entrada HTTP: las ventas (C3-03 y C3-04, ADR 0027). */
@ApiTags('sales')
@ApiBearerAuth()
@Controller('v1/sales')
@UseGuards(BearerAuthGuard)
export class SalesController {
  constructor(@Inject(SALES) private readonly sales: Sales) {}

  @Post()
  @ApiProblemResponse()
  @ApiOperation({
    summary: 'Registrar una venta',
    description:
      'Lo puede hacer cualquier persona del negocio (`sale:create`), también un dispositivo sin conexión que la manda después. Casi siempre la venta ya ocurrió en un mostrador (ADR 0009): el servidor la ACEPTA y, si algo no cuadra con lo que él sabe, la guarda marcada (`flags`, `needsAdjustment`, `folioConflict`, `timeFlags`) para que alguien la mire. Solo rechaza lo que ninguna realidad del mostrador explica: un cuerpo que no es una venta (400), un turno que no es de quien vende y un producto que el negocio no tiene (400 en `/shiftId` y `/lines/N/productId`). La venta, sus líneas, sus cobros y la baja de existencias son una sola transacción. Es idempotente por `operationId` (ADR 0019): la primera vez responde 201; repetirla con los mismos datos responde 200 con la venta tal como quedó y `Idempotent-Replayed: true`; con otros datos, 409 `operation-id-reused`.',
  })
  @ApiBody({ type: SaleRequestDto })
  @ApiCreatedResponse({ type: SaleDto })
  @ApiResponse({
    status: 200,
    description: 'La venta ya se había registrado con esta operación: es la misma de antes.',
    type: SaleDto,
    headers: REPLAYED_RESPONSE,
  })
  async create(
    @CurrentSession() session: Session,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: ResponseWithStatus,
  ): Promise<SaleView> {
    const { sale, replayed } = await this.sales.create(session, body);
    if (replayed) {
      response.status(200);
      response.setHeader(IDEMPOTENT_REPLAYED_HEADER, 'true');
    }
    return sale;
  }

  @Get()
  @ApiProblemResponse()
  @ApiOperation({
    summary: 'Las ventas',
    description:
      'De la más reciente a la más vieja, por la hora en que ocurrieron (no por la de llegada), con cursor. Un cajero ve las ventas de SUS turnos (`sale:view-own-shift`); la gerencia ve todas (`sale:view-all`). La bandeja «Requiere atención» (`attention=true`) es solo de la gerencia: un cajero que la pide recibe 403. Cada venta trae `attention`, que dice si está en la bandeja; la lista no trae líneas ni cobros, para eso está el detalle.',
  })
  @ApiQuery(LIMIT)
  @ApiQuery(CURSOR)
  @ApiQuery(SHIFT)
  @ApiQuery(ATTENTION)
  @ApiQuery(FOLIO)
  @ApiOkResponse({ type: SalePageDto })
  list(
    @CurrentSession() session: Session,
    @Query() query: unknown,
  ): Promise<Page<SaleSummaryView>> {
    return this.sales.list(session, query);
  }

  @Get(':saleId')
  @ApiProblemResponse()
  @ApiOperation({
    summary: 'Una venta',
    description:
      'Con sus líneas, sus cobros, el IVA desglosado, sus marcas y su revisión. La venta de un turno ajeno no existe para un cajero: recibe 404 `sale-not-found`, igual que una que nunca existió.',
  })
  @ApiParam({ name: 'saleId', type: String, format: 'uuid' })
  @ApiOkResponse({ type: SaleDto })
  get(@CurrentSession() session: Session, @Param('saleId') saleId: string): Promise<SaleView> {
    return this.sales.get(session, saleId);
  }

  @Post(':saleId/review')
  @ApiProblemResponse()
  @ApiOperation({
    summary: 'Revisar una venta',
    description:
      'La gerencia (`sale:view-all`, con conexión) revisa una venta que pedía atención: la saca de la bandeja SIN cambiarla (sus marcas se conservan) y deja dicho quién y cuándo, con una nota opcional. Una venta se revisa una vez: la primera vez responde 201; revisarla otra vez responde 200 con la revisión que ya tenía y `Idempotent-Replayed: true`.',
  })
  @ApiParam({ name: 'saleId', type: String, format: 'uuid' })
  @ApiBody({ type: SaleReviewRequestDto })
  @ApiCreatedResponse({ type: SaleReviewResponseDto })
  @ApiResponse({
    status: 200,
    description: 'La venta ya estaba revisada: es la revisión de antes.',
    type: SaleReviewResponseDto,
    headers: REPLAYED_RESPONSE,
  })
  async review(
    @CurrentSession() session: Session,
    @Param('saleId') saleId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: ResponseWithStatus,
  ): Promise<SaleReviewResponseDto> {
    const { review, replayed, saleId: reviewed } = await this.sales.review(session, saleId, body);
    if (replayed) {
      response.status(200);
      response.setHeader(IDEMPOTENT_REPLAYED_HEADER, 'true');
    }
    return { saleId: reviewed, ...review };
  }

  @Post(':saleId/void')
  @ApiProblemResponse()
  @ApiOperation({
    summary: 'Anular una venta',
    description:
      'La gerencia (`sale:void`, con conexión). **No borra ni edita la venta** (ADR 0009): agrega los movimientos que compensan. La existencia vuelve con un movimiento de motivo `void` por producto, y el efectivo que se cobró sale como un egreso del turno ABIERTO de quien anula (`shiftId`), no del de la venta, que puede estar cerrado y contado. Si la venta tuvo efectivo y no se nombra un turno abierto suyo, `409 shift-required`; una venta ya anulada es `409 sale-voided`. Es idempotente por `operationId` (ADR 0019): la primera vez responde 201 con la venta; repetirla con los mismos datos responde 200 con la venta tal como quedó y `Idempotent-Replayed: true`; con otros datos, 409 `operation-id-reused`.',
  })
  @ApiParam({ name: 'saleId', type: String, format: 'uuid' })
  @ApiBody({ type: SaleVoidRequestDto })
  @ApiCreatedResponse({ type: SaleDto })
  @ApiResponse({
    status: 200,
    description: 'La venta ya se había anulado con esta operación: es la misma de antes.',
    type: SaleDto,
    headers: REPLAYED_RESPONSE,
  })
  async voidSale(
    @CurrentSession() session: Session,
    @Param('saleId') saleId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: ResponseWithStatus,
  ): Promise<SaleView> {
    const { sale, replayed } = await this.sales.voidSale(session, saleId, body);
    if (replayed) {
      response.status(200);
      response.setHeader(IDEMPOTENT_REPLAYED_HEADER, 'true');
    }
    return sale;
  }
}
