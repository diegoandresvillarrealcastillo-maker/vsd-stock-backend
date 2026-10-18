import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applicationUrlOf } from '../../scripts/prepare-database.ts';
import { createApp } from '../../src/infrastructure/config/create-app.js';
import { FakeIdentityProvider } from '../support/fake-identity-provider.js';
import { createAdminPool } from './support/database.js';
import { BUSINESS_A, BUSINESS_B, resetData, seedBusiness } from './support/seed.js';

/**
 * De punta a punta (ADR 0022): un token firmado por el servicio de identidad, la API que lo verifica con su codigo de
 * verdad y la base de datos real. Es el recorrido de una persona al abrir la aplicacion.
 */
describe('GET /v1/me, end to end', () => {
  let provider: FakeIdentityProvider;
  let admin: pg.Pool;
  let app: NestExpressApplication;
  let baseUrl: string;

  beforeAll(async () => {
    provider = await FakeIdentityProvider.start();
    admin = createAdminPool(2);
  });

  afterAll(async () => {
    await provider.stop();
    await admin.end();
  });

  beforeEach(async () => {
    await resetData(admin);
    app = await createApp({
      quiet: true,
      databaseUrl: applicationUrlOf(process.env['TEST_DATABASE_URL']!),
      auth: { issuer: provider.issuer, jwksUrl: provider.jwksUrl, audience: provider.audience },
    });
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await app.close();
  });

  const me = (token?: string) =>
    fetch(
      `${baseUrl}/v1/me`,
      token === undefined ? {} : { headers: { Authorization: `Bearer ${token}` } },
    );

  const authUserOf = async (userId: string): Promise<string> =>
    (
      await admin.query<{ auth_user_id: string }>(
        'SELECT auth_user_id FROM app_user WHERE id = $1',
        [userId],
      )
    ).rows[0]!.auth_user_id;

  it('tells a member who they are and which business they work for', async () => {
    const a = await seedBusiness(admin, BUSINESS_A, 'Tienda La Esquina');
    const token = await provider.token({
      subject: await authUserOf(a.ownerId),
      email: 'ana@example.com',
    });

    const response = await me(token);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      identity: { id: await authUserOf(a.ownerId), email: 'ana@example.com' },
      membership: {
        userId: a.ownerId,
        businessId: BUSINESS_A,
        businessName: 'Tienda La Esquina',
        role: 'owner',
        fullName: 'Dueña',
      },
    });
  });

  it('tells each person about their own business, never about the other', async () => {
    const a = await seedBusiness(admin, BUSINESS_A, 'Tienda A');
    const b = await seedBusiness(admin, BUSINESS_B, 'Tienda B');

    const ofA = (await (
      await me(await provider.token({ subject: await authUserOf(a.ownerId) }))
    ).json()) as {
      membership: { businessName: string };
    };
    const ofB = (await (
      await me(await provider.token({ subject: await authUserOf(b.ownerId) }))
    ).json()) as {
      membership: { businessName: string };
    };

    expect(ofA.membership.businessName).toBe('Tienda A');
    expect(ofB.membership.businessName).toBe('Tienda B');
  });

  it('tells a person who signed in but has no business that they have none, instead of failing', async () => {
    await seedBusiness(admin, BUSINESS_A);
    const subject = randomUUID();

    const response = await me(await provider.token({ subject, email: 'nuevo@example.com' }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      identity: { id: subject, email: 'nuevo@example.com' },
      membership: null,
    });
  });

  it('refuses a person who was deactivated, even though their token is still good', async () => {
    const a = await seedBusiness(admin, BUSINESS_A);
    await admin.query('UPDATE app_user SET active = false, deactivated_at = now() WHERE id = $1', [
      a.ownerId,
    ]);

    const response = await me(await provider.token({ subject: await authUserOf(a.ownerId) }));

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'user-inactive' });
  });

  it('takes the role from the database, not from anything the token says', async () => {
    const a = await seedBusiness(admin, BUSINESS_A);
    await admin.query("UPDATE app_user SET role = 'cashier' WHERE id = $1", [a.ownerId]);

    const response = await me(await provider.token({ subject: await authUserOf(a.ownerId) }));
    const body = (await response.json()) as { membership: { role: string } };

    expect(body.membership.role).toBe('cashier');
  });

  describe('refusals', () => {
    it('answers 401 unauthenticated without a token', async () => {
      const response = await me();

      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: 'unauthenticated' });
      expect(response.headers.get('www-authenticate')).toBe('Bearer');
    });

    it('answers 401 token-expired to a token that expired', async () => {
      const response = await me(await provider.token({ expiresInSeconds: -3600 }));

      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: 'token-expired' });
    });

    it('answers 401 invalid-token to a token signed by somebody else, and to one that was tampered with', async () => {
      const forged = await provider.token({ signWithAnotherKey: true });
      const tampered = `${(await provider.token()).slice(0, -3)}abc`;

      for (const token of [forged, tampered, 'esto-no-es-un-token']) {
        const response = await me(token);
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({ code: 'invalid-token' });
      }
    });

    it('does not leak the token in any answer', async () => {
      const token = await provider.token({ signWithAnotherKey: true });

      const text = await (await me(token)).text();

      expect(text).not.toContain(token);
    });

    it('answers 503 identity-unavailable, not 401, when the identity service cannot be reached', async () => {
      const gone = await FakeIdentityProvider.start();
      const token = await gone.token();
      const offline = await createApp({
        quiet: true,
        databaseUrl: applicationUrlOf(process.env['TEST_DATABASE_URL']!),
        auth: { issuer: gone.issuer, jwksUrl: gone.jwksUrl, audience: gone.audience },
      });
      await gone.stop();
      await offline.listen(0, '127.0.0.1');
      const { port } = offline.getHttpServer().address() as AddressInfo;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/v1/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ code: 'identity-unavailable' });
        expect(response.headers.get('retry-after')).toBe('5');
      } finally {
        await offline.close();
      }
    });
  });
});

describe('GET /v1/me without configuration', () => {
  it('says the identity service is not configured, instead of rejecting everybody as if their token were bad', async () => {
    const app = await createApp({ quiet: true });
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/me`, {
        headers: { Authorization: 'Bearer x.y.z' },
      });

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: 'identity-not-configured' });
    } finally {
      await app.close();
    }
  });

  it('says the database is not configured when only the identity service is', async () => {
    const provider = await FakeIdentityProvider.start();
    const app = await createApp({
      quiet: true,
      auth: { issuer: provider.issuer, jwksUrl: provider.jwksUrl, audience: provider.audience },
    });
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/me`, {
        headers: { Authorization: `Bearer ${await provider.token()}` },
      });

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: 'database-not-configured' });
    } finally {
      await app.close();
      await provider.stop();
    }
  });
});
