import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
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
  ApiTags,
} from '@nestjs/swagger';
import { MAX_PAGE_SIZE } from '../../../domain/model/pagination.js';
import type { Page } from '../../../domain/model/pagination.js';
import type { Session } from '../../../domain/ports/in/authenticate.js';
import type {
  CreateBusiness,
  InvitationView,
  InviteUser,
  ListUsers,
  PersonView,
  RedeemInvitation,
  RegenerateInvitation,
  UpdateUser,
} from '../../../domain/ports/in/business-people.js';
import type { MembershipView } from '../../../domain/ports/in/get-me.js';
import { ApiProblemResponse } from './api-problem-response.decorator.js';
import { BearerAuthGuard, CurrentSession } from './bearer-auth.guard.js';
import { MeMembershipDto } from './me.dto.js';
import {
  CreateBusinessRequestDto,
  InvitationDto,
  InviteUserRequestDto,
  PersonDto,
  PersonPageDto,
  RedeemInvitationRequestDto,
  UpdateUserRequestDto,
} from './people.dto.js';
import {
  CREATE_BUSINESS,
  INVITE_USER,
  LIST_USERS,
  REDEEM_INVITATION,
  REGENERATE_INVITATION,
  UPDATE_USER,
} from './tokens.js';

/** Adaptador de entrada HTTP: abrir un negocio (ADR 0023). */
@ApiTags('business')
@ApiBearerAuth()
@Controller('v1/businesses')
@UseGuards(BearerAuthGuard)
export class BusinessesController {
  constructor(@Inject(CREATE_BUSINESS) private readonly createBusiness: CreateBusiness) {}

  @Post()
  @ApiProblemResponse()
  @ApiOperation({
    summary: 'Abrir un negocio',
    description:
      'Lo hace quien se registró y aún no pertenece a ningún negocio: queda como su dueño. El negocio nace con una sucursal y una bodega, ambas «Principal». Responde 409 `already-member` si la persona ya trabaja en un negocio.',
  })
  @ApiBody({ type: CreateBusinessRequestDto })
  @ApiCreatedResponse({
    type: MeMembershipDto,
    description: 'El lugar de la persona en el negocio nuevo.',
  })
  open(@CurrentSession() session: Session, @Body() body: unknown): Promise<MembershipView> {
    return this.createBusiness.execute(session, body);
  }
}

/** Adaptador de entrada HTTP: invitar y canjear invitaciones (ADR 0023). */
@ApiTags('people')
@ApiBearerAuth()
@Controller('v1/invitations')
@UseGuards(BearerAuthGuard)
export class InvitationsController {
  constructor(
    @Inject(INVITE_USER) private readonly inviteUser: InviteUser,
    @Inject(REDEEM_INVITATION) private readonly redeemInvitation: RedeemInvitation,
  ) {}

  @Post()
  @ApiProblemResponse()
  @ApiOperation({
    summary: 'Invitar a alguien al negocio',
    description:
      'Crea la invitación y devuelve su código **una sola vez**. El servidor solo guarda su hash. La invitación vale siete días. Un administrador invita cajeros; invitar administradores es del dueño.',
  })
  @ApiBody({ type: InviteUserRequestDto })
  @ApiCreatedResponse({ type: InvitationDto })
  invite(@CurrentSession() session: Session, @Body() body: unknown): Promise<InvitationView> {
    return this.inviteUser.execute(session, body);
  }

  @Post('redeem')
  @HttpCode(200)
  @ApiProblemResponse()
  @ApiOperation({
    summary: 'Canjear una invitación',
    description:
      'Une a quien llama al negocio del código, con el rol con que lo invitaron. Un código sirve una sola vez. Responde 404 `invitation-not-found` si no existe, ya se usó o se dio de baja (el mismo mensaje para todo), 410 `invitation-expired` si venció y 409 `already-member` si la persona ya trabaja en un negocio.',
  })
  @ApiBody({ type: RedeemInvitationRequestDto })
  @ApiOkResponse({ type: MeMembershipDto, description: 'El lugar de la persona en el negocio.' })
  redeem(@CurrentSession() session: Session, @Body() body: unknown): Promise<MembershipView> {
    return this.redeemInvitation.execute(session, body);
  }
}

/** Adaptador de entrada HTTP: las personas del negocio (ADR 0023). */
@ApiTags('people')
@ApiBearerAuth()
@Controller('v1/users')
@UseGuards(BearerAuthGuard)
export class UsersController {
  constructor(
    @Inject(LIST_USERS) private readonly listUsers: ListUsers,
    @Inject(UPDATE_USER) private readonly updateUser: UpdateUser,
    @Inject(REGENERATE_INVITATION) private readonly regenerateInvitation: RegenerateInvitation,
  ) {}

  @Get()
  @ApiProblemResponse()
  @ApiOperation({
    summary: 'Las personas del negocio',
    description:
      'Ordenadas por nombre. Las ve la gerencia (dueño y administradores). Pagina por cursor (ADR 0019).',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE, default: 50 },
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    schema: { type: 'string' },
    description: 'El `nextCursor` de la página anterior, tal cual.',
  })
  @ApiOkResponse({ type: PersonPageDto })
  list(@CurrentSession() session: Session, @Query() query: unknown): Promise<Page<PersonView>> {
    return this.listUsers.execute(session, query);
  }

  @Patch(':userId')
  @ApiProblemResponse()
  @ApiOperation({
    summary: 'Cambiar a una persona',
    description:
      'Cambia el nombre, el rol o el alta (`active`). Al cajero lo administra la gerencia; a un administrador o a un dueño, solo el dueño. Nunca deja al negocio sin un dueño activo (409 `last-owner`). Una persona dada de baja pierde el acceso en su siguiente petición.',
  })
  @ApiParam({ name: 'userId', type: String, format: 'uuid' })
  @ApiBody({ type: UpdateUserRequestDto })
  @ApiOkResponse({ type: PersonDto })
  update(
    @CurrentSession() session: Session,
    @Param('userId') userId: string,
    @Body() body: unknown,
  ): Promise<PersonView> {
    return this.updateUser.execute(session, userId, body);
  }

  @Post(':userId/invitation')
  @HttpCode(200)
  @ApiProblemResponse()
  @ApiOperation({
    summary: 'Renovar una invitación',
    description:
      'Da un código nuevo a una invitación pendiente (se perdió o venció); el anterior deja de servir. Responde 409 `invitation-not-pending` si la persona ya canjeó la suya o está dada de baja.',
  })
  @ApiParam({ name: 'userId', type: String, format: 'uuid' })
  @ApiOkResponse({ type: InvitationDto })
  renew(
    @CurrentSession() session: Session,
    @Param('userId') userId: string,
  ): Promise<InvitationView> {
    return this.regenerateInvitation.execute(session, userId);
  }
}
