import { Body, Controller, Inject, Post, Res, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Session } from '../../../domain/ports/in/authenticate.js';
import type { SaleView, Sales } from '../../../domain/ports/in/sales.js';
import { ApiProblemResponse } from './api-problem-response.decorator.js';
import { BearerAuthGuard, CurrentSession } from './bearer-auth.guard.js';
import { IDEMPOTENT_REPLAYED_HEADER } from './purchasing.controller.js';
import { SaleDto, SaleRequestDto } from './sales.dto.js';
import { SALES } from './tokens.js';

/** Lo poco que se usa de la respuesta de Express: el estado y los encabezados, para que `Res` no ate el adaptador a su tipo. */
interface ResponseWithStatus {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
}

/** Adaptador de entrada HTTP: las ventas (C3-03, ADR 0027). */
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
  ): Promise<SaleView> {
    const { sale, replayed } = await this.sales.create(session, body);
    if (replayed) {
      response.status(200);
      response.setHeader(IDEMPOTENT_REPLAYED_HEADER, 'true');
    }
    return sale;
  }
}
