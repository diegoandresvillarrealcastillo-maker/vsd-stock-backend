import { randomUUID } from 'node:crypto';
import { createSecretKey } from 'node:crypto';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeIdentityProvider } from '../../../../test/support/fake-identity-provider.js';
import { InvalidTokenError, type TokenFailure } from '../../../domain/ports/out/token-verifier.js';
import {
  DEFAULT_CLOCK_TOLERANCE_SECONDS,
  DEFAULT_JWKS_COOLDOWN_MS,
  JoseTokenVerifier,
  MAX_JWKS_CACHE_MS,
} from './jose-token-verifier.js';

/**
 * El corazon de la identidad (ADR 0022): que la API crea un token solo si esta firmado con la clave PUBLICADA por el
 * servicio de identidad, es de este emisor y de este destinatario, es de una persona autenticada y no esta vencido.
 * Cada caso de rechazo es una forma real de colar un token falso.
 */
describe('JoseTokenVerifier', () => {
  let provider: FakeIdentityProvider;
  let verifier: JoseTokenVerifier;

  beforeAll(async () => {
    provider = await FakeIdentityProvider.start();
    verifier = new JoseTokenVerifier({
      issuer: provider.issuer,
      jwksUrl: provider.jwksUrl,
      audience: provider.audience,
      // Sin espera entre pedidos de claves: asi la prueba de rotacion no tarda.
      jwksCooldownMs: 0,
    });
  });

  afterAll(async () => {
    await provider.stop();
  });

  const reasonOf = async (
    token: string,
    using: JoseTokenVerifier = verifier,
  ): Promise<TokenFailure | 'accepted'> => {
    try {
      await using.verify(token);
      return 'accepted';
    } catch (error) {
      if (error instanceof InvalidTokenError) return error.reason;
      throw error;
    }
  };

  describe('a good token', () => {
    it('gives the person and the moment the token stops being valid', async () => {
      const subject = randomUUID();
      const token = await provider.token({
        subject,
        email: 'ana@example.com',
        expiresInSeconds: 600,
      });

      const identity = await verifier.verify(token);

      expect(identity.subject).toBe(subject);
      expect(identity.email).toBe('ana@example.com');
      expect(identity.expiresAt.getTime()).toBeGreaterThan(Date.now() + 590_000);
      expect(identity.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 601_000);
    });

    it('accepts a person without an e-mail, and says so', async () => {
      const token = await provider.token({ email: '' });

      expect((await verifier.verify(token)).email).toBeNull();
    });

    it('accepts a token that expired a moment ago, inside the tolerance for clocks that differ', async () => {
      expect(await reasonOf(await provider.token({ expiresInSeconds: -2 }))).toBe('accepted');
    });

    it('accepts a key the provider published after the verifier last looked (a rotation)', async () => {
      await provider.rotateKeys('key-2');
      const token = await provider.token({ keyId: 'key-2' });

      expect(await reasonOf(token)).toBe('accepted');
    });
  });

  describe('what it refuses', () => {
    it.each(['', 'esto-no-es-un-token', 'a.b.c', 'a.b', 'eyJhbGciOiJFUzI1NiJ9.e30'])(
      'text that is not a token (%j)',
      async (text) => {
        expect(await reasonOf(text)).toBe('malformed');
      },
    );

    it('a token signed with a key the provider never published', async () => {
      const token = await provider.token({ signWithAnotherKey: true });

      expect(await reasonOf(token)).toBe('signature');
    });

    it('a token whose payload was changed after it was signed', async () => {
      const token = await provider.token({ subject: randomUUID() });
      const [header, , signature] = token.split('.') as [string, string, string];
      const forged = Buffer.from(
        JSON.stringify({
          sub: randomUUID(),
          role: 'authenticated',
          iss: provider.issuer,
          aud: provider.audience,
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      ).toString('base64url');

      expect(await reasonOf(`${header}.${forged}.${signature}`)).toBe('signature');
    });

    it('a token with no signature at all (algorithm none)', async () => {
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({
          sub: randomUUID(),
          role: 'authenticated',
          iss: provider.issuer,
          aud: provider.audience,
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      ).toString('base64url');

      expect(await reasonOf(`${header}.${payload}.`)).toBe('algorithm');
    });

    it('a token signed with a shared secret (HS256), even one that carries the right claims', async () => {
      const secret = createSecretKey(Buffer.from('clave-compartida-de-prueba-de-32-bytes!!'));
      const token = await new SignJWT({ role: 'authenticated' })
        .setProtectedHeader({ alg: 'HS256', kid: 'key-1' })
        .setSubject(randomUUID())
        .setIssuer(provider.issuer)
        .setAudience(provider.audience)
        .setExpirationTime('1h')
        .sign(secret);

      expect(await reasonOf(token)).toBe('algorithm');
    });

    it('a token that is already expired', async () => {
      expect(await reasonOf(await provider.token({ expiresInSeconds: -60 }))).toBe('expired');
    });

    it('a token that is not valid yet', async () => {
      expect(await reasonOf(await provider.token({ notBeforeInSeconds: 600 }))).toBe(
        'not-yet-valid',
      );
    });

    it('a token from another issuer', async () => {
      expect(
        await reasonOf(await provider.token({ issuer: 'https://otro.example.com/auth/v1' })),
      ).toBe('issuer');
    });

    it('a token meant for another audience', async () => {
      expect(await reasonOf(await provider.token({ audience: 'anon' }))).toBe('audience');
    });

    it.each(['anon', 'service_role', 'postgres', ''])(
      'a token whose role is %j, not an authenticated person',
      async (role) => {
        expect(await reasonOf(await provider.token({ role }))).toBe('role');
      },
    );

    it('a token with no role', async () => {
      expect(await reasonOf(await provider.token({ omit: ['role'] }))).toBe('role');
    });

    it('a token with no subject', async () => {
      expect(await reasonOf(await provider.token({ omit: ['sub'] }))).toBe('claims');
    });

    it.each(['no-es-un-uuid', '1234', "'; drop table app_user; --"])(
      'a token whose subject (%j) is not a person identifier',
      async (subject) => {
        expect(await reasonOf(await provider.token({ subject }))).toBe('claims');
      },
    );

    it('a token that never expires', async () => {
      expect(await reasonOf(await provider.token({ omit: ['exp'] }))).toBe('claims');
    });

    it('a token that does not say when it was issued', async () => {
      expect(await reasonOf(await provider.token({ omit: ['iat'] }))).toBe('claims');
    });

    it('a token that names a key the provider does not have', async () => {
      expect(await reasonOf(await provider.token({ keyId: 'desconocida' }))).toBe('signature');
    });
  });

  describe('the limits of ADR 0022', () => {
    it('never remembers the published keys longer than the identity service keeps them (10 minutes)', () => {
      expect(MAX_JWKS_CACHE_MS).toBe(10 * 60 * 1000);
    });

    it('waits at least half a minute before asking again for a key it does not know', () => {
      expect(DEFAULT_JWKS_COOLDOWN_MS).toBeGreaterThanOrEqual(30_000);
    });

    it('tolerates only a few seconds of difference between clocks', () => {
      expect(DEFAULT_CLOCK_TOLERANCE_SECONDS).toBe(5);
    });
  });

  it('gives the subject in lower case, so the same person is always the same text', async () => {
    const subject = randomUUID();

    const identity = await verifier.verify(
      await provider.token({ subject: subject.toUpperCase() }),
    );

    expect(identity.subject).toBe(subject);
  });

  describe('when the provider cannot be reached', () => {
    it('says the identity service is unavailable, which is not the same as a bad token', async () => {
      const gone = await FakeIdentityProvider.start();
      const orphan = new JoseTokenVerifier({
        issuer: gone.issuer,
        jwksUrl: gone.jwksUrl,
        audience: gone.audience,
        jwksTimeoutMs: 500,
      });
      const token = await gone.token();
      await gone.stop();

      expect(await reasonOf(token, orphan)).toBe('unavailable');
    });
  });
});
