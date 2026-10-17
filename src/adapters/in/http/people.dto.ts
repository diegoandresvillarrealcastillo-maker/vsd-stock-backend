import { ApiProperty } from '@nestjs/swagger';
import { ROLES, type Role } from '../../../domain/model/role.js';
import { INVITABLE_ROLES } from '../../../domain/model/user-administration.js';
import type { PersonStatus } from '../../../domain/model/user-administration.js';
import type { InvitationView, PersonView } from '../../../domain/ports/in/business-people.js';

/** Lo que se manda para abrir un negocio. */
export class CreateBusinessRequestDto {
  @ApiProperty({ type: String, maxLength: 120, example: 'Tienda La Esquina' })
  readonly businessName!: string;

  @ApiProperty({
    type: String,
    maxLength: 120,
    example: 'Ana Gómez',
    description: 'Cómo se llama quien lo abre.',
  })
  readonly ownerName!: string;
}

/** Lo que se manda para invitar a alguien. */
export class InviteUserRequestDto {
  @ApiProperty({ type: String, maxLength: 120, example: 'Luis Pérez' })
  readonly fullName!: string;

  @ApiProperty({
    type: String,
    enum: [...INVITABLE_ROLES],
    description:
      'Administrador o cajero. Un administrador solo puede invitar cajeros; invitar administradores es del dueño. No se invita a un dueño: se nombra cambiando el rol de una persona que ya está.',
  })
  readonly role!: Exclude<Role, 'owner'>;

  @ApiProperty({
    type: String,
    required: false,
    maxLength: 254,
    example: 'luis@ejemplo.co',
    description: 'Opcional. Se guarda en minúsculas. No se envía ningún correo.',
  })
  readonly email?: string;
}

/** Lo que se manda para canjear una invitación. */
export class RedeemInvitationRequestDto {
  @ApiProperty({
    type: String,
    example: '0123-4567-89AB-CDEF',
    description:
      'El código que dieron a la persona. Se acepta en mayúsculas o minúsculas, con o sin guiones y espacios.',
  })
  readonly code!: string;
}

/** Lo que se manda para cambiar a una persona. Al menos un campo. */
export class UpdateUserRequestDto {
  @ApiProperty({ type: String, required: false, maxLength: 120 })
  readonly fullName?: string;

  @ApiProperty({
    type: String,
    required: false,
    enum: [...ROLES],
    description:
      'Cambiar el rol de un cajero a administrador, o de cualquiera a dueño, es del dueño.',
  })
  readonly role?: Role;

  @ApiProperty({
    type: Boolean,
    required: false,
    description:
      '`false` da de baja a la persona (o revoca su invitación); `true` la reactiva. No se puede dar de baja al último dueño.',
  })
  readonly active?: boolean;
}

/** Una persona del negocio. */
export class PersonDto implements PersonView {
  @ApiProperty({ type: String, format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ type: String, example: 'Luis Pérez' })
  readonly fullName!: string;

  @ApiProperty({ type: String, nullable: true })
  readonly email!: string | null;

  @ApiProperty({ type: String, enum: [...ROLES] })
  readonly role!: Role;

  @ApiProperty({
    type: String,
    enum: ['active', 'pending', 'inactive'],
    description:
      '`pending` es una invitación que nadie canjeó; `inactive`, una persona (o invitación) dada de baja.',
  })
  readonly status!: PersonStatus;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Hasta cuándo vale su invitación, mientras esté pendiente.',
  })
  readonly invitationExpiresAt!: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  readonly createdAt!: Date;
}

export class InvitationCodeDto {
  @ApiProperty({
    type: String,
    example: '0123-4567-89AB-CDEF',
    description:
      'El código de la invitación, de cuatro en cuatro para dictarlo. **Se muestra una sola vez**: el servidor solo guarda su hash. Si se pierde, se renueva.',
  })
  readonly code!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  readonly expiresAt!: Date;
}

/** La persona invitada y su código. */
export class InvitationDto implements InvitationView {
  @ApiProperty({ type: PersonDto })
  readonly person!: PersonDto;

  @ApiProperty({ type: InvitationCodeDto })
  readonly invitation!: InvitationCodeDto;
}

/** Una página de personas (ADR 0019). */
export class PersonPageDto {
  @ApiProperty({ type: [PersonDto] })
  readonly items!: PersonDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Se pasa tal cual como `cursor` para pedir la página siguiente. `null` si no hay más. Es opaco: no se interpreta.',
  })
  readonly nextCursor!: string | null;
}
