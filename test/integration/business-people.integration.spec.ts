import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applicationUrlOf } from '../../scripts/prepare-database.ts';
import { createApp } from '../../src/infrastructure/config/create-app.js';
import { FakeIdentityProvider } from '../support/fake-identity-provider.js';
import { select } from './support/sql.js';
import { createAdminPool } from './support/database.js';
import { BUSINESS_A, BUSINESS_B, resetData, seedBusiness } from './support/seed.js';

/** Lo que las pruebas leen de una respuesta. Todo es opcional en la realidad; aqui se declara lo que la prueba espera. */
interface PersonBody {
  id: string;
  fullName: string;
  role: string;
  status: string;
  email: string | null;
}

interface Body {
  code: string;
  errors: { pointer: string; code: string; detail: string }[];
  userId: string;
  businessId: string;
  items: PersonBody[];
  nextCursor: string;
  person: PersonBody;
  invitation: { code: string; expiresAt: string };
  membership: { businessId: string; role: string; businessName: string };
  role: string;
  status: string;
}

interface Reply {
  status: number;
  headers: Headers;
  body: Body;
}

/**
 * De punta a punta (ADR 0023): un token firmado, la API real y la base real. El recorrido de quien abre un negocio, invita a
 * alguien, y esa persona canjea su codigo y trabaja; y lo que cada rol puede y no puede hacer en el camino.
 */
describe('business and people, end to end (ADR 0023)', () => {
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

  const call = async (
    method: string,
    path: string,
    token?: string,
    body?: unknown,
  ): Promise<Reply> => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      body: (text === '' ? null : JSON.parse(text)) as Body,
    };
  };

  /** El token de una persona que acaba de registrarse y no tiene negocio. */
  const newcomer = async (email = `${randomUUID().slice(0, 8)}@ejemplo.co`) => {
    const subject = randomUUID();
    return { subject, email, token: await provider.token({ subject, email }) };
  };

  /** Un negocio abierto por la API, con su dueno. */
  const openBusiness = async (businessName = 'Tienda La Esquina', ownerName = 'Ana Gómez') => {
    const owner = await newcomer();
    const reply = await call('POST', '/v1/businesses', owner.token, { businessName, ownerName });
    return { owner, reply, businessId: reply.body?.businessId };
  };

  /** Una persona invitada que ya canjeo su codigo. */
  const hire = async (ownerToken: string, role: 'admin' | 'cashier', fullName = 'Luis Pérez') => {
    const invited = await call('POST', '/v1/invitations', ownerToken, { fullName, role });
    const person = await newcomer();
    const redeemed = await call('POST', '/v1/invitations/redeem', person.token, {
      code: invited.body.invitation.code,
    });
    return { person, userId: redeemed.body.userId, invited, redeemed };
  };

  describe('opening a business', () => {
    it('opens it for the person, who becomes its owner and can use it right away', async () => {
      const { owner, reply, businessId } = await openBusiness('Tienda La Esquina', 'Ana Gómez');

      expect(reply.status).toBe(201);
      expect(reply.body).toEqual({
        userId: expect.any(String),
        businessId: expect.any(String),
        businessName: 'Tienda La Esquina',
        role: 'owner',
        fullName: 'Ana Gómez',
      });
      const me = await call('GET', '/v1/me', owner.token);
      expect(me.body.membership).toMatchObject({
        businessId,
        role: 'owner',
        businessName: 'Tienda La Esquina',
      });
    });

    it('answers every response with no-store, even this one', async () => {
      const { reply } = await openBusiness();

      expect(reply.headers.get('cache-control')).toBe('no-store');
    });

    it('stores the email of the identity, not one the client could invent', async () => {
      const owner = await newcomer('Ana@Ejemplo.CO');
      await call('POST', '/v1/businesses', owner.token, {
        businessName: 'Tienda',
        ownerName: 'Ana',
      });

      const row = (
        await select(admin, 'SELECT email FROM app_user WHERE auth_user_id = $1', [owner.subject])
      )[0]!;
      expect(row['email']).toBe('ana@ejemplo.co');
    });

    it('refuses someone who already belongs to a business', async () => {
      const { owner } = await openBusiness();

      const again = await call('POST', '/v1/businesses', owner.token, {
        businessName: 'Otra',
        ownerName: 'Ana',
      });

      expect(again.status).toBe(409);
      expect(again.body.code).toBe('already-member');
      expect((await select(admin, 'SELECT count(*)::int AS n FROM business'))[0]!['n']).toBe(1);
    });

    it('lists every problem in the request, with a pointer to each', async () => {
      const owner = await newcomer();

      const reply = await call('POST', '/v1/businesses', owner.token, {
        businessName: '',
        ownerName: 7,
        extra: true,
      });

      expect(reply.status).toBe(400);
      expect(reply.headers.get('content-type')).toContain('application/problem+json');
      expect(reply.body.code).toBe('validation-failed');
      expect(
        reply.body.errors.map((e: { pointer: string; code: string }) => `${e.pointer}:${e.code}`),
      ).toEqual(['/extra:unknown-field', '/businessName:blank', '/ownerName:invalid-type']);
    });

    it('answers a body that is not JSON with 400, not with a crash', async () => {
      const owner = await newcomer();

      const response = await fetch(`${baseUrl}/v1/businesses`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json' },
        body: '{no es json',
      });

      expect(response.status).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe('validation-failed');
    });

    it('needs a token', async () => {
      const reply = await call('POST', '/v1/businesses', undefined, {
        businessName: 'T',
        ownerName: 'A',
      });

      expect(reply.status).toBe(401);
    });
  });

  describe('inviting and redeeming', () => {
    it('lets the owner invite a cashier, who redeems the code and works in that business', async () => {
      const { owner, businessId } = await openBusiness();

      const invited = await call('POST', '/v1/invitations', owner.token, {
        fullName: 'Luis Pérez',
        role: 'cashier',
      });

      expect(invited.status).toBe(201);
      expect(invited.body.person).toMatchObject({
        fullName: 'Luis Pérez',
        role: 'cashier',
        status: 'pending',
        email: null,
      });
      expect(invited.body.invitation.code).toMatch(
        /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/,
      );
      expect(new Date(invited.body.invitation.expiresAt).getTime()).toBeGreaterThan(
        Date.now() + 6 * 86_400_000,
      );

      const luis = await newcomer();
      const redeemed = await call('POST', '/v1/invitations/redeem', luis.token, {
        code: invited.body.invitation.code,
      });

      expect(redeemed.status).toBe(200);
      expect(redeemed.body).toMatchObject({
        businessId,
        role: 'cashier',
        fullName: 'Luis Pérez',
        businessName: 'Tienda La Esquina',
      });
      const me = await call('GET', '/v1/me', luis.token);
      expect(me.body.membership).toMatchObject({ businessId, role: 'cashier' });
    });

    it('stores only the hash of the code, never the code', async () => {
      const { owner } = await openBusiness();
      const invited = await call('POST', '/v1/invitations', owner.token, {
        fullName: 'Luis',
        role: 'cashier',
      });
      const plain = invited.body.invitation.code.replaceAll('-', '');

      const rows = await select(
        admin,
        'SELECT invitation_hash FROM app_user WHERE invitation_hash IS NOT NULL',
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]!['invitation_hash']).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(await select(admin, 'SELECT * FROM app_user'))).not.toContain(plain);
    });

    it('accepts the code the way a person types it: lower case, with spaces, without dashes', async () => {
      const { owner } = await openBusiness();
      const invited = await call('POST', '/v1/invitations', owner.token, {
        fullName: 'Luis',
        role: 'cashier',
      });
      const typed = invited.body.invitation.code.replaceAll('-', ' ').toLowerCase();

      const redeemed = await call('POST', '/v1/invitations/redeem', (await newcomer()).token, {
        code: typed,
      });

      expect(redeemed.status).toBe(200);
    });

    it('works only once', async () => {
      const { owner } = await openBusiness();
      const invited = await call('POST', '/v1/invitations', owner.token, {
        fullName: 'Luis',
        role: 'cashier',
      });
      const code = invited.body.invitation.code;
      await call('POST', '/v1/invitations/redeem', (await newcomer()).token, { code });

      const again = await call('POST', '/v1/invitations/redeem', (await newcomer()).token, {
        code,
      });

      expect(again.status).toBe(404);
      expect(again.body.code).toBe('invitation-not-found');
    });

    it('does not find a code that does not exist, and says nothing else about it', async () => {
      const reply = await call('POST', '/v1/invitations/redeem', (await newcomer()).token, {
        code: '0000-0000-0000-0000',
      });

      expect(reply.status).toBe(404);
      expect(reply.body.code).toBe('invitation-not-found');
    });

    it('tells apart a code that expired', async () => {
      const { owner } = await openBusiness();
      const invited = await call('POST', '/v1/invitations', owner.token, {
        fullName: 'Luis',
        role: 'cashier',
      });
      await admin.query(
        "UPDATE app_user SET invitation_expires_at = now() - interval '1 minute' WHERE invitation_hash IS NOT NULL",
      );

      const reply = await call('POST', '/v1/invitations/redeem', (await newcomer()).token, {
        code: invited.body.invitation.code,
      });

      expect(reply.status).toBe(410);
      expect(reply.body.code).toBe('invitation-expired');
    });

    it('refuses a code with the wrong shape before looking anything up', async () => {
      const reply = await call('POST', '/v1/invitations/redeem', (await newcomer()).token, {
        code: 'abc',
      });

      expect(reply.status).toBe(400);
      expect(reply.body.errors).toEqual([
        {
          pointer: '/code',
          code: 'invalid-code',
          detail: 'El código no tiene la forma de un código de invitación.',
        },
      ]);
    });

    it('refuses someone who already works in a business, and keeps the invitation pending', async () => {
      const { owner } = await openBusiness('Una');
      const other = await openBusiness('Otra');
      const invited = await call('POST', '/v1/invitations', owner.token, {
        fullName: 'Luis',
        role: 'cashier',
      });

      const reply = await call('POST', '/v1/invitations/redeem', other.owner.token, {
        code: invited.body.invitation.code,
      });

      expect(reply.status).toBe(409);
      expect(reply.body.code).toBe('already-member');
      const pending = await call('GET', '/v1/users', owner.token);
      expect(pending.body.items.find((p) => p.fullName === 'Luis')?.status).toBe('pending');
    });

    it('does not let an administrator invite an administrator, but lets the owner (ADR 0017)', async () => {
      const { owner } = await openBusiness();
      const adela = await hire(owner.token, 'admin', 'Adela');

      const byAdmin = await call('POST', '/v1/invitations', adela.person.token, {
        fullName: 'Otro',
        role: 'admin',
      });
      const byOwner = await call('POST', '/v1/invitations', owner.token, {
        fullName: 'Otro',
        role: 'admin',
      });
      const cashierByAdmin = await call('POST', '/v1/invitations', adela.person.token, {
        fullName: 'Caja',
        role: 'cashier',
      });

      expect(byAdmin.status).toBe(403);
      expect(byAdmin.body.code).toBe('forbidden');
      expect(byOwner.status).toBe(201);
      expect(cashierByAdmin.status).toBe(201);
    });

    it('does not let a cashier invite anyone, even with a request that makes no sense', async () => {
      const { owner } = await openBusiness();
      const luis = await hire(owner.token, 'cashier');

      const reply = await call('POST', '/v1/invitations', luis.person.token, { basura: true });

      expect(reply.status).toBe(403);
    });

    it('does not let anyone invite an owner', async () => {
      const { owner } = await openBusiness();

      const reply = await call('POST', '/v1/invitations', owner.token, {
        fullName: 'Otro dueño',
        role: 'owner',
      });

      expect(reply.status).toBe(400);
      expect(reply.body.errors[0]).toMatchObject({ pointer: '/role', code: 'invalid-value' });
    });

    it('asks a person with no business to open one or redeem a code first', async () => {
      const reply = await call('POST', '/v1/invitations', (await newcomer()).token, {
        fullName: 'Luis',
        role: 'cashier',
      });

      expect(reply.status).toBe(403);
      expect(reply.body.code).toBe('no-membership');
    });
  });

  describe('renewing an invitation', () => {
    it('gives a pending invitation a new code and the old one stops working', async () => {
      const { owner } = await openBusiness();
      const invited = await call('POST', '/v1/invitations', owner.token, {
        fullName: 'Luis',
        role: 'cashier',
      });
      const userId = invited.body.person.id;

      const renewed = await call('POST', `/v1/users/${userId}/invitation`, owner.token);

      expect(renewed.status).toBe(200);
      expect(renewed.body.invitation.code).not.toBe(invited.body.invitation.code);
      const old = await call('POST', '/v1/invitations/redeem', (await newcomer()).token, {
        code: invited.body.invitation.code,
      });
      expect(old.status).toBe(404);
      const fresh = await call('POST', '/v1/invitations/redeem', (await newcomer()).token, {
        code: renewed.body.invitation.code,
      });
      expect(fresh.status).toBe(200);
    });

    it('has nothing to renew for a person who already redeemed theirs', async () => {
      const { owner } = await openBusiness();
      const luis = await hire(owner.token, 'cashier');

      const reply = await call('POST', `/v1/users/${luis.userId}/invitation`, owner.token);

      expect(reply.status).toBe(409);
      expect(reply.body.code).toBe('invitation-not-pending');
    });

    it('says there is no such person for an id that is not a UUID or belongs to another business', async () => {
      const { owner } = await openBusiness();
      const other = await openBusiness('Otra');

      expect((await call('POST', '/v1/users/no-es-un-uuid/invitation', owner.token)).status).toBe(
        404,
      );
      const foreign = await call(
        'POST',
        `/v1/users/${other.reply.body.userId}/invitation`,
        owner.token,
      );
      expect(foreign.status).toBe(404);
      expect(foreign.body.code).toBe('person-not-found');
    });
  });

  describe('listing', () => {
    it('lists the people of the business, with their state, and never those of another', async () => {
      const { owner } = await openBusiness('Una', 'Ana');
      await hire(owner.token, 'cashier', 'Beto');
      await call('POST', '/v1/invitations', owner.token, { fullName: 'Carla', role: 'cashier' });
      await openBusiness('Otra', 'Ajena');

      const reply = await call('GET', '/v1/users', owner.token);

      expect(reply.status).toBe(200);
      expect(reply.body.nextCursor).toBeNull();
      expect(
        reply.body.items.map((p: { fullName: string; role: string; status: string }) => [
          p.fullName,
          p.role,
          p.status,
        ]),
      ).toEqual([
        ['Ana', 'owner', 'active'],
        ['Beto', 'cashier', 'active'],
        ['Carla', 'cashier', 'pending'],
      ]);
    });

    it('never shows an invitation hash or the code', async () => {
      const { owner } = await openBusiness();
      await call('POST', '/v1/invitations', owner.token, { fullName: 'Carla', role: 'cashier' });

      const reply = await call('GET', '/v1/users', owner.token);

      expect(JSON.stringify(reply.body)).not.toMatch(/hash|code|[0-9a-f]{64}/i);
    });

    it('walks the list in pages by following the cursor', async () => {
      const { owner } = await openBusiness('Una', 'Ana');
      for (const name of ['Beto', 'Carla', 'Diana'])
        await call('POST', '/v1/invitations', owner.token, { fullName: name, role: 'cashier' });

      const first = await call('GET', '/v1/users?limit=2', owner.token);
      const second = await call(
        'GET',
        `/v1/users?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`,
        owner.token,
      );

      expect(first.body.items.map((p: { fullName: string }) => p.fullName)).toEqual([
        'Ana',
        'Beto',
      ]);
      expect(second.body.items.map((p: { fullName: string }) => p.fullName)).toEqual([
        'Carla',
        'Diana',
      ]);
      expect(second.body.nextCursor).toBeNull();
    });

    it('refuses a limit out of range and a cursor it did not make', async () => {
      const { owner } = await openBusiness();

      const reply = await call('GET', '/v1/users?limit=500&cursor=basura', owner.token);

      expect(reply.status).toBe(400);
      expect(reply.body.errors.map((e: { pointer: string }) => e.pointer)).toEqual([
        '/limit',
        '/cursor',
      ]);
    });

    it('lets an administrator list and refuses a cashier', async () => {
      const { owner } = await openBusiness();
      const adela = await hire(owner.token, 'admin', 'Adela');
      const luis = await hire(owner.token, 'cashier', 'Luis');

      expect((await call('GET', '/v1/users', adela.person.token)).status).toBe(200);
      expect((await call('GET', '/v1/users', luis.person.token)).status).toBe(403);
    });
  });

  describe('changing a person', () => {
    it('lets an administrator deactivate a cashier, who loses access right away', async () => {
      const { owner } = await openBusiness();
      const adela = await hire(owner.token, 'admin', 'Adela');
      const luis = await hire(owner.token, 'cashier', 'Luis');

      const off = await call('PATCH', `/v1/users/${luis.userId}`, adela.person.token, {
        active: false,
      });

      expect(off.status).toBe(200);
      expect(off.body).toMatchObject({ id: luis.userId, status: 'inactive' });
      const me = await call('GET', '/v1/me', luis.person.token);
      expect(me.status).toBe(403);
      expect(me.body.code).toBe('user-inactive');
    });

    it('lets only the owner change an administrator', async () => {
      const { owner } = await openBusiness();
      const adela = await hire(owner.token, 'admin', 'Adela');
      const other = await hire(owner.token, 'admin', 'Otro');

      const byAdmin = await call('PATCH', `/v1/users/${other.userId}`, adela.person.token, {
        active: false,
      });
      const byOwner = await call('PATCH', `/v1/users/${other.userId}`, owner.token, {
        active: false,
      });

      expect(byAdmin.status).toBe(403);
      expect(byOwner.status).toBe(200);
    });

    it('lets the owner promote a cashier, and the new role counts on the next request', async () => {
      const { owner } = await openBusiness();
      const luis = await hire(owner.token, 'cashier', 'Luis');
      expect((await call('GET', '/v1/users', luis.person.token)).status).toBe(403);

      await call('PATCH', `/v1/users/${luis.userId}`, owner.token, { role: 'admin' });

      expect((await call('GET', '/v1/users', luis.person.token)).status).toBe(200);
    });

    it('never leaves the business without an owner', async () => {
      const { owner, reply } = await openBusiness();

      const demote = await call('PATCH', `/v1/users/${reply.body.userId}`, owner.token, {
        role: 'admin',
      });
      const deactivate = await call('PATCH', `/v1/users/${reply.body.userId}`, owner.token, {
        active: false,
      });

      expect(demote.status).toBe(409);
      expect(demote.body.code).toBe('last-owner');
      expect(deactivate.status).toBe(409);
      expect((await call('GET', '/v1/me', owner.token)).body.membership.role).toBe('owner');
    });

    it('lets an owner step down once another owner exists', async () => {
      const { owner, reply } = await openBusiness();
      const luis = await hire(owner.token, 'admin', 'Luis');
      await call('PATCH', `/v1/users/${luis.userId}`, owner.token, { role: 'owner' });

      const stepDown = await call('PATCH', `/v1/users/${reply.body.userId}`, owner.token, {
        role: 'admin',
      });

      expect(stepDown.status).toBe(200);
      expect(stepDown.body.role).toBe('admin');
    });

    it('asks for at least one change, and refuses fields it does not know', async () => {
      const { owner, reply } = await openBusiness();

      const empty = await call('PATCH', `/v1/users/${reply.body.userId}`, owner.token, {});
      const unknown = await call('PATCH', `/v1/users/${reply.body.userId}`, owner.token, {
        email: 'x@y.co',
      });

      expect(empty.status).toBe(400);
      expect(empty.body.errors[0]?.code).toBe('empty-change');
      expect(unknown.status).toBe(400);
      expect(unknown.body.errors[0]).toMatchObject({ pointer: '/email', code: 'unknown-field' });
    });

    it('can not reach a person of another business, and says only that they do not exist', async () => {
      const { owner } = await openBusiness('Una');
      const other = await openBusiness('Otra');

      const reply = await call('PATCH', `/v1/users/${other.reply.body.userId}`, owner.token, {
        active: false,
      });

      expect(reply.status).toBe(404);
      expect(reply.body.code).toBe('person-not-found');
      expect((await call('GET', '/v1/me', other.owner.token)).status).toBe(200);
    });
  });

  describe('isolation between businesses', () => {
    it('keeps two businesses apart through the whole API', async () => {
      await seedBusiness(admin, BUSINESS_A, 'Sembrada A');
      await seedBusiness(admin, BUSINESS_B, 'Sembrada B');
      const one = await openBusiness('Uno', 'Ana');
      const two = await openBusiness('Dos', 'Beto');
      await hire(one.owner.token, 'cashier', 'Del uno');
      await hire(two.owner.token, 'cashier', 'Del dos');

      const ofOne = await call('GET', '/v1/users', one.owner.token);
      const ofTwo = await call('GET', '/v1/users', two.owner.token);

      expect(ofOne.body.items.map((p: { fullName: string }) => p.fullName)).toEqual([
        'Ana',
        'Del uno',
      ]);
      expect(ofTwo.body.items.map((p: { fullName: string }) => p.fullName)).toEqual([
        'Beto',
        'Del dos',
      ]);
    });
  });
});
