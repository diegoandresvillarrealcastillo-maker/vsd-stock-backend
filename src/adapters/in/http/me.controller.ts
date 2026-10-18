import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Session } from '../../../domain/ports/in/authenticate.js';
import type { GetMe, MeView } from '../../../domain/ports/in/get-me.js';
import { ApiProblemResponse } from './api-problem-response.decorator.js';
import { BearerAuthGuard, CurrentSession } from './bearer-auth.guard.js';
import { MeDto } from './me.dto.js';
import { GET_ME } from './tokens.js';

/** Adaptador de entrada HTTP: GET /v1/me, «quién soy» (ADR 0022). */
@ApiTags('identity')
@ApiBearerAuth()
@Controller('v1/me')
@UseGuards(BearerAuthGuard)
export class MeController {
  constructor(@Inject(GET_ME) private readonly getMe: GetMe) {}

  @Get()
  @ApiProblemResponse()
  @ApiOperation({
    summary: 'Quién soy',
    description:
      'Devuelve a la persona que demuestra el token y, si ya tiene negocio, el suyo y su rol. El negocio y el rol salen de la base de datos, nunca del token. Una persona que se registró pero aún no tiene negocio recibe `membership: null`. Responde 401 si el token falta o no sirve (`token-expired` si solo venció) y 403 `user-inactive` si fue dada de baja.',
  })
  @ApiOkResponse({ type: MeDto, description: 'La persona y su lugar en el negocio.' })
  me(@CurrentSession() session: Session): Promise<MeView> {
    return this.getMe.execute(session);
  }
}
