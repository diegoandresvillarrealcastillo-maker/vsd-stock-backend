import { can, isAction, isAvailableOffline, type Role } from './role.js';

/** Quien intenta hacer algo: sale del token verificado, nunca de lo que declare el cliente (ADR 0005). */
export interface Principal {
  readonly userId: string;
  readonly businessId: string;
  readonly role: Role;
  /** `false` si la persona fue dada de baja. */
  readonly active: boolean;
}

/** Por que se niega, en el orden en que se revisa. */
export type Denial = 'unknown-action' | 'inactive' | 'other-business' | 'role' | 'needs-connection';

export type Decision =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: Denial };

export interface AuthorizationContext {
  /** `false` en un dispositivo sin conexion: solo se permite lo que no necesita al servidor. */
  readonly online: boolean;
}

/**
 * Decide si `principal` puede hacer `action` sobre algo de `target` (ADR 0017). Se niega por omision y se revisa
 * en este orden, para que una negativa no revele mas de lo necesario:
 *
 * 1. la accion no existe;
 * 2. la persona esta dada de baja;
 * 3. lo que toca es de OTRO negocio (el rol no importa: ni el dueno de otro negocio pasa);
 * 4. su rol no la permite;
 * 5. el rol la permite, pero hace falta conexion y no hay.
 *
 * Esta funcion decide, no ejecuta. El servidor la usa siempre con `online: true`; el dispositivo la usa para no
 * ofrecer lo que no puede hacer, y el servidor la vuelve a aplicar cuando llega lo que se hizo sin conexion.
 */
export function authorize(
  principal: Principal,
  action: string,
  target: { readonly businessId: string },
  context: AuthorizationContext,
): Decision {
  if (!isAction(action)) return { allowed: false, reason: 'unknown-action' };
  if (!principal.active) return { allowed: false, reason: 'inactive' };
  if (principal.businessId !== target.businessId)
    return { allowed: false, reason: 'other-business' };
  if (!can(principal.role, action)) return { allowed: false, reason: 'role' };
  if (!context.online && !isAvailableOffline(action)) {
    return { allowed: false, reason: 'needs-connection' };
  }
  return { allowed: true };
}
