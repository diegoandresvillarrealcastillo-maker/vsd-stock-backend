import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
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
import type {
  CashMovementView,
  CashMovements,
  ShiftSummaryView,
  ShiftView,
  Shifts,
} from '../../../domain/ports/in/shifts.js';
import { ApiProblemResponse } from './api-problem-response.decorator.js';
import { BearerAuthGuard, CurrentSession } from './bearer-auth.guard.js';
import { IDEMPOTENT_REPLAYED_HEADER } from './purchasing.controller.js';
import {
  CashMovementDto,
  CashMovementRequestDto,
  CloseShiftRequestDto,
  OpenShiftRequestDto,
  ShiftDto,
  ShiftPageDto,
} from './shifts.dto.js';
import { CASH_MOVEMENTS, SHIFTS } from './tokens.js';

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

const OPEN = {
  name: 'open',
  required: false,
  schema: { type: 'string', enum: ['true', 'false'] },
  description: '`true` deja solo los turnos abiertos y `false` solo los cerrados.',
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

/** Adaptador de entrada HTTP: los turnos de caja (C3-02, ADR 0026). */
@ApiTags('shifts')
@ApiBearerAuth()
@Controller('v1/shifts')
@UseGuards(BearerAuthGuard)
export class ShiftsController {
  constructor(@Inject(SHIFTS) private readonly shifts: Shifts) {}

  @Post()
  @ApiProblemResponse()
  @ApiOperation({
    summary: 'Abrir un turno de caja',
    description:
      'Lo puede hacer cualquier persona del negocio (`shift:open`) y también un dispositivo sin conexión, que la manda después. Un turno abierto por dispositivo y por persona: abrir otro responde 409 `shift-already-open`. El `shiftId` lo crea el dispositivo. Es idempotente por `operationId` (ADR 0019): la primera vez responde 201; repetirla con los mismos datos responde 200 con el turno tal como está ahora y `Idempotent-Replayed: true`; con otros datos, 409 `operation-id-reused`. Un dispositivo que no existe en el negocio es un 400 del campo `/deviceId`.',
  })
  @ApiBody({ type: OpenShiftRequestDto })
  @ApiCreatedResponse({ type: ShiftDto })
  @ApiResponse({
    status: 200,
    description: 'El turno ya se había abierto con esta operación: es el mismo de antes.',
    type: ShiftDto,
    headers: REPLAYED_RESPONSE,
  })
  async open(
    @CurrentSession() session: Session,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: ResponseWithStatus,
  ): Promise<ShiftView> {
    const { shift, replayed } = await this.shifts.open(session, body);
    if (replayed) {
      response.status(200);
      response.setHeader(IDEMPOTENT_REPLAYED_HEADER, 'true');
    }
    return shift;
  }

  @Post(':shiftId/close')
  @HttpCode(200)
  @ApiProblemResponse()
  @ApiOperation({
    summary: 'Cerrar un turno con su arqueo',
    description:
      'La persona del turno lo cierra (`shift:close`); la gerencia puede cerrar el de otra persona (`shift:close-other`, solo con conexión). Registra el efectivo contado, la hora efectiva y quién lo cerró, y responde con el arqueo. Es idempotente por `operationId`: repetirla responde 200 con `Idempotent-Replayed: true`. Cerrar un turno que ya estaba cerrado con otra operación es 409 `shift-closed`.',
  })
  @ApiParam({ name: 'shiftId', type: String, format: 'uuid' })
  @ApiBody({ type: CloseShiftRequestDto })
  @ApiOkResponse({ type: ShiftDto, headers: REPLAYED_RESPONSE })
  async close(
    @CurrentSession() session: Session,
    @Param('shiftId') shiftId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: ResponseWithStatus,
  ): Promise<ShiftView> {
    const { shift, replayed } = await this.shifts.close(session, shiftId, body);
    if (replayed) response.setHeader(IDEMPOTENT_REPLAYED_HEADER, 'true');
    return shift;
  }

  @Get()
  @ApiProblemResponse()
  @ApiOperation({
    summary: 'Los turnos',
    description:
      'Del más nuevo al más viejo. Un cajero ve solo los suyos; la gerencia ve todos (`sale:view-all`). No trae el arqueo: se pide con el turno. Pagina por cursor (ADR 0019).',
  })
  @ApiQuery(LIMIT)
  @ApiQuery(CURSOR)
  @ApiQuery(OPEN)
  @ApiOkResponse({ type: ShiftPageDto })
  list(
    @CurrentSession() session: Session,
    @Query() query: unknown,
  ): Promise<Page<ShiftSummaryView>> {
    return this.shifts.list(session, query);
  }

  @Get(':shiftId')
  @ApiProblemResponse()
  @ApiOperation({
    summary: 'Un turno con su arqueo',
    description:
      'El arqueo: lo que debía haber en la caja (lo inicial, más lo cobrado en efectivo, más lo que entró, menos lo que salió) frente a lo contado, con las ventas tardías aparte. El turno de otra persona no existe para un cajero.',
  })
  @ApiParam({ name: 'shiftId', type: String, format: 'uuid' })
  @ApiOkResponse({ type: ShiftDto })
  get(@CurrentSession() session: Session, @Param('shiftId') shiftId: string): Promise<ShiftView> {
    return this.shifts.get(session, shiftId);
  }
}

/** Adaptador de entrada HTTP: el efectivo que entra y sale de un turno fuera de una venta (C3-02, ADR 0026). */
@ApiTags('shifts')
@ApiBearerAuth()
@Controller('v1/cash-movements')
@UseGuards(BearerAuthGuard)
export class CashMovementsController {
  constructor(@Inject(CASH_MOVEMENTS) private readonly movements: CashMovements) {}

  @Post()
  @ApiProblemResponse()
  @ApiOperation({
    summary: 'Mover efectivo fuera de una venta',
    description:
      'Es de la gerencia (`cash-movement:create`) y necesita conexión. Entra o sale efectivo de un turno ABIERTO con su motivo (el del turno cerrado ya se contó: 409 `shift-closed`). Es idempotente por `operationId`: la primera vez responde 201; repetirla con los mismos datos responde 200 con el mismo movimiento y `Idempotent-Replayed: true`; con otros datos, 409 `operation-id-reused`. Un turno que no existe es un 400 del campo `/shiftId`.',
  })
  @ApiBody({ type: CashMovementRequestDto })
  @ApiCreatedResponse({ type: CashMovementDto })
  @ApiResponse({
    status: 200,
    description: 'El movimiento ya se había registrado con esta operación: es el mismo de antes.',
    type: CashMovementDto,
    headers: REPLAYED_RESPONSE,
  })
  async create(
    @CurrentSession() session: Session,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: ResponseWithStatus,
  ): Promise<CashMovementView> {
    const { movement, replayed } = await this.movements.create(session, body);
    if (replayed) {
      response.status(200);
      response.setHeader(IDEMPOTENT_REPLAYED_HEADER, 'true');
    }
    return movement;
  }
}
