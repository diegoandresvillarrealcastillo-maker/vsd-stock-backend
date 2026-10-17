import { ApiProperty } from '@nestjs/swagger';
import { ROLES, type Role } from '../../../domain/model/role.js';
import type { MeView } from '../../../domain/ports/in/get-me.js';

export class MeIdentityDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'El identificador de la persona en el servicio de identidad (el `sub` del token).',
  })
  readonly id!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'El correo con que se registró, si lo tiene.',
  })
  readonly email!: string | null;
}

export class MeMembershipDto {
  @ApiProperty({ type: String, format: 'uuid', description: 'La persona dentro del negocio.' })
  readonly userId!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  readonly businessId!: string;

  @ApiProperty({ type: String, example: 'Tienda La Esquina' })
  readonly businessName!: string;

  @ApiProperty({
    type: String,
    enum: [...ROLES],
    description: 'Su rol en este negocio. Sale de la base de datos, nunca del token.',
  })
  readonly role!: Role;

  @ApiProperty({ type: String, example: 'Ana Gómez' })
  readonly fullName!: string;
}

/** Forma HTTP de «quién soy» (ADR 0022). */
export class MeDto implements MeView {
  @ApiProperty({ type: MeIdentityDto })
  readonly identity!: MeIdentityDto;

  @ApiProperty({
    type: MeMembershipDto,
    nullable: true,
    description:
      'Su lugar en un negocio. `null` si se registró pero aún no creó un negocio ni canjeó una invitación.',
  })
  readonly membership!: MeMembershipDto | null;
}
