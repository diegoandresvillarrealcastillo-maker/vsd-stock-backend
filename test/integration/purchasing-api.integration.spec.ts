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

interface PurchaseBody {
  id: string;
  operationId: string;
  warehouseId: string;
  supplierId: string | null;
  note: string | null;
  createdAt: string;
  createdByUserId: string | null;
  lines: { productId: string; quantityMilli: number; unitCost: number }[];
  lineCount: number;
}

interface Body extends PurchaseBody {
  code: string;
  name: string;
  contact: string | null;
  errors: { pointer: string; code: string; detail: string }[];
  items: PurchaseBody[];
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
 * De punta a punta (C2-06): un token firmado, la API real y la base real. Proveedores, bodega y compras con el rol de
 * cada persona, la idempotencia de ADR 0019 y lo que de verdad importa de una compra: que la existencia suba exactamente
 * lo comprado, aunque muchas compras lleguen a la vez.
 */
describe('suppliers, warehouse and purchases, end to end (C2-06)', () => {
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

  const product = async (token: string, unit: 'unit' | 'kilogram', sku: string) =>
    (
      await call('POST', '/v1/products', token, {
        name: `Producto ${sku}`,
        sku,
        unit,
        unitPrice: 3200,
        taxRateBp: 0,
      })
    ).body.id;

  const line = (productId: string, quantityMilli = 5000, unitCost = 2500) => ({
    productId,
    quantityMilli,
    unitCost,
  });

  const balanceOf = async (productId: string): Promise<number> => {
    const rows = await select(admin, 'SELECT quantity FROM stock_balance WHERE product_id = $1', [
      productId,
    ]);
    return rows.length === 0 ? 0 : Number(rows[0]!['quantity']);
  };

  describe('suppliers', () => {
    it('lets the management keep a list of suppliers and refuses a cashier', async () => {
      const { owner, admin: manager, cashier } = await team();

      const created = await call('POST', '/v1/suppliers', owner, {
        name: 'Distribuidora El Sol',
        contact: '300 123 4567',
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ name: 'Distribuidora El Sol', contact: '300 123 4567' });

      const renamed = await call('PATCH', `/v1/suppliers/${created.body.id}`, manager, {
        name: 'Distribuidora La Luna',
        contact: null,
      });
      expect(renamed.status).toBe(200);
      expect(renamed.body).toMatchObject({ name: 'Distribuidora La Luna', contact: null });

      expect((await call('GET', '/v1/suppliers', owner)).body.items).toHaveLength(1);
      for (const response of [
        await call('GET', '/v1/suppliers', cashier),
        await call('POST', '/v1/suppliers', cashier, { name: 'X' }),
        await call('PATCH', `/v1/suppliers/${created.body.id}`, cashier, { name: 'X' }),
        await call('DELETE', `/v1/suppliers/${created.body.id}`, cashier),
      ]) {
        expect(response.status).toBe(403);
        expect(response.body.code).toBe('forbidden');
      }

      expect((await call('DELETE', `/v1/suppliers/${created.body.id}`, manager)).status).toBe(204);
      expect((await call('GET', '/v1/suppliers', owner)).body.items).toEqual([]);
    });

    it('asks for a person who is signed in', async () => {
      expect((await call('GET', '/v1/suppliers')).status).toBe(401);
      expect((await call('POST', '/v1/suppliers', undefined, { name: 'X' })).status).toBe(401);
    });

    it('says every problem of what was sent, at once', async () => {
      const { owner } = await team();

      const reply = await call('POST', '/v1/suppliers', owner, { name: '', phone: 1 });

      expect(reply.status).toBe(400);
      expect(reply.body.code).toBe('validation-failed');
      expect(reply.body.errors.map((e) => `${e.pointer}:${e.code}`)).toEqual([
        '/phone:unknown-field',
        '/name:blank',
      ]);
    });

    it('says 404 for a supplier that does not exist, belongs to another business or is not even an id', async () => {
      const mine = await team();
      const other = await team();
      const foreign = await call('POST', '/v1/suppliers', other.owner, { name: 'Ajeno' });

      for (const id of [randomUUID(), foreign.body.id, 'no-es-uuid']) {
        const patch = await call('PATCH', `/v1/suppliers/${id}`, mine.owner, { name: 'X' });
        expect(patch.status).toBe(404);
        expect(patch.body.code).toBe('supplier-not-found');
        const remove = await call('DELETE', `/v1/suppliers/${id}`, mine.owner);
        expect(remove.status).toBe(404);
        expect(remove.body.code).toBe('supplier-not-found');
      }
      expect((await call('GET', '/v1/suppliers', mine.owner)).body.items).toEqual([]);
    });

    it('keeps a supplier that has purchases', async () => {
      const { owner } = await team();
      const rice = await product(owner, 'unit', 'ARR');
      const supplier = await call('POST', '/v1/suppliers', owner, { name: 'Con historia' });
      await call('POST', '/v1/purchases', owner, {
        operationId: randomUUID(),
        supplierId: supplier.body.id,
        lines: [line(rice, 1000)],
      });

      const reply = await call('DELETE', `/v1/suppliers/${supplier.body.id}`, owner);

      expect(reply.status).toBe(409);
      expect(reply.body.code).toBe('supplier-in-use');
    });

    it('walks the list in pages by following the cursor', async () => {
      const { owner } = await team();
      for (const name of ['E', 'C', 'A', 'D', 'B']) {
        await call('POST', '/v1/suppliers', owner, { name });
      }

      const names: string[] = [];
      let query = '?limit=2';
      for (;;) {
        const page = await call('GET', `/v1/suppliers${query}`, owner);
        names.push(...page.body.items.map((s) => (s as unknown as { name: string }).name));
        if (page.body.nextCursor === null) break;
        query = `?limit=2&cursor=${encodeURIComponent(page.body.nextCursor)}`;
      }

      expect(names).toEqual(['A', 'B', 'C', 'D', 'E']);
    });
  });

  describe('the warehouse', () => {
    it('is one per business and every role can see it', async () => {
      const { owner, admin: manager, cashier } = await team();

      const replies = await Promise.all(
        [owner, manager, cashier].map((token) => call('GET', '/v1/warehouse', token)),
      );

      const ids = new Set(replies.map((r) => r.body.id));
      expect(replies.map((r) => r.status)).toEqual([200, 200, 200]);
      expect(replies[0]!.body.name).toBe('Principal');
      expect(ids.size).toBe(1);
      expect([...ids][0]).toBe((await select(admin, 'SELECT id FROM warehouse'))[0]!['id']);
    });

    it('asks for a person who is signed in', async () => {
      expect((await call('GET', '/v1/warehouse')).status).toBe(401);
    });
  });

  describe('registering a purchase', () => {
    it('answers 201 with the purchase and raises the stock by what was bought', async () => {
      const { owner, businessId } = await team();
      const rice = await product(owner, 'unit', 'ARR');
      const sugar = await product(owner, 'kilogram', 'AZU');
      const supplier = await call('POST', '/v1/suppliers', owner, { name: 'Distribuidora' });
      const operationId = randomUUID();

      const reply = await call('POST', '/v1/purchases', owner, {
        operationId,
        supplierId: supplier.body.id,
        note: 'Pedido de octubre',
        lines: [line(rice, 24_000, 2500), line(sugar, 12_500, 4200)],
      });

      expect(reply.status).toBe(201);
      expect(reply.headers.get('idempotent-replayed')).toBeNull();
      expect(reply.body).toMatchObject({
        operationId,
        supplierId: supplier.body.id,
        note: 'Pedido de octubre',
      });
      expect(reply.body.lines).toHaveLength(2);
      expect(await balanceOf(rice)).toBe(24_000);
      expect(await balanceOf(sugar)).toBe(12_500);
      const movements = await select(
        admin,
        `SELECT reason, note, operation_id, id_negocio FROM stock_movement WHERE product_id = $1`,
        [sugar],
      );
      expect(movements).toEqual([
        {
          reason: 'purchase',
          note: 'Pedido de octubre',
          operation_id: operationId,
          id_negocio: businessId,
        },
      ]);
    });

    it('adds up several purchases of the same product', async () => {
      const { owner } = await team();
      const rice = await product(owner, 'unit', 'ARR');

      for (const quantity of [5000, 3000, 2000]) {
        await call('POST', '/v1/purchases', owner, {
          operationId: randomUUID(),
          lines: [line(rice, quantity)],
        });
      }

      expect(await balanceOf(rice)).toBe(10_000);
    });

    it('is for the management and for a person who is signed in', async () => {
      const { owner, admin: manager, cashier } = await team();
      const rice = await product(owner, 'unit', 'ARR');
      const send = (token?: string) =>
        call('POST', '/v1/purchases', token, { operationId: randomUUID(), lines: [line(rice)] });

      expect((await send(manager)).status).toBe(201);
      const refused = await send(cashier);
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('forbidden');
      expect((await send()).status).toBe(401);
      expect(await balanceOf(rice)).toBe(5000);
    });

    it('says every problem of what was sent, with the line and the field of each', async () => {
      const { owner } = await team();
      const rice = await product(owner, 'unit', 'ARR');

      const reply = await call('POST', '/v1/purchases', owner, {
        operationId: 'no-es-uuid',
        lines: [line(rice), { productId: 'x', quantityMilli: 0, unitCost: -1 }, line(rice, 100, 9)],
      });

      expect(reply.status).toBe(400);
      expect(reply.body.code).toBe('validation-failed');
      expect(reply.body.errors.map((e) => `${e.pointer}:${e.code}`)).toEqual([
        '/operationId:invalid-id',
        '/lines/1/productId:invalid-id',
        '/lines/1/quantityMilli:out-of-range',
        '/lines/1/unitCost:out-of-range',
        '/lines/2/productId:duplicate-product',
      ]);
      expect(await balanceOf(rice)).toBe(0);
    });

    it('says which product does not exist, which is archived and which supplier is unknown', async () => {
      const { owner } = await team();
      const rice = await product(owner, 'unit', 'ARR');
      const old = await product(owner, 'unit', 'VIE');
      await call('PATCH', `/v1/products/${old}`, owner, { active: false });
      const other = await team();
      const foreignProduct = await product(other.owner, 'unit', 'AJE');
      const foreignSupplier = await call('POST', '/v1/suppliers', other.owner, { name: 'Ajeno' });

      const reply = await call('POST', '/v1/purchases', owner, {
        operationId: randomUUID(),
        supplierId: foreignSupplier.body.id,
        lines: [line(rice), line(foreignProduct), line(old)],
      });

      expect(reply.status).toBe(400);
      expect(reply.body.errors.map((e) => `${e.pointer}:${e.code}`)).toEqual([
        '/supplierId:unknown-supplier',
        '/lines/1/productId:unknown-product',
        '/lines/2/productId:archived-product',
      ]);
      expect(await balanceOf(rice)).toBe(0);
      expect(await select(admin, 'SELECT 1 FROM purchase')).toEqual([]);
    });

    it('takes thousandths only for what is counted by weight or volume', async () => {
      const { owner } = await team();
      const rice = await product(owner, 'unit', 'ARR');
      const sugar = await product(owner, 'kilogram', 'AZU');

      const fractional = await call('POST', '/v1/purchases', owner, {
        operationId: randomUUID(),
        lines: [line(sugar, 1500), line(rice, 1500)],
      });

      expect(fractional.status).toBe(400);
      expect(fractional.body.errors.map((e) => `${e.pointer}:${e.code}`)).toEqual([
        '/lines/1/quantityMilli:not-whole',
      ]);
      expect(await balanceOf(sugar)).toBe(0);
    });

    it('leaves nothing claimed when it is refused, so the same operation id works once fixed', async () => {
      const { owner } = await team();
      const rice = await product(owner, 'unit', 'ARR');
      const operationId = randomUUID();

      const refused = await call('POST', '/v1/purchases', owner, {
        operationId,
        lines: [line(rice), line(randomUUID())],
      });
      const fixed = await call('POST', '/v1/purchases', owner, {
        operationId,
        lines: [line(rice)],
      });

      expect(refused.status).toBe(400);
      expect(fixed.status).toBe(201);
      expect(await balanceOf(rice)).toBe(5000);
    });
  });

  describe('sending the same purchase again (ADR 0019)', () => {
    it('answers 200 with the same purchase and the Idempotent-Replayed header, and adds nothing', async () => {
      const { owner } = await team();
      const rice = await product(owner, 'unit', 'ARR');
      const request = { operationId: randomUUID(), note: 'x', lines: [line(rice, 5000)] };
      const first = await call('POST', '/v1/purchases', owner, request);

      const again = await call('POST', '/v1/purchases', owner, request);

      expect(first.status).toBe(201);
      expect(again.status).toBe(200);
      expect(again.headers.get('idempotent-replayed')).toBe('true');
      expect(again.body).toEqual(first.body);
      expect(await balanceOf(rice)).toBe(5000);
      expect(await select(admin, 'SELECT 1 FROM purchase')).toHaveLength(1);
      expect(await select(admin, 'SELECT 1 FROM stock_movement')).toHaveLength(1);
    });

    it('recognizes it written another way and sent by another person of the business', async () => {
      const { owner, admin: manager } = await team();
      const rice = await product(owner, 'unit', 'ARR');
      const operationId = randomUUID();
      await call('POST', '/v1/purchases', owner, { operationId, lines: [line(rice)] });

      const again = await call('POST', '/v1/purchases', manager, {
        lines: [{ unitCost: 2500, productId: rice.toUpperCase(), quantityMilli: 5000 }],
        operationId: operationId.toUpperCase(),
        note: null,
      });

      expect(again.status).toBe(200);
      expect(again.headers.get('idempotent-replayed')).toBe('true');
      expect(await balanceOf(rice)).toBe(5000);
    });

    it('answers 409 operation-id-reused when the same id comes with other data', async () => {
      const { owner } = await team();
      const rice = await product(owner, 'unit', 'ARR');
      const operationId = randomUUID();
      await call('POST', '/v1/purchases', owner, { operationId, lines: [line(rice, 5000)] });

      const other = await call('POST', '/v1/purchases', owner, {
        operationId,
        lines: [line(rice, 6000)],
      });

      expect(other.status).toBe(409);
      expect(other.body.code).toBe('operation-id-reused');
      expect(await balanceOf(rice)).toBe(5000);
    });

    it('keeps the operation ids of two businesses apart', async () => {
      const first = await team();
      const second = await team();
      const riceA = await product(first.owner, 'unit', 'ARR');
      const riceB = await product(second.owner, 'unit', 'ARR');
      const operationId = randomUUID();

      const a = await call('POST', '/v1/purchases', first.owner, {
        operationId,
        lines: [line(riceA, 1000)],
      });
      const b = await call('POST', '/v1/purchases', second.owner, {
        operationId,
        lines: [line(riceB, 2000)],
      });

      expect([a.status, b.status]).toEqual([201, 201]);
      expect(await balanceOf(riceA)).toBe(1000);
      expect(await balanceOf(riceB)).toBe(2000);
    });
  });

  describe('many purchases at the same time (ADR 0013)', () => {
    it('does not lose a single sum when many purchases of the same product arrive together', async () => {
      const { owner } = await team();
      const rice = await product(owner, 'unit', 'ARR');
      const quantities = Array.from({ length: 12 }, (_, i) => (i + 1) * 1000);

      const replies = await Promise.all(
        quantities.map((quantity) =>
          call('POST', '/v1/purchases', owner, {
            operationId: randomUUID(),
            lines: [line(rice, quantity)],
          }),
        ),
      );

      expect(replies.map((r) => r.status)).toEqual(quantities.map(() => 201));
      expect(await balanceOf(rice)).toBe(quantities.reduce((sum, q) => sum + q, 0));
      expect(await select(admin, 'SELECT 1 FROM stock_movement')).toHaveLength(12);
    });

    it('does not deadlock when purchases name the same products in opposite order', async () => {
      const { owner } = await team();
      const a = await product(owner, 'unit', 'AAA');
      const b = await product(owner, 'unit', 'BBB');
      const c = await product(owner, 'unit', 'CCC');

      const replies = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          call('POST', '/v1/purchases', owner, {
            operationId: randomUUID(),
            lines: (i % 2 === 0 ? [a, b, c] : [c, b, a]).map((id) => line(id, 1000)),
          }),
        ),
      );

      expect(replies.map((r) => r.status)).toEqual(Array.from({ length: 12 }, () => 201));
      for (const id of [a, b, c]) expect(await balanceOf(id)).toBe(12_000);
    });

    it('applies a purchase sent several times at once exactly one time', async () => {
      const { owner } = await team();
      const rice = await product(owner, 'unit', 'ARR');
      const request = { operationId: randomUUID(), lines: [line(rice, 5000)] };

      const replies = await Promise.all(
        Array.from({ length: 6 }, () => call('POST', '/v1/purchases', owner, request)),
      );

      const statuses = replies.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 200, 200, 200, 200, 201]);
      expect(new Set(replies.map((r) => r.body.id)).size).toBe(1);
      for (const reply of replies.filter((r) => r.status === 200)) {
        expect(reply.headers.get('idempotent-replayed')).toBe('true');
      }
      expect(await balanceOf(rice)).toBe(5000);
      expect(await select(admin, 'SELECT 1 FROM purchase')).toHaveLength(1);
    });

    it('keeps every balance equal to the sum of its movements', async () => {
      const { owner } = await team();
      const products = [
        await product(owner, 'unit', 'AAA'),
        await product(owner, 'kilogram', 'BBB'),
      ];

      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          call('POST', '/v1/purchases', owner, {
            operationId: randomUUID(),
            lines: products.map((id, k) => line(id, (i + 1) * 1000 + k * 1000)),
          }),
        ),
      );

      const drift = await select(
        admin,
        `SELECT b.product_id FROM stock_balance b
          WHERE b.quantity <> (SELECT coalesce(sum(m.delta), 0) FROM stock_movement m
                                WHERE m.id_negocio = b.id_negocio AND m.warehouse_id = b.warehouse_id
                                  AND m.product_id = b.product_id)`,
      );
      expect(drift).toEqual([]);
    });
  });

  describe('looking at purchases', () => {
    it('lists them newest first and hands one back with its lines', async () => {
      const { owner, admin: manager } = await team();
      const rice = await product(owner, 'unit', 'ARR');
      const sugar = await product(owner, 'kilogram', 'AZU');
      const first = await call('POST', '/v1/purchases', owner, {
        operationId: randomUUID(),
        note: 'primera',
        lines: [line(rice)],
      });
      const second = await call('POST', '/v1/purchases', owner, {
        operationId: randomUUID(),
        note: 'segunda',
        lines: [line(rice), line(sugar, 1500, 9)],
      });

      const page = await call('GET', '/v1/purchases', manager);
      const detail = await call('GET', `/v1/purchases/${second.body.id}`, manager);

      expect(page.status).toBe(200);
      expect(page.body.items.map((p) => [p.id, p.lineCount])).toEqual([
        [second.body.id, 2],
        [first.body.id, 1],
      ]);
      expect(page.body.items[0]).not.toHaveProperty('lines');
      expect(page.body.nextCursor).toBeNull();
      expect(detail.body).toEqual(second.body);
      expect(detail.body.lines).toHaveLength(2);
    });

    it('walks the list in pages by following the cursor, without repeating or skipping', async () => {
      const { owner } = await team();
      const rice = await product(owner, 'unit', 'ARR');
      const made: string[] = [];
      for (let n = 0; n < 5; n += 1) {
        made.push(
          (
            await call('POST', '/v1/purchases', owner, {
              operationId: randomUUID(),
              lines: [line(rice, 1000)],
            })
          ).body.id,
        );
      }

      const walked: string[] = [];
      let query = '?limit=2';
      for (;;) {
        const page = await call('GET', `/v1/purchases${query}`, owner);
        walked.push(...page.body.items.map((p) => p.id));
        if (page.body.nextCursor === null) break;
        query = `?limit=2&cursor=${encodeURIComponent(page.body.nextCursor)}`;
      }

      expect(walked).toEqual([...made].reverse());
    });

    it('refuses a cursor it did not make', async () => {
      const { owner } = await team();

      const reply = await call('GET', '/v1/purchases?cursor=basura', owner);

      expect(reply.status).toBe(400);
      expect(reply.body.errors.map((e) => `${e.pointer}:${e.code}`)).toEqual([
        '/cursor:invalid-cursor',
      ]);
    });

    it('says 404 for a purchase that does not exist, is of another business or is not an id', async () => {
      const mine = await team();
      const other = await team();
      const rice = await product(other.owner, 'unit', 'ARR');
      const foreign = await call('POST', '/v1/purchases', other.owner, {
        operationId: randomUUID(),
        lines: [line(rice)],
      });

      for (const id of [randomUUID(), foreign.body.id, 'no-es-uuid']) {
        const reply = await call('GET', `/v1/purchases/${id}`, mine.owner);
        expect(reply.status).toBe(404);
        expect(reply.body.code).toBe('purchase-not-found');
      }
      expect((await call('GET', '/v1/purchases', mine.owner)).body.items).toEqual([]);
    });

    it('is for the management', async () => {
      const { cashier } = await team();

      for (const path of ['/v1/purchases', `/v1/purchases/${randomUUID()}`]) {
        const reply = await call('GET', path, cashier);
        expect(reply.status).toBe(403);
        expect(reply.body.code).toBe('forbidden');
      }
    });
  });
});
