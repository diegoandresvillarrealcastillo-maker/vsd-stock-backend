import type { Role } from '../../model/role.js';

export interface InvitationRedemption {
  /** El hash del codigo que la persona escribio. */
  readonly invitationHash: string;
  /** El `sub` del token verificado: a quien se liga la fila. */
  readonly authUserId: string;
  readonly email: string | null;
  readonly now: Date;
}

export interface RedeemedInvitation {
  readonly businessId: string;
  readonly businessName: string;
  readonly userId: string;
  readonly role: Role;
  readonly fullName: string;
}

/**
 * Puerto de salida: canjear una invitacion. Tampoco cabe en una unidad de trabajo: quien canjea aun no pertenece a
 * ningun negocio, asi que la base le deja ver y tomar UNA fila, la de ese hash, y ninguna otra (ADR 0023).
 *
 * Una invitacion se canjea una sola vez: al canjearla se ligan la identidad, y se borran el hash y el vencimiento.
 * Lanza `InvitationNotFoundError` (no existe, ya se uso o se dio de baja), `InvitationExpiredError` o
 * `AlreadyMemberError` (la persona ya pertenece a un negocio).
 */
export interface InvitationRedeemer {
  redeem(redemption: InvitationRedemption): Promise<RedeemedInvitation>;
}
