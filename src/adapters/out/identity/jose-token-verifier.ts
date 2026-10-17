import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload } from 'jose';
import {
  InvalidTokenError,
  type TokenFailure,
  type TokenVerifier,
  type VerifiedIdentity,
} from '../../../domain/ports/out/token-verifier.js';

export interface JoseTokenVerifierOptions {
  /** El emisor esperado (`iss`), por ejemplo `https://REF.supabase.co/auth/v1`. */
  readonly issuer: string;
  /** Donde el servicio de identidad publica sus claves PUBLICAS. */
  readonly jwksUrl: string;
  /** El destinatario esperado (`aud`): `authenticated` para una persona con sesion. */
  readonly audience: string;
  /** Cuanto se recuerdan las claves. Supabase las guarda 10 minutos en su borde; no mas que eso (ADR 0022). */
  readonly jwksCacheMs?: number;
  /** Espera minima entre dos pedidos de claves por un `kid` desconocido: asi un token falso no nos hace martillar al servicio. */
  readonly jwksCooldownMs?: number;
  /** Cuanto esperar la respuesta del servicio de identidad. */
  readonly jwksTimeoutMs?: number;
  /** Segundos de diferencia que se toleran entre el reloj del servicio de identidad y el nuestro. */
  readonly clockToleranceSeconds?: number;
}

/**
 * Solo claves ASIMETRICAS: lo que el servicio publica es una clave publica y la API no guarda ningun secreto de
 * identidad. Un token firmado con `none` o con un secreto compartido (HS256) se rechaza aunque diga lo correcto.
 */
const ALLOWED_ALGORITHMS = ['ES256', 'RS256', 'EdDSA'];

/** Lo que se recuerdan las claves: a lo sumo lo que Supabase las guarda en su borde (ADR 0022, punto 4). */
export const MAX_JWKS_CACHE_MS = 600_000;
/** Espera minima entre dos pedidos de claves por un `kid` desconocido. */
export const DEFAULT_JWKS_COOLDOWN_MS = 30_000;
/** Segundos de diferencia que se toleran entre el reloj del servicio de identidad y el nuestro. */
export const DEFAULT_CLOCK_TOLERANCE_SECONDS = 5;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Verifica los tokens del servicio de identidad contra sus claves publicas (JWKS) con `jose` (ADR 0022). */
export class JoseTokenVerifier implements TokenVerifier {
  private readonly keys: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly options: JoseTokenVerifierOptions) {
    this.keys = createRemoteJWKSet(new URL(options.jwksUrl), {
      cacheMaxAge: Math.min(options.jwksCacheMs ?? MAX_JWKS_CACHE_MS, MAX_JWKS_CACHE_MS),
      cooldownDuration: options.jwksCooldownMs ?? DEFAULT_JWKS_COOLDOWN_MS,
      timeoutDuration: options.jwksTimeoutMs ?? 5_000,
    });
  }

  async verify(token: string): Promise<VerifiedIdentity> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.keys, {
        issuer: this.options.issuer,
        audience: this.options.audience,
        algorithms: ALLOWED_ALGORITHMS,
        clockTolerance: this.options.clockToleranceSeconds ?? DEFAULT_CLOCK_TOLERANCE_SECONDS,
        requiredClaims: ['sub', 'exp', 'iat'],
      }));
    } catch (error) {
      throw new InvalidTokenError(reasonOf(error));
    }

    // Una persona con sesion, no la clave anonima ni la de servicio (que tambien las firma Supabase).
    if (payload['role'] !== 'authenticated') throw new InvalidTokenError('role');
    const subject = payload.sub;
    if (subject === undefined || !UUID.test(subject)) throw new InvalidTokenError('claims');
    const email = payload['email'];
    return {
      subject: subject.toLowerCase(),
      email: typeof email === 'string' && email !== '' ? email : null,
      expiresAt: new Date((payload.exp as number) * 1000),
    };
  }
}

function reasonOf(error: unknown): TokenFailure {
  if (error instanceof errors.JWTExpired) return 'expired';
  if (error instanceof errors.JWTClaimValidationFailed) {
    if (error.claim === 'iss') return 'issuer';
    if (error.claim === 'aud') return 'audience';
    if (error.claim === 'nbf') return 'not-yet-valid';
    return 'claims';
  }
  if (error instanceof errors.JOSEAlgNotAllowed) return 'algorithm';
  if (error instanceof errors.JWSSignatureVerificationFailed) return 'signature';
  if (error instanceof errors.JWKSNoMatchingKey) return 'signature';
  if (error instanceof errors.JWSInvalid || error instanceof errors.JWTInvalid) return 'malformed';
  if (error instanceof errors.JOSEError) {
    // Lo que sobra de jose: no se pudo pedir las claves (tiempo agotado, claves invalidas) o el token no se pudo leer.
    return error.code === 'ERR_JWKS_TIMEOUT' || error.code === 'ERR_JWKS_INVALID'
      ? 'unavailable'
      : 'malformed';
  }
  // Un error que no es de jose es de la red (el servicio no responde): no es culpa del token.
  return 'unavailable';
}
