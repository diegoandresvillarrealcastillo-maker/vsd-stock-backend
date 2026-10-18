import type { Role } from '../../model/role.js';
import type { Session } from './authenticate.js';

/** El lugar de una persona en su negocio. */
export interface MembershipView {
  readonly userId: string;
  readonly businessId: string;
  readonly businessName: string;
  readonly role: Role;
  readonly fullName: string;
}

/** Quien es la persona y, si ya tiene negocio, donde trabaja. */
export interface MeView {
  readonly identity: { readonly id: string; readonly email: string | null };
  readonly membership: MembershipView | null;
}

/** Puerto de entrada: «quien soy». Lanza `UserInactiveError` si la persona fue dada de baja. */
export interface GetMe {
  execute(session: Session): Promise<MeView>;
}
