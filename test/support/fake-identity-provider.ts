import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose';

/**
 * Un servicio de identidad de mentira para las pruebas y el desarrollo local (ADR 0022). Hace lo unico que la API
 * necesita de Supabase Auth: publicar la clave PUBLICA en `/auth/v1/.well-known/jwks.json` y firmar tokens con la
 * privada. La API lo verifica con el mismo codigo que usa con el proyecto real, asi que no hay una ruta de pruebas
 * que el codigo de verdad no recorra. La prueba contra un proyecto real es C2-13.
 */

export interface TokenOptions {
  /** El `sub`: el identificador de la persona. Por omision, uno nuevo. */
  readonly subject?: string;
  readonly email?: string;
  /** Segundos de vida desde ahora; negativo = ya vencido. Por omision, una hora, como Supabase. */
  readonly expiresInSeconds?: number;
  /** Segundos desde ahora en que empieza a valer (`nbf`). */
  readonly notBeforeInSeconds?: number;
  readonly role?: string;
  readonly audience?: string;
  readonly issuer?: string;
  /** Omite estas reclamaciones. */
  readonly omit?: readonly ('sub' | 'exp' | 'iat' | 'role')[];
  /** Firma con otra clave (la del atacante): la firma no coincide con la publicada. */
  readonly signWithAnotherKey?: boolean;
  /** Cambia el `kid` del encabezado. */
  readonly keyId?: string;
}

interface KeyPair {
  readonly privateKey: CryptoKey;
  readonly publicJwk: JWK;
}

export class FakeIdentityProvider {
  private constructor(
    private readonly server: Server,
    readonly issuer: string,
    readonly jwksUrl: string,
    readonly audience: string,
    private keys: KeyPair[],
    private readonly other: KeyPair,
  ) {}

  static async start(audience = 'authenticated'): Promise<FakeIdentityProvider> {
    const first = await newKeyPair('key-1');
    const other = await newKeyPair('key-1');
    const holder: { provider?: FakeIdentityProvider } = {};
    const server = createServer((request, response) => {
      if (request.url === '/auth/v1/.well-known/jwks.json' && holder.provider !== undefined) {
        const body = JSON.stringify({ keys: holder.provider.keys.map((key) => key.publicJwk) });
        response.writeHead(200, { 'content-type': 'application/json' }).end(body);
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${port}`;
    const provider = new FakeIdentityProvider(
      server,
      `${origin}/auth/v1`,
      `${origin}/auth/v1/.well-known/jwks.json`,
      audience,
      [first],
      other,
    );
    holder.provider = provider;
    return provider;
  }

  /** Publica ademas una clave nueva (una rotacion): los tokens firmados con ella solo se verifican si la API vuelve a pedir las claves. */
  async rotateKeys(keyId: string): Promise<void> {
    this.keys = [...this.keys, await newKeyPair(keyId)];
  }

  /** Firma un token. El valor por omision es el de una persona autenticada de Supabase. */
  async token(options: TokenOptions = {}): Promise<string> {
    const signer =
      options.signWithAnotherKey === true
        ? this.other
        : (this.keys[this.keys.length - 1] as KeyPair);
    const now = Math.floor(Date.now() / 1000);
    const omit = new Set(options.omit ?? []);
    const claims: Record<string, unknown> = {
      email: options.email ?? 'persona@example.com',
      aal: 'aal1',
      session_id: randomUUID(),
    };
    if (!omit.has('role')) claims['role'] = options.role ?? 'authenticated';

    let jwt = new SignJWT(claims)
      .setProtectedHeader({ alg: 'ES256', kid: options.keyId ?? (signer.publicJwk.kid as string) })
      .setIssuer(options.issuer ?? this.issuer)
      .setAudience(options.audience ?? this.audience);
    if (!omit.has('sub')) jwt = jwt.setSubject(options.subject ?? randomUUID());
    if (!omit.has('iat')) jwt = jwt.setIssuedAt(now);
    if (!omit.has('exp')) jwt = jwt.setExpirationTime(now + (options.expiresInSeconds ?? 3600));
    if (options.notBeforeInSeconds !== undefined)
      jwt = jwt.setNotBefore(now + options.notBeforeInSeconds);
    return jwt.sign(signer.privateKey);
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

async function newKeyPair(keyId: string): Promise<KeyPair> {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const publicJwk = await exportJWK(publicKey);
  return { privateKey, publicJwk: { ...publicJwk, kid: keyId, alg: 'ES256', use: 'sig' } };
}
