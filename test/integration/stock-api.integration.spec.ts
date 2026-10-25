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

interface MovementBody {
  id: string;
  operationId: string;
  productId: string;
  kind: string;
  deltaMilli: number;
  reason: string | null;
  createdAt: string;
}

interface StockBody {
  productId: string;
  name: string;
  quantityMilli: number;
  minStockMilli: number | null;
  belowMinimum: boolean;
}

interface Body extends MovementBody {
  code: string;
  id: string;
  errors: { pointer: string; code: string; detail: string }[];
  items: (MovementBody & StockBody)[];
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
 * De punta a punta (C2-07): un token firmado, la API real y la base real. Ajustar la existencia es agregar un movimiento,
 * la existencia que se lee es la suma del libro aunque muchas operaciones lleguen a la vez, y el aviso de mínimo sale de
 * esa misma suma.
 */
describe('stock, adjustments and history, end to end (C2-07)', () => {
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
      owner,
      admin: await hire('admin'),
      cashier: await hire('cashier'),
    };
  };

  const product = async (
    token: string,
    sku: string,
    extra: Record<string, unknown> = {},
  ): Promise<string> =>
    (
      await call('POST', '/v1/products', token, {
        name: `Producto ${sku}`,
        sku,
        unit: 'unit',
        unitPrice: 3200,
        taxRateBp: 0,
        taxKind: 'exempt',
        ...extra,
      })
    ).body.id;

  const adjust = (token: string | undefined, productId: string, deltaMilli: number, extra = {}) =>
    call('POST', '/v1/stock-adjustments', token, {
      operationId: randomUUID(),
      productId,
      deltaMilli,
      reason: 'Conteo',
      ...extra,
    });

  const quantityOf = async (token: string, productId: string): Promise<number> => {
    const page = await call('GET', '/v1/stock?limit=200', token);
    return page.body.items.find((item) => item.productId === productId)!.quantityMilli;
  };

  describe('adjusting', () => {
    it('answers 201 with the movement, and the stock goes up or down by exactly that', async () => {
      const { owner, businessId } = await team();
      const rice = await product(owner, 'ARR');
      const operationId = randomUUID();

      const up = await adjust(owner, rice, 10_000, { operationId, reason: 'Existencia inicial' });
      const down = await adjust(owner, rice, -2000, { reason: 'Se cayeron dos paquetes' });

      expect(up.status).toBe(201);
      expect(up.headers.get('idempotent-replayed')).toBeNull();
      expect(up.body).toMatchObject({
        operationId,
        productId: rice,
        kind: 'adjustment',
        deltaMilli: 10_000,
        reason: 'Existencia inicial',
      });
      expect(down.body).toMatchObject({ deltaMilli: -2000, reason: 'Se cayeron dos paquetes' });
      expect(await quantityOf(owner, rice)).toBe(8000);
      const rows = await select(
        admin,
        'SELECT reason, id_negocio FROM stock_movement WHERE product_id = $1',
        [rice],
      );
      expect(rows).toEqual([
        { reason: 'adjustment', id_negocio: businessId },
        { reason: 'adjustment', id_negocio: businessId },
      ]);
    });

    it('lets the stock go below zero, and says so in the list', async () => {
      const { owner } = await team();
      const rice = await product(owner, 'ARR');

      await adjust(owner, rice, -3000);

      expect(await quantityOf(owner, rice)).toBe(-3000);
    });

    it('is for the management and for a person who is signed in', async () => {
      const { owner, admin: manager, cashier } = await team();
      const rice = await product(owner, 'ARR');

      expect((await adjust(manager, rice, 1000)).status).toBe(201);
      const refused = await adjust(cashier, rice, 1000);
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('forbidden');
      expect((await adjust(undefined, rice, 1000)).status).toBe(401);
      expect(await quantityOf(owner, rice)).toBe(1000);
    });

    it('says every problem of what was sent, with the field of each', async () => {
      const { owner } = await team();

      const reply = await call('POST', '/v1/stock-adjustments', owner, {
        operationId: 'no-es-uuid',
        productId: 5,
        deltaMilli: 0,
        reason: '   ',
        saldo: 100,
      });

      expect(reply.status).toBe(400);
      expect(reply.body.code).toBe('validation-failed');
      expect(reply.body.errors.map((e) => `${e.pointer}:${e.code}`)).toEqual([
        '/saldo:unknown-field',
        '/operationId:invalid-id',
        '/productId:invalid-type',
        '/deltaMilli:zero-delta',
        '/reason:blank',
      ]);
    });

    it('wants a reason', async () => {
      const { owner } = await team();
      const rice = await product(owner, 'ARR');

      const reply = await call('POST', '/v1/stock-adjustments', owner, {
        operationId: randomUUID(),
        productId: rice,
        deltaMilli: 1000,
      });

      expect(reply.status).toBe(400);
      expect(reply.body.errors.map((e) => `${e.pointer}:${e.code}`)).toEqual(['/reason:required']);
      expect(await quantityOf(owner, rice)).toBe(0);
    });

    it('says the product does not exist, also when it is of another business', async () => {
      const mine = await team();
      const other = await team();
      const foreign = await product(other.owner, 'AJE');

      for (const productId of [randomUUID(), foreign]) {
        const reply = await adjust(mine.owner, productId, 1000);
        expect(reply.status).toBe(400);
        expect(reply.body.errors.map((e) => `${e.pointer}:${e.code}`)).toEqual([
          '/productId:unknown-product',
        ]);
      }
      expect(await select(admin, 'SELECT 1 FROM stock_movement')).toEqual([]);
    });

    it('takes thousandths only for what is counted by weight or volume', async () => {
      const { owner } = await team();
      const rice = await product(owner, 'ARR');
      const sugar = await product(owner, 'AZU', { unit: 'kilogram' });

      const kilos = await adjust(owner, sugar, 1500);
      const units = await adjust(owner, rice, 1500);

      expect(kilos.status).toBe(201);
      expect(units.status).toBe(400);
      expect(units.body.errors.map((e) => `${e.pointer}:${e.code}`)).toEqual([
        '/deltaMilli:not-whole',
      ]);
    });

    it('adjusts an archived product', async () => {
      const { owner } = await team();
      const rice = await product(owner, 'ARR');
      await adjust(owner, rice, 5000);
      await call('PATCH', `/v1/products/${rice}`, owner, { active: false });

      const reply = await adjust(owner, rice, -5000, { reason: 'Se da de baja' });

      expect(reply.status).toBe(201);
      expect(await quantityOf(owner, rice)).toBe(0);
    });

    it('leaves nothing claimed when it is refused, so the same operation id works once fixed', async () => {
      const { owner } = await team();
      const rice = await product(owner, 'ARR');
      const operationId = randomUUID();

      const refused = await adjust(owner, randomUUID(), 1000, { operationId });
      const fixed = await adjust(owner, rice, 1000, { operationId });

      expect(refused.status).toBe(400);
      expect(fixed.status).toBe(201);
      expect(await quantityOf(owner, rice)).toBe(1000);
    });
  });

  describe('sending the same adjustment again (ADR 0019)', () => {
    it('answers 200 with the same movement and the Idempotent-Replayed header, and adjusts nothing', async () => {
      const { owner } = await team();
      const rice = await product(owner, 'ARR');
      const request = { operationId: randomUUID(), productId: rice, deltaMilli: 4000, reason: 'x' };
      const first = await call('POST', '/v1/stock-adjustments', owner, request);

      const again = await call('POST', '/v1/stock-adjustments', owner, request);

      expect(first.status).toBe(201);
      expect(again.status).toBe(200);
      expect(again.headers.get('idempotent-replayed')).toBe('true');
      expect(again.body).toEqual(first.body);
      expect(await quantityOf(owner, rice)).toBe(4000);
      expect(await select(admin, 'SELECT 1 FROM stock_movement')).toHaveLength(1);
    });

    it('answers 409 operation-id-reused when the same id comes with other data', async () => {
      const { owner } = await team();
      const rice = await product(owner, 'ARR');
      const operationId = randomUUID();
      await adjust(owner, rice, 4000, { operationId });

      const other = await adjust(owner, rice, 5000, { operationId });

      expect(other.status).toBe(409);
      expect(other.body.code).toBe('operation-id-reused');
      expect(await quantityOf(owner, rice)).toBe(4000);
    });

    it('does not take as a repetition an operation id that a purchase holds', async () => {
      const { owner } = await team();
      const rice = await product(owner, 'ARR');
      const operationId = randomUUID();
      await call('POST', '/v1/purchases', owner, {
        operationId,
        lines: [{ productId: rice, quantityMilli: 1000, unitCost: 10 }],
      });

      const reply = await adjust(owner, rice, 1000, { operationId, reason: 'x' });

      expect(reply.status).toBe(409);
      expect(reply.body.code).toBe('operation-id-reused');
    });

    it('applies an adjustment sent several times at once exactly one time', async () => {
      const { owner } = await team();
      const rice = await product(owner, 'ARR');
      const request = { operationId: randomUUID(), productId: rice, deltaMilli: 3000, reason: 'x' };

      const replies = await Promise.all(
        Array.from({ length: 6 }, () => call('POST', '/v1/stock-adjustments', owner, request)),
      );

      expect(replies.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 201]);
      expect(new Set(replies.map((r) => r.body.id)).size).toBe(1);
      expect(await quantityOf(owner, rice)).toBe(3000);
    });
  });

  describe('the stock, the minimum and the history', () => {
    it('lists every product with what there is, to every role, and a product that never moved has zero', async () => {
      const { owner, admin: manager, cashier } = await team();
      const rice = await product(owner, 'ARR');
      const salt = await product(owner, 'SAL');
      await adjust(owner, rice, 24_000);

      for (const token of [owner, manager, cashier]) {
        const page = await call('GET', '/v1/stock', token);
        expect(page.status).toBe(200);
        expect(
          Object.fromEntries(page.body.items.map((i) => [i.productId, i.quantityMilli])),
        ).toEqual({ [rice]: 24_000, [salt]: 0 });
      }
      expect((await call('GET', '/v1/stock')).status).toBe(401);
    });

    it('warns when the stock falls below the minimum set from the catalog, and stops when it is enough', async () => {
      const { owner } = await team();
      const rice = await product(owner, 'ARR');
      await adjust(owner, rice, 12_000);
      await call('PATCH', `/v1/products/${rice}`, owner, { minStockMilli: 10_000 });
      const none = await call('GET', '/v1/stock?belowMinimum=true', owner);

      await adjust(owner, rice, -5000);
      const some = await call('GET', '/v1/stock?belowMinimum=true', owner);
      await adjust(owner, rice, 5000);
      const enough = await call('GET', '/v1/stock?belowMinimum=true', owner);

      expect(none.body.items).toEqual([]);
      expect(some.body.items.map((i) => [i.productId, i.quantityMilli, i.belowMinimum])).toEqual([
        [rice, 7000, true],
      ]);
      expect(enough.body.items).toEqual([]);
      expect(
        (await call('PATCH', `/v1/products/${rice}`, owner, { minStockMilli: null })).status,
      ).toBe(200);
    });

    it('searches by name, SKU or barcode and walks the list in pages', async () => {
      const { owner } = await team();
      await product(owner, 'ARR-500', { name: 'Arroz Diana', barcode: '7701234567897' });
      for (const n of [1, 2, 3, 4]) await product(owner, `OTR-${n}`, { name: `Otro ${n}` });

      expect(
        (await call('GET', '/v1/stock?search=arroz', owner)).body.items.map((i) => i.name),
      ).toEqual(['Arroz Diana']);
      expect((await call('GET', '/v1/stock?search=7701234567897', owner)).body.items).toHaveLength(
        1,
      );

      const names: string[] = [];
      let query = '?limit=2';
      for (let guard = 0; guard < 20; guard += 1) {
        const page = await call('GET', `/v1/stock${query}`, owner);
        names.push(...page.body.items.map((i) => i.name));
        if (page.body.nextCursor === null) break;
        query = `?limit=2&cursor=${encodeURIComponent(page.body.nextCursor)}`;
      }
      expect(names).toEqual(['Arroz Diana', 'Otro 1', 'Otro 2', 'Otro 3', 'Otro 4']);
    });

    it('refuses what is asked wrongly', async () => {
      const { owner } = await team();

      const reply = await call(
        'GET',
        '/v1/stock?belowMinimum=quizas&limit=0&cursor=basura&search=',
        owner,
      );

      expect(reply.status).toBe(400);
      expect(reply.body.errors.map((e) => `${e.pointer}:${e.code}`)).toEqual([
        '/limit:out-of-range',
        '/cursor:invalid-cursor',
        '/search:blank',
        '/belowMinimum:invalid-value',
      ]);
    });

    it('hands over the history of a product with purchases and adjustments, the newest first, to every role', async () => {
      const { owner, cashier } = await team();
      const rice = await product(owner, 'ARR');
      await call('POST', '/v1/purchases', owner, {
        operationId: randomUUID(),
        note: 'Pedido de octubre',
        lines: [{ productId: rice, quantityMilli: 24_000, unitCost: 2500 }],
      });
      await adjust(owner, rice, -2000, { reason: 'Se cayeron dos' });

      const history = await call('GET', `/v1/stock-movements?productId=${rice}`, cashier);

      expect(history.status).toBe(200);
      expect(history.body.items.map((m) => [m.kind, m.deltaMilli, m.reason])).toEqual([
        ['adjustment', -2000, 'Se cayeron dos'],
        ['purchase', 24_000, 'Pedido de octubre'],
      ]);
      expect(history.body.nextCursor).toBeNull();
    });

    it('walks the history in pages by following the cursor, without repeating or skipping', async () => {
      const { owner } = await team();
      const rice = await product(owner, 'ARR');
      for (const quantity of [1000, 2000, 3000, 4000, 5000]) await adjust(owner, rice, quantity);

      const deltas: number[] = [];
      let query = `?productId=${rice}&limit=2`;
      for (let guard = 0; guard < 20; guard += 1) {
        const page = await call('GET', `/v1/stock-movements${query}`, owner);
        deltas.push(...page.body.items.map((m) => m.deltaMilli));
        if (page.body.nextCursor === null) break;
        query = `?productId=${rice}&limit=2&cursor=${encodeURIComponent(page.body.nextCursor)}`;
      }

      expect(deltas).toEqual([5000, 4000, 3000, 2000, 1000]);
    });

    it('says what is wrong with the request, and that a product that does not exist has no history', async () => {
      const mine = await team();
      const other = await team();
      const foreign = await product(other.owner, 'AJE');

      const missing = await call('GET', '/v1/stock-movements', mine.owner);
      const badCursor = await call(
        'GET',
        `/v1/stock-movements?productId=${foreign}&cursor=basura`,
        mine.owner,
      );
      const unknown = await call(
        'GET',
        `/v1/stock-movements?productId=${randomUUID()}`,
        mine.owner,
      );
      const ofAnother = await call('GET', `/v1/stock-movements?productId=${foreign}`, mine.owner);

      expect(missing.status).toBe(400);
      expect(missing.body.errors.map((e) => `${e.pointer}:${e.code}`)).toEqual([
        '/productId:required',
      ]);
      expect(badCursor.status).toBe(400);
      expect(badCursor.body.errors.map((e) => e.code)).toEqual(['invalid-cursor']);
      for (const reply of [unknown, ofAnother]) {
        expect(reply.status).toBe(404);
        expect(reply.body.code).toBe('product-not-found');
      }
      expect((await call('GET', `/v1/stock-movements?productId=${foreign}`)).status).toBe(401);
    });

    it('does not show a business the stock of another', async () => {
      const mine = await team();
      const other = await team();
      const foreign = await product(other.owner, 'AJE');
      await adjust(other.owner, foreign, 9000);

      expect((await call('GET', '/v1/stock', mine.owner)).body.items).toEqual([]);
    });
  });

  describe('many things at the same time (ADR 0013)', () => {
    it('keeps the stock equal to the sum of the book when purchases and adjustments of the same products arrive together', async () => {
      const { owner } = await team();
      const a = await product(owner, 'AAA');
      const b = await product(owner, 'BBB', { unit: 'kilogram' });
      const requests = Array.from({ length: 16 }, (_, i) =>
        i % 2 === 0
          ? call('POST', '/v1/purchases', owner, {
              operationId: randomUUID(),
              lines: (i % 4 === 0 ? [a, b] : [b, a]).map((productId) => ({
                productId,
                quantityMilli: 2000,
                unitCost: 100,
              })),
            })
          : adjust(owner, i % 3 === 0 ? a : b, i % 4 === 1 ? -1000 : 1000),
      );

      const replies = await Promise.all(requests);

      expect(replies.every((r) => r.status === 201)).toBe(true);
      const drift = await select(
        admin,
        `SELECT b.product_id FROM stock_balance b
          WHERE b.quantity <> (SELECT coalesce(sum(m.delta), 0) FROM stock_movement m
                                WHERE m.id_negocio = b.id_negocio AND m.warehouse_id = b.warehouse_id
                                  AND m.product_id = b.product_id)`,
      );
      expect(drift).toEqual([]);
      const sums = await select(
        admin,
        'SELECT product_id, sum(delta)::bigint AS total FROM stock_movement GROUP BY product_id',
      );
      for (const row of sums) {
        expect(await quantityOf(owner, row['product_id'] as string)).toBe(Number(row['total']));
      }
    });
  });
});
