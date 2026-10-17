import { authorize, type Decision, type Principal } from '../domain/model/authorization.js';
import { ForbiddenError, NoMembershipError } from '../domain/model/people-errors.js';
import type { Action } from '../domain/model/role.js';
import { UserInactiveError, type Session } from '../domain/ports/in/authenticate.js';

/** Lo que la base acepta en `app_user.email` (ADR 0021): de 3 a 254 caracteres, sin espacios alrededor. */
const MIN_EMAIL_LENGTH = 3;
const MAX_EMAIL_LENGTH = 254;

/**
 * Quien actua, a partir de la sesion. Una persona sin negocio todavia no puede administrar nada y una dada de baja
 * ya no tiene acceso a nada (ADR 0022).
 */
export function requireMember(session: Session): Principal {
  const membership = session.membership;
  if (membership === null) throw new NoMembershipError();
  if (!membership.active) throw new UserInactiveError();
  return {
    userId: membership.userId,
    businessId: membership.businessId,
    role: membership.role,
    active: true,
  };
}

/** Deja pasar una decision favorable y convierte una negativa en `ForbiddenError`, con el motivo para el registro. */
export function ensureAllowed(decision: Decision): void {
  if (!decision.allowed) throw new ForbiddenError(decision.reason);
}

/** Deja pasar a quien puede hacer `action` en su propio negocio (ADR 0017) y niega a quien no, con el motivo para el registro. */
export function ensureCan(principal: Principal, action: Action): void {
  ensureAllowed(
    authorize(principal, action, { businessId: principal.businessId }, { online: true }),
  );
}

/**
 * El correo del token como lo guarda la base, o `null` si no sirve: el servicio de identidad es quien lo confirma, y
 * una persona sin un correo valido para nuestra base igual puede trabajar.
 */
export function normalizedEmail(email: string | null): string | null {
  if (email === null) return null;
  const normalized = email.trim().toLowerCase();
  const length = [...normalized].length;
  return length >= MIN_EMAIL_LENGTH && length <= MAX_EMAIL_LENGTH ? normalized : null;
}
