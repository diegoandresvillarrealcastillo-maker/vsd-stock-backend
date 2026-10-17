import type { Membership } from '../out/identity-directory.js';
import type { TokenFailure, VerifiedIdentity } from '../out/token-verifier.js';

/** Quien llama: la persona que el token demuestra y, si ya tiene negocio, su lugar en el. */
export interface Session {
  readonly identity: VerifiedIdentity;
  /** `null` si se registro en el servicio de identidad pero aun no creo ni se unio a un negocio. */
  readonly membership: Membership | null;
}

/** Por que no se pudo saber quien llama. */
export type AuthenticationFailure = 'missing' | 'scheme' | TokenFailure;

export class AuthenticationError extends Error {
  constructor(readonly reason: AuthenticationFailure) {
    super(`The caller could not be authenticated: ${reason}`);
    this.name = 'AuthenticationError';
  }
}

/** La persona esta dada de baja: el token es bueno, pero ya no tiene acceso. */
export class UserInactiveError extends Error {
  constructor() {
    super('The person was deactivated and no longer has access');
    this.name = 'UserInactiveError';
  }
}

/** Puerto de entrada: de la cabecera `Authorization` a una sesion. */
export interface Authenticate {
  execute(authorizationHeader: string | undefined): Promise<Session>;
}
