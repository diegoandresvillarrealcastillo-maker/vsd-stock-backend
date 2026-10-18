/** Por que un token no sirve. El cliente solo ve `expired` o `invalid`; el resto es para quien lee el registro. */
export type TokenFailure =
  | 'malformed'
  | 'signature'
  | 'algorithm'
  | 'expired'
  | 'not-yet-valid'
  | 'issuer'
  | 'audience'
  | 'role'
  | 'claims'
  /** No se pudo ni preguntar: el servicio de identidad no responde. No es culpa del token. */
  | 'unavailable'
  /** Nadie configuro el servicio de identidad (AUTH_ISSUER, AUTH_JWKS_URL y AUTH_AUDIENCE). */
  | 'not-configured';

export class InvalidTokenError extends Error {
  constructor(readonly reason: TokenFailure) {
    // Nunca el token: es una credencial.
    super(`The token is not valid: ${reason}`);
    this.name = 'InvalidTokenError';
  }
}

/** Quien es la persona segun un token YA verificado. */
export interface VerifiedIdentity {
  /** El `sub`: el identificador de la persona en el servicio de identidad (un UUID). */
  readonly subject: string;
  readonly email: string | null;
  /** Hasta cuando vale el token. */
  readonly expiresAt: Date;
}

/**
 * Puerto de salida: comprobar que un token lo firmo el servicio de identidad (ADR 0022). Lanza `InvalidTokenError`
 * con el motivo si no sirve; si lo acepta, la persona es la del `sub` y nada mas: el negocio y el rol NO salen del
 * token sino de la base de datos.
 */
export interface TokenVerifier {
  verify(token: string): Promise<VerifiedIdentity>;
}
