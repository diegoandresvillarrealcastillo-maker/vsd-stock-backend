import { authorize, type Decision, type Principal } from './authorization.js';
import type { Action, Role } from './role.js';

/**
 * Los roles que se pueden invitar: el dueno no, porque es quien crea el negocio. Un segundo dueno se nombra
 * cambiando el rol de una persona que ya esta (solo lo hace un dueno).
 */
export const INVITABLE_ROLES = ['admin', 'cashier'] as const;

/** Lo que se puede cambiar de una persona. Lo que no aparece, no cambia. */
export interface PersonChange {
  readonly role?: Role;
  readonly active?: boolean;
  readonly fullName?: string;
}

/** La accion que hace falta para administrar a alguien de ese rol (ADR 0017): al cajero lo administra la gerencia, al resto solo el dueno. */
export function actionToManage(role: Role): Action {
  return role === 'cashier' ? 'user:manage-cashiers' : 'user:manage-admins';
}

/** Si `actor` puede invitar a alguien con el rol `role`. */
export function canInvite(actor: Principal, role: Role): Decision {
  return authorize(actor, actionToManage(role), { businessId: actor.businessId }, { online: true });
}

/**
 * Si `actor` puede cambiar a una persona que hoy tiene el rol `target.role`. Hace falta poder con el rol de antes y,
 * si el cambio lo modifica, con el de despues: asi un administrador no puede ascender a nadie a administrador.
 */
export function canChangePerson(
  actor: Principal,
  target: { readonly role: Role },
  change: PersonChange,
): Decision {
  const context = { online: true };
  const mine = { businessId: actor.businessId };
  const before = authorize(actor, actionToManage(target.role), mine, context);
  if (!before.allowed) return before;
  if (change.role !== undefined && change.role !== target.role) {
    return authorize(actor, actionToManage(change.role), mine, context);
  }
  return before;
}

/**
 * Si el cambio dejaria al negocio sin ningun dueno activo (ADR 0017). `activeOwners` es cuantos hay AHORA, contado
 * bajo candado para que dos cambios a la vez no dejen a ninguno.
 */
export function wouldLeaveNoOwner(
  target: { readonly role: Role; readonly active: boolean },
  change: PersonChange,
  activeOwners: number,
): boolean {
  if (target.role !== 'owner' || !target.active) return false;
  const stillOwner = (change.role ?? target.role) === 'owner' && (change.active ?? target.active);
  if (stillOwner) return false;
  return activeOwners <= 1;
}

export type PersonStatus = 'active' | 'pending' | 'inactive';

/** `pending` es una invitacion que nadie canjeo; `inactive`, una persona (o una invitacion) dada de baja. */
export function personStatus(person: {
  readonly bound: boolean;
  readonly active: boolean;
}): PersonStatus {
  if (!person.active) return 'inactive';
  return person.bound ? 'active' : 'pending';
}
