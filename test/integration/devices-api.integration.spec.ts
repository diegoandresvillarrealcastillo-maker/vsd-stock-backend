import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applicationUrlOf } from '../../scripts/prepare-database.ts';
import { createApp } from '../../src/infrastructure/config/create-app.js';
import { FakeIdentityProvider } from '../support/fake-identity-provider.js';
import { createAdminPool } from './support/database.js';
import { resetData } from './support/seed.js';
import { select } from './support/sql.js';

interface DeviceBody {
  id: string;
  code: string;
  name: string | null;
  enrolledByUserId: string | null;
  enrolledAt: string;
  revokedAt: string | null;
}

interface Body extends DeviceBody {
  code: string;
  errors: { pointer: string; code: string; detail: string }[];
  items: DeviceBody[];
  nextCursor: string | null;
  businessId: string;
  invitation: { code: string };
}

interface Reply {
  status: number;
  headers: Headers;
  body: Body;
}

/**
 * De punta a punta (C3-01): un token firmado, la API real y la base real. Registrar dispositivos con el rol de cada
 * persona, la idempotencia por `id` (ADR 0019), el reparto de codigos (ADR 0016) y la baja.
 */
describe('devices, end to end (C3-01)', () => {
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

  const newcomer = async () => {
    const subject = randomUUID();
    return await provider.token({ subject, email: `${subject.slice(0, 8)}@ejemplo.co` });
  };

  /** Un negocio abierto por la API, con su dueno, un administrador y un cajero. */
  const team = async () => {
    const owner = await newcomer();
    const opened = await call('POST', '/v1/businesses', owner, {
      businessName: 'Tienda La Esquina',
      ownerName: 'Ana',
    });
    const hire = async (role: 'admin' | 'cashier') => {
      const invited = await call('POST', '/v1/invitations', owner, { fullName: role, role });
      const person = await newcomer();
      await call('POST', '/v1/invitations/redeem', person, { code: invited.body.invitation.code });
      return person;
    };
    return {
      businessId: opened.body.businessId,
      ownerUserId: opened.body.id,
      owner,
      admin: await hire('admin'),
      cashier: await hire('cashier'),
    };
  };

  describe('registering', () => {
    it('gives a new device its code: 201 with the device, for any of the three roles', async () => {
      const t = await team();
      const id = randomUUID();

      const first = await call('POST', '/v1/devices', t.cashier, { id, name: 'Caja del frente' });
      const second = await call('POST', '/v1/devices', t.owner, { id: randomUUID() });
      const third = await call('POST', '/v1/devices', t.admin, { id: randomUUID() });

      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({
        id,
        code: 'AA',
        name: 'Caja del frente',
        revokedAt: null,
      });
      expect(first.body.enrolledByUserId).toEqual(expect.any(String));
      expect(first.headers.get('idempotent-replayed')).toBeNull();
      expect([second.body.code, third.body.code]).toEqual(['AB', 'AC']);
    });

    it('answers the same registration again with 200, the same device and Idempotent-Replayed, without a new code', async () => {
      const t = await team();
      const id = randomUUID();
      const first = await call('POST', '/v1/devices', t.cashier, { id, name: 'Caja' });

      const again = await call('POST', '/v1/devices', t.cashier, { id, name: 'Caja' });
      const next = await call('POST', '/v1/devices', t.cashier, { id: randomUUID() });

      expect(again.status).toBe(200);
      expect(again.headers.get('idempotent-replayed')).toBe('true');
      expect(again.body).toEqual(first.body);
      expect(next.body.code).toBe('AB');
    });

    it('refuses the same id with another name: 409 device-id-reused', async () => {
      const t = await team();
      const id = randomUUID();
      await call('POST', '/v1/devices', t.owner, { id, name: 'Caja' });

      const reply = await call('POST', '/v1/devices', t.owner, { id, name: 'Otra caja' });

      expect(reply.status).toBe(409);
      expect(reply.body.code).toBe('device-id-reused');
    });

    it('refuses the id of a device of another business the same way, and says nothing else', async () => {
      const mine = await team();
      const theirs = await team();
      const id = randomUUID();
      await call('POST', '/v1/devices', mine.owner, { id });

      const reply = await call('POST', '/v1/devices', theirs.owner, { id });

      expect(reply.status).toBe(409);
      expect(reply.body.code).toBe('device-id-reused');
      // El otro negocio no gasto un codigo en el intento.
      const next = await call('POST', '/v1/devices', theirs.owner, { id: randomUUID() });
      expect(next.body.code).toBe('AA');
    });

    it('reports every problem of the body together, with its pointer', async () => {
      const t = await team();

      const reply = await call('POST', '/v1/devices', t.owner, {
        id: 'caja',
        name: '',
        code: 'AA',
      });

      expect(reply.status).toBe(400);
      expect(reply.body.code).toBe('validation-failed');
      expect(reply.body.errors.map((e) => `${e.pointer}:${e.code}`)).toEqual([
        '/code:unknown-field',
        '/id:invalid-id',
        '/name:blank',
      ]);
    });

    it('wants a session', async () => {
      const reply = await call('POST', '/v1/devices', undefined, { id: randomUUID() });

      expect(reply.status).toBe(401);
    });

    it('never gives the same code to devices registered at the same time', async () => {
      const t = await team();

      const replies = await Promise.all(
        Array.from({ length: 8 }, () =>
          call('POST', '/v1/devices', t.cashier, { id: randomUUID() }),
        ),
      );

      expect(replies.map((r) => r.status)).toEqual(Array<number>(8).fill(201));
      expect(new Set(replies.map((r) => r.body.code)).size).toBe(8);
      const counter = await select(
        admin,
        'SELECT next_index FROM device_counter WHERE id_negocio = $1',
        [t.businessId],
      );
      expect(counter[0]?.['next_index']).toBe(8);
    });
  });

  describe('listing', () => {
    it('lists the devices of the business in the order they were enrolled, for the management only', async () => {
      const t = await team();
      const ids = [randomUUID(), randomUUID(), randomUUID()];
      for (const id of ids) await call('POST', '/v1/devices', t.cashier, { id });

      const first = await call('GET', '/v1/devices?limit=2', t.admin);
      const second = await call(
        'GET',
        `/v1/devices?limit=2&cursor=${encodeURIComponent(first.body.nextCursor!)}`,
        t.owner,
      );

      expect(first.status).toBe(200);
      expect(first.body.items.map((d) => d.id)).toEqual(ids.slice(0, 2));
      expect(first.body.items.map((d) => d.code)).toEqual(['AA', 'AB']);
      expect(second.body.items.map((d) => d.id)).toEqual(ids.slice(2));
      expect(second.body.nextCursor).toBeNull();
      expect((await call('GET', '/v1/devices', t.cashier)).status).toBe(403);
    });

    it('does not show the devices of another business', async () => {
      const mine = await team();
      const theirs = await team();
      await call('POST', '/v1/devices', mine.owner, { id: randomUUID() });

      const reply = await call('GET', '/v1/devices', theirs.owner);

      expect(reply.body.items).toEqual([]);
    });

    it('answers a cursor it did not make with 400 invalid-cursor', async () => {
      const t = await team();

      const reply = await call('GET', '/v1/devices?cursor=nada', t.owner);

      expect(reply.status).toBe(400);
      expect(reply.body.errors.map((e) => e.code)).toEqual(['invalid-cursor']);
    });
  });

  describe('letting a device go', () => {
    it('marks it, keeps the code reserved and shows it as let go in the list and when it registers again', async () => {
      const t = await team();
      const id = randomUUID();
      await call('POST', '/v1/devices', t.cashier, { id });

      const revoked = await call('POST', `/v1/devices/${id}/revoke`, t.admin);
      const next = await call('POST', '/v1/devices', t.cashier, { id: randomUUID() });
      const again = await call('POST', '/v1/devices', t.cashier, { id });
      const listed = await call('GET', '/v1/devices', t.owner);

      expect(revoked.status).toBe(200);
      expect(revoked.body).toMatchObject({ id, code: 'AA', revokedAt: expect.any(String) });
      expect(next.body.code).toBe('AB');
      expect(again.status).toBe(200);
      expect(again.body.revokedAt).toBe(revoked.body.revokedAt);
      expect(listed.body.items[0]?.revokedAt).toBe(revoked.body.revokedAt);
    });

    it('can be repeated and keeps the first date', async () => {
      const t = await team();
      const id = randomUUID();
      await call('POST', '/v1/devices', t.cashier, { id });

      const first = await call('POST', `/v1/devices/${id}/revoke`, t.owner);
      const second = await call('POST', `/v1/devices/${id}/revoke`, t.admin);

      expect(second.status).toBe(200);
      expect(second.body.revokedAt).toBe(first.body.revokedAt);
    });

    it('is for the management: a cashier gets 403 and the device stays active', async () => {
      const t = await team();
      const id = randomUUID();
      await call('POST', '/v1/devices', t.cashier, { id });

      const reply = await call('POST', `/v1/devices/${id}/revoke`, t.cashier);

      expect(reply.status).toBe(403);
      expect((await call('GET', '/v1/devices', t.owner)).body.items[0]?.revokedAt).toBeNull();
    });

    it('says 404 device-not-found for an unknown device, one of another business and an id that is not a UUID', async () => {
      const mine = await team();
      const theirs = await team();
      const id = randomUUID();
      await call('POST', '/v1/devices', mine.owner, { id });

      for (const path of [
        `/v1/devices/${randomUUID()}/revoke`,
        `/v1/devices/${id}/revoke`,
        '/v1/devices/no-es-uuid/revoke',
      ]) {
        const reply = await call('POST', path, theirs.owner);
        expect(reply.status, path).toBe(404);
        expect(reply.body.code, path).toBe('device-not-found');
      }
    });
  });
});
