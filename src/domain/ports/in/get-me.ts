import type { Role } from '../../model/role.js';
import type { Session } from './authenticate.js';

/** Quien es la persona y, si ya tiene negocio, donde trabaja. */
export interface MeView {
  readonly identity: { readonly id: string; readonly email: string | null };
  readonly membership: {
    readonly userId: string;
    readonly businessId: string;
    readonly businessName: string;
    readonly role: Role;
    readonly fullName: string;
  } | null;
}

/** Puerto de entrada: «quien soy». Lanza `UserInactiveError` si la persona fue dada de baja. */
export interface GetMe {
  execute(session: Session): Promise<MeView>;
}
