import {
  AuthenticationError,
  type Authenticate,
  type Session,
} from '../../domain/ports/in/authenticate.js';
import type { IdentityDirectory } from '../../domain/ports/out/identity-directory.js';
import { InvalidTokenError, type TokenVerifier } from '../../domain/ports/out/token-verifier.js';

/** `Authorization: Bearer <token>`: el esquema sin importar mayusculas, separado por espacios y con UN solo token. */
const BEARER = /^bearer +(\S+)$/i;

/**
 * Caso de uso: de la cabecera `Authorization` a una sesion (ADR 0022). Primero se prueba QUIEN es la persona con el
 * token; solo entonces se busca a que negocio pertenece y con que rol. El negocio y el rol salen de la base de datos,
 * jamas de lo que el cliente declare.
 */
export class AuthenticateUseCase implements Authenticate {
  constructor(
    private readonly tokens: TokenVerifier,
    private readonly directory: IdentityDirectory,
  ) {}

  async execute(authorizationHeader: string | undefined): Promise<Session> {
    const header = authorizationHeader?.trim() ?? '';
    if (header === '') throw new AuthenticationError('missing');
    const token = BEARER.exec(header)?.[1];
    if (token === undefined) throw new AuthenticationError('scheme');

    const identity = await this.tokens.verify(token).catch((error: unknown) => {
      if (error instanceof InvalidTokenError) throw new AuthenticationError(error.reason);
      throw error;
    });
    const membership = await this.directory.findMembership(identity.subject);
    return { identity, membership };
  }
}
