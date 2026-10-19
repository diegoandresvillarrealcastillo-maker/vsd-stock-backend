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

interface ResultBody {
  operationId: string | null;
  status: number;
  replayed: boolean;
  body: Record<string, unknown> | null;
  problem: {
    code: string;
    status: number;
    traceId: string;
    instance: string;
    errors?: { pointer: string; code: string }[];
  } | null;
}

interface ProductBody {
  id: string;
  name: string;
  active: boolean;
  updatedAt: string;
}

interface Body {
  code: string;
  errors: { pointer: string; code: string; detail: string }[];
  businessId: string;
  invitation: { code: string };
  id: string;
  userId: string;
  serverTime: string;
  results: ResultBody[];
  asOf: string;
  items: ({ productId: string; quantityMilli: number } & ProductBody)[];
  nextCursor: string | null;
}

interface Reply {
  status: number;
  headers: Headers;
  body: Body;
}

/**
 * De punta a punta (C3-06): un token firmado, la API real y la base real. El lote de sincronizacion (cada operacion con su
 * resultado, la idempotencia, el fallo que no echa a perder a las demas) y la copia de lectura (catalogo y existencias, completos
 * o desde un instante, con cursor).
 */
describe('sync, end to end (C3-06)', () => {
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

  /** Un negocio con su dueno, un administrador y un cajero, un dispositivo, y dos productos con existencia. */
  const team = async () => {
    const owner = await newcomer();
    await call('POST', '/v1/businesses', owner, {
      businessName: 'Tienda La Esquina',
      ownerName: 'Ana',
    });
    const hire = async (role: 'admin' | 'cashier') => {
      const invited = await call('POST', '/v1/invitations', owner, { fullName: role, role });
      const person = await newcomer();
      const redeemed = await call('POST', '/v1/invitations/redeem', person, {
        code: invited.body.invitation.code,
      });
      return { token: person, userId: redeemed.body.userId };
    };
    const deviceId = randomUUID();
    await call('POST', '/v1/devices', owner, { id: deviceId, name: 'Caja' });
    const product = async (sku: string, unitPrice: number) => {
      const created = await call('POST', '/v1/products', owner, {
        name: sku,
        sku,
        unit: 'unit',
        unitPrice,
        taxRateBp: 1900,
      });
      await call('POST', '/v1/stock-adjustments', owner, {
        operationId: randomUUID(),
        productId: created.body.id,
        deltaMilli: 100_000,
        reason: 'Inventario inicial',
      });
      return created.body.id;
    };
    return {
      owner,
      admin: await hire('admin'),
      cashier: await hire('cashier'),
      deviceId,
      cola: await product('COLA', 3500),
      pan: await product('PAN', 4000),
    };
  };
  type Team = Awaited<ReturnType<typeof team>>;

  let serial = 0;
  const open = (t: Team, shiftId: string, change: Record<string, unknown> = {}) => ({
    kind: 'shift-open',
    body: {
      operationId: randomUUID(),
      shiftId,
      deviceId: t.deviceId,
      openingAmount: 50_000,
      deviceTime: new Date().toISOString(),
      clockOffsetMs: 0,
      ...change,
    },
  });
  const sale = (t: Team, shiftId: string, change: Record<string, unknown> = {}) => {
    serial += 1;
    return {
      kind: 'sale',
      body: {
        operationId: randomUUID(),
        shiftId,
        folio: `AA-${String(serial).padStart(6, '0')}`,
        total: 7_000,
        lines: [
          {
            productId: t.cola,
            quantityMilli: 2_000,
            unitPrice: 3_500,
            discount: 0,
            taxRateBp: 1900,
          },
        ],
        payments: [{ method: 'cash', amount: 7_000 }],
        deviceTime: new Date().toISOString(),
        clockOffsetMs: 0,
        ...change,
      },
    };
  };
  const close = (shiftId: string, change: Record<string, unknown> = {}) => ({
    kind: 'shift-close',
    shiftId,
    body: {
      operationId: randomUUID(),
      countedAmount: 57_000,
      deviceTime: new Date().toISOString(),
      clockOffsetMs: 0,
      ...change,
    },
  });
  const fields = (result: ResultBody | undefined) =>
    (result?.problem?.errors ?? []).map((e) => `${e.pointer}:${e.code}`);
  const count = async (table: string) =>
    Number((await select(admin, `SELECT count(*)::int AS n FROM ${table}`))[0]?.['n']);

  describe('the batch', () => {
    it('applies a shift that opens, sales in it and the closing, each with the status of its own route', async () => {
      const t = await team();
      const shiftId = randomUUID();
      const operations = [open(t, shiftId), sale(t, shiftId), sale(t, shiftId), close(shiftId)];

      const reply = await call('POST', '/v1/sync', t.cashier.token, { operations });

      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      expect(reply.body.results.map((result) => [result.status, result.replayed])).toEqual([
        [201, false],
        [201, false],
        [201, false],
        [200, false],
      ]);
      expect(reply.body.results.map((result) => result.operationId)).toEqual(
        operations.map((operation) => operation.body.operationId),
      );
      expect(reply.body.results[0]?.body).toMatchObject({ id: shiftId, openingAmount: 50_000 });
      expect(reply.body.results[1]?.body).toMatchObject({ total: 7_000, shiftId });
      expect(reply.body.results[3]?.body).toMatchObject({ id: shiftId, countedAmount: 57_000 });
      expect(reply.body.results.every((result) => result.problem === null)).toBe(true);
      expect(await count('sale')).toBe(2);
      expect(await select(admin, 'SELECT closed_at IS NOT NULL AS closed FROM cash_shift')).toEqual(
        [{ closed: true }],
      );
    });

    it('says the hour of the server, so that the device can measure its clock', async () => {
      const t = await team();
      const before = Date.now();

      const reply = await call('POST', '/v1/sync', t.cashier.token, {
        operations: [open(t, randomUUID())],
      });

      const at = Date.parse(reply.body.serverTime);
      expect(at).toBeGreaterThanOrEqual(before - 1_000);
      expect(at).toBeLessThanOrEqual(Date.now() + 1_000);
    });

    it('is idempotent: sending it again answers 200 for each, with replayed, and writes nothing twice', async () => {
      const t = await team();
      const shiftId = randomUUID();
      const operations = [open(t, shiftId), sale(t, shiftId), close(shiftId)];
      await call('POST', '/v1/sync', t.cashier.token, { operations });

      const again = await call('POST', '/v1/sync', t.cashier.token, { operations });

      expect(again.status).toBe(200);
      expect(again.body.results.map((result) => [result.status, result.replayed])).toEqual([
        [200, true],
        [200, true],
        [200, true],
      ]);
      expect(await count('sale')).toBe(1);
      expect(await count('cash_shift')).toBe(1);
      expect(await count('stock_movement')).toBe(3);
    });

    it('does not let the operation that fails spoil the others, and says why in the problem of siempre', async () => {
      const t = await team();
      const shiftId = randomUUID();
      const stranger = sale(t, shiftId, {
        lines: [
          {
            productId: randomUUID(),
            quantityMilli: 1_000,
            unitPrice: 1_000,
            discount: 0,
            taxRateBp: 0,
          },
        ],
      });

      const reply = await call('POST', '/v1/sync', t.cashier.token, {
        operations: [open(t, shiftId), stranger, sale(t, shiftId)],
      });

      const [opened, refused, sold] = reply.body.results;
      expect(opened?.status).toBe(201);
      expect(sold?.status).toBe(201);
      expect(refused).toMatchObject({
        operationId: stranger.body.operationId,
        status: 400,
        replayed: false,
        body: null,
        problem: { code: 'validation-failed', status: 400, instance: '/v1/sync' },
      });
      expect(fields(refused)).toEqual(['/lines/0/productId:unknown-product']);
      expect(refused?.problem?.traceId).toBe(reply.headers.get('x-request-id'));
      expect(await count('sale')).toBe(1);
    });

    it('says a conflict as a result and not as the status of the request', async () => {
      const t = await team();
      await call('POST', '/v1/sync', t.cashier.token, { operations: [open(t, randomUUID())] });

      const reply = await call('POST', '/v1/sync', t.cashier.token, {
        operations: [open(t, randomUUID()), sale(t, randomUUID())],
      });

      expect(reply.status).toBe(200);
      expect(reply.body.results[0]).toMatchObject({
        status: 409,
        problem: { code: 'shift-already-open' },
      });
      expect(reply.body.results[1]).toMatchObject({ status: 400 });
      expect(fields(reply.body.results[1])).toEqual(['/shiftId:unknown-shift']);
    });

    it('also marks, accepted, what the server finds odd, exactly like the single route', async () => {
      const t = await team();
      const shiftId = randomUUID();

      const reply = await call('POST', '/v1/sync', t.cashier.token, {
        operations: [open(t, shiftId), sale(t, shiftId, { total: 1 })],
      });

      expect(reply.body.results[1]).toMatchObject({
        status: 201,
        body: { flags: ['total-differs'], attention: true },
      });
    });

    it('lets each operation answer to the rules of its own route: a cashier does not close the shift of somebody else', async () => {
      const t = await team();
      const shiftId = randomUUID();
      await call('POST', '/v1/sync', t.admin.token, { operations: [open(t, shiftId)] });

      const reply = await call('POST', '/v1/sync', t.cashier.token, {
        operations: [close(shiftId), open(t, randomUUID())],
      });

      expect(reply.body.results[0]).toMatchObject({ status: 403, problem: { code: 'forbidden' } });
      expect(reply.body.results[1]?.status).toBe(201);
    });

    it('answers an operation that is not right where it is, and the others go on', async () => {
      const t = await team();

      const reply = await call('POST', '/v1/sync', t.cashier.token, {
        operations: [
          open(t, randomUUID()),
          { kind: 'void', body: { operationId: randomUUID() } },
          { kind: 'sale', body: 'no' },
        ],
      });

      expect(reply.status).toBe(200);
      expect(reply.body.results.map((result) => result.status)).toEqual([201, 400, 400]);
      expect(fields(reply.body.results[1])).toEqual(['/kind:invalid-value']);
      expect(fields(reply.body.results[2])).toEqual(['/body:invalid-type']);
    });

    it('never touches another business: what it names of them does not exist for the person', async () => {
      const t = await team();
      const other = await team();
      const shiftOfOther = randomUUID();
      await call('POST', '/v1/sync', other.owner, { operations: [open(other, shiftOfOther)] });
      const before = await count('sale');

      const reply = await call('POST', '/v1/sync', t.owner, {
        operations: [
          open(t, randomUUID(), { deviceId: other.deviceId }),
          sale(other, shiftOfOther),
        ],
      });

      expect(reply.body.results.map((result) => result.status)).toEqual([400, 400]);
      expect(fields(reply.body.results[0])).toEqual(['/deviceId:unknown-device']);
      // El turno es lo primero que se mira: el de otro negocio no existe, y los productos ni se miran.
      expect(fields(reply.body.results[1])).toEqual(['/shiftId:unknown-shift']);
      expect(await count('sale')).toBe(before);
    });
  });

  describe('the whole request', () => {
    it('wants a session, and a business, and a person who was not let go', async () => {
      const t = await team();
      await call('PATCH', `/v1/users/${t.cashier.userId}`, t.owner, { active: false });
      const body = { operations: [open(t, randomUUID())] };

      const anonymous = await call('POST', '/v1/sync', undefined, body);
      const noBusiness = await call('POST', '/v1/sync', await newcomer(), body);
      const dismissed = await call('POST', '/v1/sync', t.cashier.token, body);

      expect(anonymous.status).toBe(401);
      expect(noBusiness.status).toBe(403);
      expect(noBusiness.body.code).toBe('no-membership');
      expect(dismissed.status).toBe(403);
      expect(dismissed.body.code).toBe('user-inactive');
      expect(await count('cash_shift')).toBe(0);
    });

    it('wants a list of one to fifty operations, and applies nothing otherwise', async () => {
      const t = await team();

      const empty = await call('POST', '/v1/sync', t.cashier.token, { operations: [] });
      const missing = await call('POST', '/v1/sync', t.cashier.token, {});
      const tooMany = await call('POST', '/v1/sync', t.cashier.token, {
        operations: Array.from({ length: 51 }, () => open(t, randomUUID())),
      });
      const extra = await call('POST', '/v1/sync', t.cashier.token, {
        operations: [open(t, randomUUID())],
        otra: 1,
      });

      for (const reply of [empty, missing, tooMany, extra]) {
        expect(reply.status).toBe(400);
        expect(reply.body.code).toBe('validation-failed');
      }
      expect(empty.body.errors.map((e) => `${e.pointer}:${e.code}`)).toEqual([
        '/operations:too-few',
      ]);
      expect(missing.body.errors.map((e) => `${e.pointer}:${e.code}`)).toEqual([
        '/operations:required',
      ]);
      expect(tooMany.body.errors.map((e) => `${e.pointer}:${e.code}`)).toEqual([
        '/operations:too-many',
      ]);
      expect(extra.body.errors.map((e) => `${e.pointer}:${e.code}`)).toEqual([
        '/otra:unknown-field',
      ]);
      expect(await count('cash_shift')).toBe(0);
    });

    it('accepts fifty at a time', async () => {
      const t = await team();
      const shiftId = randomUUID();
      const operations = [open(t, shiftId), ...Array.from({ length: 49 }, () => sale(t, shiftId))];

      const reply = await call('POST', '/v1/sync', t.cashier.token, { operations });

      expect(reply.status, JSON.stringify(reply.body).slice(0, 300)).toBe(200);
      expect(reply.body.results.every((result) => result.status === 201)).toBe(true);
    });
  });

  describe('the read copy: the catalog', () => {
    const product = async (t: Team, name: string) =>
      (
        await call('POST', '/v1/products', t.owner, {
          name,
          sku: name.toUpperCase(),
          unit: 'unit',
          unitPrice: 1000,
          taxRateBp: 0,
        })
      ).body.id;

    it('gives everything to any role, from the oldest change to the newest, archived products included', async () => {
      const t = await team();
      const first = await product(t, 'primero');
      const second = await product(t, 'segundo');
      await call('PATCH', `/v1/products/${first}`, t.owner, { active: false });

      const reply = await call('GET', '/v1/sync/products', t.cashier.token);

      expect(reply.status).toBe(200);
      expect(Date.parse(reply.body.asOf)).toBeLessThanOrEqual(Date.now() + 1_000);
      expect(reply.body.nextCursor).toBeNull();
      const byName = new Map(reply.body.items.map((item) => [item.name, item]));
      // Cola y Pan se crearon primero; despues segundo; y primero, archivado, fue lo ultimo que cambio.
      expect(reply.body.items.map((item) => item.name)).toEqual([
        'COLA',
        'PAN',
        'segundo',
        'primero',
      ]);
      expect(byName.get('primero')?.active).toBe(false);
      expect(byName.get('segundo')?.id).toBe(second);
    });

    it('gives only what changed after since, also an archive and a price change', async () => {
      const t = await team();
      const first = await product(t, 'primero');
      const second = await product(t, 'segundo');
      const marker = (await call('GET', '/v1/sync/products', t.owner)).body.items.at(-1)!.updatedAt;
      await new Promise((resolve) => setTimeout(resolve, 20));
      await call('PATCH', `/v1/products/${second}`, t.owner, { unitPrice: 2000 });
      await call('PATCH', `/v1/products/${first}`, t.owner, { active: false });

      const reply = await call(
        'GET',
        `/v1/sync/products?since=${encodeURIComponent(marker)}`,
        t.cashier.token,
      );

      expect(reply.body.items.map((item) => item.name)).toEqual(['segundo', 'primero']);
    });

    it('pages by cursor in the order of the changes, without repeating or skipping anyone', async () => {
      const t = await team();
      for (const name of ['a', 'b', 'c']) await product(t, name);
      const everything = (await call('GET', '/v1/sync/products', t.owner)).body.items.map(
        (item) => item.id,
      );

      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: Reply = await call(
          'GET',
          `/v1/sync/products?limit=2${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
          t.cashier.token,
        );
        seen.push(...page.body.items.map((item) => item.id));
        cursor = page.body.nextCursor;
      } while (cursor !== null);

      expect(seen).toEqual(everything);
      expect(everything).toHaveLength(5);
    });

    it('does not show another business', async () => {
      const t = await team();
      const other = await team();
      await product(other, 'ajeno');

      const reply = await call('GET', '/v1/sync/products', t.cashier.token);

      expect(reply.body.items.map((item) => item.name)).toEqual(['COLA', 'PAN']);
    });

    it('refuses what it does not know, saying every problem, and wants a session', async () => {
      const t = await team();

      const bad = await call(
        'GET',
        '/v1/sync/products?since=ayer&limit=0&cursor=no&otra=1',
        t.cashier.token,
      );
      const anonymous = await call('GET', '/v1/sync/products');

      expect(bad.status).toBe(400);
      expect(bad.body.errors.map((e) => `${e.pointer}:${e.code}`)).toEqual([
        '/otra:unknown-field',
        '/limit:out-of-range',
        '/cursor:invalid-cursor',
        '/since:invalid-moment',
      ]);
      expect(anonymous.status).toBe(401);
    });
  });

  describe('the read copy: the stock', () => {
    it('gives the stock of now of each product that ever moved, to any role', async () => {
      const t = await team();
      await call('POST', '/v1/stock-adjustments', t.owner, {
        operationId: randomUUID(),
        productId: t.cola,
        deltaMilli: -30_000,
        reason: 'Merma',
      });

      const reply = await call('GET', '/v1/sync/stock', t.cashier.token);

      expect(reply.status).toBe(200);
      expect(reply.body.nextCursor).toBeNull();
      const levels = new Map(reply.body.items.map((item) => [item.productId, item.quantityMilli]));
      expect(levels.get(t.cola)).toBe(70_000);
      expect(levels.get(t.pan)).toBe(100_000);
      expect(reply.body.items.map((item) => item.productId)).toEqual([t.cola, t.pan].sort());
    });

    it('gives only the products that moved after since, and a negative stock as it is', async () => {
      const t = await team();
      const marker = new Date().toISOString();
      await new Promise((resolve) => setTimeout(resolve, 20));
      const shiftId = randomUUID();
      await call('POST', '/v1/sync', t.cashier.token, {
        operations: [
          open(t, shiftId),
          sale(t, shiftId, {
            lines: [
              {
                productId: t.pan,
                quantityMilli: 120_000,
                unitPrice: 4_000,
                discount: 0,
                taxRateBp: 1900,
              },
            ],
            total: 480_000,
            payments: [{ method: 'cash', amount: 480_000 }],
          }),
        ],
      });

      const reply = await call(
        'GET',
        `/v1/sync/stock?since=${encodeURIComponent(marker)}`,
        t.cashier.token,
      );

      expect(reply.body.items).toEqual([{ productId: t.pan, quantityMilli: -20_000 }]);
    });

    it('pages by product, and refuses a cursor that is not a product', async () => {
      const t = await team();

      const first = await call('GET', '/v1/sync/stock?limit=1', t.cashier.token);
      const second = await call(
        'GET',
        `/v1/sync/stock?limit=1&cursor=${encodeURIComponent(first.body.nextCursor!)}`,
        t.cashier.token,
      );
      const bad = await call('GET', '/v1/sync/stock?cursor=no', t.cashier.token);

      expect(first.body.items).toHaveLength(1);
      expect(second.body.items).toHaveLength(1);
      expect(second.body.nextCursor).toBeNull();
      expect(first.body.items[0]?.productId).not.toBe(second.body.items[0]?.productId);
      expect(bad.status).toBe(400);
      expect(bad.body.errors.map((e) => `${e.pointer}:${e.code}`)).toEqual([
        '/cursor:invalid-cursor',
      ]);
    });
  });
});
