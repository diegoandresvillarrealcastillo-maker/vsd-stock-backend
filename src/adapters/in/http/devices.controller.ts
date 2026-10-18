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
import type { DeviceView, Devices } from '../../../domain/ports/in/devices.js';
import { ApiProblemResponse } from './api-problem-response.decorator.js';
import { BearerAuthGuard, CurrentSession } from './bearer-auth.guard.js';
import { DeviceDto, DevicePageDto, RegisterDeviceRequestDto } from './devices.dto.js';
import { IDEMPOTENT_REPLAYED_HEADER } from './purchasing.controller.js';
import { DEVICES } from './tokens.js';

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

/** Lo poco que se usa de la respuesta de Express: el estado y los encabezados, para que `Res` no ate el adaptador a su tipo. */
interface ResponseWithStatus {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
}

/** Adaptador de entrada HTTP: los dispositivos del negocio (C3-01, ADR 0016). */
@ApiTags('devices')
@ApiBearerAuth()
@Controller('v1/devices')
@UseGuards(BearerAuthGuard)
export class DevicesController {
  constructor(@Inject(DEVICES) private readonly devices: Devices) {}

  @Post()
  @ApiProblemResponse()
  @ApiOperation({
    summary: 'Registrar un dispositivo',
    description:
      'Lo puede hacer cualquier persona del negocio (`device:enroll`), pero necesita conexión: el servidor reparte el código corto (`AA`, `AB`...) y nunca lo repite. Es idempotente por `id` (ADR 0019): la primera vez responde 201; repetirlo con el mismo nombre responde 200 con el mismo dispositivo y `Idempotent-Replayed: true`, sin gastar otro código (si fue dado de baja, `revokedAt` lo dice); con otro nombre, 409 `device-id-reused`.',
  })
  @ApiBody({ type: RegisterDeviceRequestDto })
  @ApiCreatedResponse({ type: DeviceDto })
  @ApiResponse({
    status: 200,
    description: 'El dispositivo ya se había registrado con este `id`: es el mismo de antes.',
    type: DeviceDto,
    headers: {
      [IDEMPOTENT_REPLAYED_HEADER]: {
        description: 'Siempre `true` en esta respuesta.',
        schema: { type: 'string', enum: ['true'] },
      },
    },
  })
  async register(
    @CurrentSession() session: Session,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: ResponseWithStatus,
  ): Promise<DeviceView> {
    const { device, replayed } = await this.devices.register(session, body);
    if (replayed) {
      response.status(200);
      response.setHeader(IDEMPOTENT_REPLAYED_HEADER, 'true');
    }
    return device;
  }

  @Get()
  @ApiProblemResponse()
  @ApiOperation({
    summary: 'Los dispositivos del negocio',
    description:
      'Del más antiguo al más nuevo, incluidos los dados de baja. Es de la gerencia (`device:revoke`). Pagina por cursor (ADR 0019).',
  })
  @ApiQuery(LIMIT)
  @ApiQuery(CURSOR)
  @ApiOkResponse({ type: DevicePageDto })
  list(@CurrentSession() session: Session, @Query() query: unknown): Promise<Page<DeviceView>> {
    return this.devices.list(session, query);
  }

  @Post(':deviceId/revoke')
  @HttpCode(200)
  @ApiProblemResponse()
  @ApiOperation({
    summary: 'Dar de baja un dispositivo',
    description:
      'Es de la gerencia (`device:revoke`) y necesita conexión. No borra nada: el dispositivo queda marcado y su código no se vuelve a dar. Repetirlo responde lo mismo, con la primera fecha. Lo que el dispositivo ya vendió sin red se acepta igual y queda marcado (ADR 0009).',
  })
  @ApiParam({ name: 'deviceId', type: String, format: 'uuid' })
  @ApiOkResponse({ type: DeviceDto })
  revoke(
    @CurrentSession() session: Session,
    @Param('deviceId') deviceId: string,
  ): Promise<DeviceView> {
    return this.devices.revoke(session, deviceId);
  }
}
