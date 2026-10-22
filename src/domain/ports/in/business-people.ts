import type { Page } from '../../model/pagination.js';
import type { Role } from '../../model/role.js';
import type { PersonStatus } from '../../model/user-administration.js';
import type { Session } from './authenticate.js';
import type { MembershipView } from './get-me.js';

/** Una persona del negocio, como la ve quien la administra. */
export interface PersonView {
  readonly id: string;
  readonly fullName: string;
  readonly email: string | null;
  readonly role: Role;
  readonly status: PersonStatus;
  /** Hasta cuando vale su invitacion, si todavia esta pendiente. */
  readonly invitationExpiresAt: Date | null;
  readonly createdAt: Date;
}

/** La persona invitada y su codigo, que se muestra UNA vez: despues solo queda su hash. */
export interface InvitationView {
  readonly person: PersonView;
  readonly invitation: {
    /** El codigo listo para dictarlo: de cuatro en cuatro. */
    readonly code: string;
    readonly expiresAt: Date;
  };
}

/**
 * Puertos de entrada de negocio y personas (ADR 0023). Cada uno recibe la sesion de quien llama y lo que mando SIN
 * validar (`unknown`): validarlo es parte del caso de uso, para que ningun endpoint pueda olvidarse. Lanzan
 * `ValidationFailedError` si algo no sirve y los errores de `people-errors.ts` y de autenticacion segun el caso.
 */

/** Abre un negocio para quien aun no tiene uno, que queda como su dueno. */
export interface CreateBusiness {
  execute(session: Session, body: unknown): Promise<MembershipView>;
}

/** Invita a alguien al negocio de quien llama. */
export interface InviteUser {
  execute(session: Session, body: unknown): Promise<InvitationView>;
}

/** Da un codigo nuevo a una invitacion pendiente (se perdio o vencio). */
export interface RegenerateInvitation {
  execute(session: Session, userId: string): Promise<InvitationView>;
}

/** Une a quien llama a un negocio con el codigo que le dieron. */
export interface RedeemInvitation {
  execute(session: Session, body: unknown): Promise<MembershipView>;
}

/** Las personas del negocio, por nombre. */
export interface ListUsers {
  execute(session: Session, query: unknown): Promise<Page<PersonView>>;
}

/** Cambia el rol, el nombre o el alta de una persona. */
export interface UpdateUser {
  execute(session: Session, userId: string, body: unknown): Promise<PersonView>;
}
