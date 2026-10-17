import type { PersonChange } from '../../model/user-administration.js';
import type { Role } from '../../model/role.js';

/** Una persona del negocio, tal como la guarda la base. */
export interface PersonRecord {
  readonly id: string;
  readonly fullName: string;
  readonly email: string | null;
  readonly role: Role;
  readonly active: boolean;
  /** `false` mientras es una invitacion que nadie canjeo. */
  readonly bound: boolean;
  /** Hasta cuando vale la invitacion pendiente; `null` si ya se canjeo. */
  readonly invitationExpiresAt: Date | null;
  readonly createdAt: Date;
}

export interface NewInvitation {
  readonly fullName: string;
  readonly email: string | null;
  readonly role: Role;
  /** SHA-256 del codigo, nunca el codigo (ADR 0023). */
  readonly invitationHash: string;
  readonly invitationExpiresAt: Date;
}

/**
 * Puerto de salida: las personas del negocio de la unidad de trabajo. Ninguna operacion recibe el negocio: es de la
 * transaccion, y la base no deja ver ni escribir las de otro.
 */
export interface PeopleRepository {
  /** Hasta `limit` personas ordenadas por nombre y luego por id, a partir de la posicion `after` (nombre, id). */
  list(request: { limit: number; after?: readonly [string, string] }): Promise<PersonRecord[]>;
  find(id: string): Promise<PersonRecord | null>;
  /**
   * Los duenos activos, ordenados por id y BLOQUEADOS hasta que termine la transaccion: dos cambios a la vez sobre
   * los ultimos duenos se turnan en vez de dejar al negocio sin ninguno.
   */
  lockActiveOwners(): Promise<string[]>;
  invite(invitation: NewInvitation): Promise<PersonRecord>;
  /** Cambia el codigo de una invitacion pendiente. `null` si la persona no existe o ya canjeo la suya. */
  rotateInvitation(
    id: string,
    invitationHash: string,
    invitationExpiresAt: Date,
  ): Promise<PersonRecord | null>;
  update(id: string, change: PersonChange): Promise<PersonRecord>;
}
