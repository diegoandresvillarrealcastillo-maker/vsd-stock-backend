import {
  InvalidTokenError,
  type TokenVerifier,
  type VerifiedIdentity,
} from '../../../domain/ports/out/token-verifier.js';

/**
 * El verificador cuando nadie configuro el servicio de identidad (AUTH_ISSUER, AUTH_JWKS_URL): deja arrancar la API y
 * dice con claridad que falta, en lugar de rechazar a todos como si su token fuera malo.
 */
export class UnconfiguredTokenVerifier implements TokenVerifier {
  verify(_token: string): Promise<VerifiedIdentity> {
    return Promise.reject(new InvalidTokenError('not-configured'));
  }
}
