import type { Role } from '../../model/role.js';

/** Lo que la base de datos sabe de una persona dentro de un negocio: de ahi salen el negocio y el rol, nunca del token. */
export interface Membership {
  /** El identificador de la persona en nuestra base (`app_user.id`). */
  readonly userId: string;
  readonly businessId: string;
  readonly role: Role;
  /** `false` si la persona fue dada de baja. */
  readonly active: boolean;
  readonly fullName: string;
}

/**
 * Puerto de salida: dado el `sub` de un token ya verificado, a que negocio pertenece la persona y con que rol.
 * Es la consulta que se hace ANTES de conocer el negocio (ADR 0021, punto 7): la base solo deja ver la fila propia.
 */
export interface IdentityDirectory {
  /** `null` si la persona se registro en el servicio de identidad pero aun no tiene negocio. */
  findMembership(authUserId: string): Promise<Membership | null>;
}
