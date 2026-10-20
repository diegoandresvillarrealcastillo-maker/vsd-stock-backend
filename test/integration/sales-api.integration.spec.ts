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

interface ReviewBody {
  reviewedAt: string;
  reviewedByUserId: string;
  note: string | null;
}

interface SaleBody {
  id: string;
  operationId: string;
  shiftId: string;
  deviceId: string | null;
  userId: string;
  folio: string;
  folioReported: string;
  folioConflict: boolean;
  total: number;
  needsAdjustment: boolean;
  flags: string[];
  timeFlags: string[];
  occurredAt: string;
  receivedAt: string;
  lines: {
    productId: string;
    quantityMilli: number;
    unitPrice: number;
    discount: number;
    taxRateBp: number;
  }[];
  payments: { method: string; amount: number; reference: string | null }[];
  summary: {
    total: number;
    base: number;
    tax: number;
    byRate: { rateBp: number; total: number; base: number; tax: number }[];
  };
  attention: boolean;
  review: ReviewBody | null;
}

interface Body extends SaleBody {
  items: SaleBody[];
  nextCursor: string | null;
  saleId: string;
  reviewedAt: string;
  reviewedByUserId: string;
  note: string | null;
  code: string;
  errors: { pointer: string; code: string; detail: string }[];
  businessId: string;
  invitation: { code: string };
  summary: SaleBody['summary'] & {
    cashSales: number;
    expectedAmount: number;
    lateSales: { count: number; cashAmount: number };
  };
}

interface Reply {
  status: number;
  headers: Headers;
  body: Body;
}

/**
 * De punta a punta (C3-03): un token firmado, la API real y la base real. Vender con el rol de cada persona, el total que el
 * servidor calcula otra vez, la existencia que baja, lo que se acepta marcado, el efectivo que llega al arqueo y la
 * idempotencia.
 */
describe('sales, end to end (C3-03)', () => {
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

  /** Un negocio con su dueno, un administrador y un cajero, un dispositivo (que recibe el codigo `AA`) y dos productos. */
  const team = async () => {
    const owner = await newcomer();
    const opened = await call('POST', '/v1/businesses', owner, {
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
    const product = async (sku: string, unit: string, unitPrice: number, taxRateBp: number) =>
      (
        await call('POST', '/v1/products', owner, {
          name: sku,
          sku,
          unit,
          unitPrice,
          taxRateBp,
        })
      ).body.id;
    return {
      businessId: opened.body.businessId,
      owner,
      admin: await hire('admin'),
      cashier: await hire('cashier'),
      deviceId,
      cola: await product('COLA', 'unit', 3500, 1900),
      bread: await product('PAN', 'kilogram', 4000, 0),
    };
  };
  type Team = Awaited<ReturnType<typeof team>>;

  const openShift = async (t: Team, token: string, change: Record<string, unknown> = {}) => {
    const shiftId = randomUUID();
    const reply = await call('POST', '/v1/shifts', token, {
      operationId: randomUUID(),
      shiftId,
      deviceId: t.deviceId,
      openingAmount: 50_000,
      deviceTime: new Date().toISOString(),
      clockOffsetMs: 0,
      ...change,
    });
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    return shiftId;
  };

  let serial = 0;
  /** 2 gaseosas (7.000) y 1,5 kg de pan (6.000): 13.000, pagados con 10.000 en efectivo y 3.000 con tarjeta. */
  const sale = (t: Team, shiftId: string, change: Record<string, unknown> = {}) => {
    serial += 1;
    return {
      operationId: randomUUID(),
      shiftId,
      folio: `AA-${String(serial).padStart(6, '0')}`,
      total: 13_000,
      lines: [
        { productId: t.cola, quantityMilli: 2_000, unitPrice: 3_500, discount: 0, taxRateBp: 1900 },
        { productId: t.bread, quantityMilli: 1_500, unitPrice: 4_000, discount: 0, taxRateBp: 0 },
      ],
      payments: [
        { method: 'cash', amount: 10_000 },
        { method: 'card', amount: 3_000, reference: 'aprobacion 77123' },
      ],
      deviceTime: new Date().toISOString(),
      clockOffsetMs: 0,
      ...change,
    };
  };

  const fields = (reply: Reply) => reply.body.errors.map((e) => `${e.pointer}:${e.code}`);

  describe('registering a sale', () => {
    it('registers it for any of the three roles: 201 with the sale, its lines, its payments and the tax split', async () => {
      const t = await team();

      for (const [role, token, userId] of [
        ['cashier', t.cashier.token, t.cashier.userId],
        ['admin', t.admin.token, t.admin.userId],
      ] as const) {
        const shiftId = await openShift(t, token);
        const body = sale(t, shiftId);

        const reply = await call('POST', '/v1/sales', token, body);

        expect(reply.status, `${role}: ${JSON.stringify(reply.body)}`).toBe(201);
        expect(reply.body).toMatchObject({
          operationId: body.operationId,
          shiftId,
          deviceId: t.deviceId,
          userId,
          folio: body.folio,
          folioReported: body.folio,
          folioConflict: false,
          total: 13_000,
          needsAdjustment: true,
          flags: [],
          lines: body.lines,
          payments: [
            { method: 'cash', amount: 10_000, reference: null },
            { method: 'card', amount: 3_000, reference: 'aprobacion 77123' },
          ],
          summary: {
            total: 13_000,
            base: 11_882,
            tax: 1_118,
            byRate: [
              { rateBp: 0, total: 6_000, base: 6_000, tax: 0 },
              { rateBp: 1900, total: 7_000, base: 5_882, tax: 1_118 },
            ],
          },
        });
        expect(reply.headers.get('idempotent-replayed')).toBeNull();
      }
    });

    it('answers every amount as a whole number of pesos', async () => {
      const t = await team();
      const shiftId = await openShift(t, t.cashier.token);

      const reply = await call('POST', '/v1/sales', t.cashier.token, sale(t, shiftId));

      const amounts = [
        reply.body.total,
        reply.body.summary.total,
        reply.body.summary.base,
        reply.body.summary.tax,
        ...reply.body.lines.flatMap((l) => [l.quantityMilli, l.unitPrice, l.discount]),
        ...reply.body.payments.map((p) => p.amount),
      ];
      expect(amounts.every((amount) => Number.isInteger(amount))).toBe(true);
    });

    it('takes the sold products out of the stock, and marks the sale when there was not enough', async () => {
      const t = await team();
      await call('POST', '/v1/stock-adjustments', t.owner, {
        operationId: randomUUID(),
        productId: t.cola,
        deltaMilli: 10_000,
        reason: 'Inventario inicial',
      });
      const shiftId = await openShift(t, t.cashier.token);

      const reply = await call('POST', '/v1/sales', t.cashier.token, sale(t, shiftId));

      expect(reply.body.needsAdjustment).toBe(true); // el pan no tenia existencia
      const balances = await select(
        admin,
        'SELECT product_id, quantity::int AS quantity FROM stock_balance ORDER BY quantity',
      );
      expect(balances).toEqual(
        expect.arrayContaining([
          { product_id: t.cola, quantity: 8_000 },
          { product_id: t.bread, quantity: -1_500 },
        ]),
      );
    });

    it('does not mark a sale of what there was', async () => {
      const t = await team();
      for (const productId of [t.cola, t.bread]) {
        await call('POST', '/v1/stock-adjustments', t.owner, {
          operationId: randomUUID(),
          productId,
          deltaMilli: 10_000,
          reason: 'Inventario inicial',
        });
      }
      const shiftId = await openShift(t, t.cashier.token);

      const reply = await call('POST', '/v1/sales', t.cashier.token, sale(t, shiftId));

      expect(reply.body.needsAdjustment).toBe(false);
    });

    it('keeps the time the device gave, corrected with the difference measured against the server', async () => {
      const t = await team();
      const shiftId = await openShift(t, t.cashier.token);
      const body = sale(t, shiftId, {
        deviceTime: new Date(Date.now() - 60_000).toISOString(),
        clockOffsetMs: 5_000,
      });

      const reply = await call('POST', '/v1/sales', t.cashier.token, body);

      const occurred = new Date(reply.body.occurredAt).getTime();
      expect(Math.abs(occurred - (new Date(body.deviceTime).getTime() + 5_000))).toBeLessThan(1);
      // Lo que el servidor se entero es ahora; lo que ocurrio, hace un minuto: son dos horas distintas (ADR 0016).
      expect(new Date(reply.body.receivedAt).getTime() - occurred).toBeGreaterThan(50_000);
      const [row] = await select(
        admin,
        'SELECT device_id, device_time_raw, time_source, kind FROM operation WHERE operation_id = $1',
        [body.operationId],
      );
      expect(row).toMatchObject({
        device_id: t.deviceId,
        device_time_raw: body.deviceTime,
        time_source: 'corrected',
        kind: 'sale',
      });
    });

    it('accepts a time it can not read and flags it, because the sale already happened at the counter', async () => {
      const t = await team();
      const shiftId = await openShift(t, t.cashier.token);

      const reply = await call(
        'POST',
        '/v1/sales',
        t.cashier.token,
        sale(t, shiftId, { deviceTime: 'ayer por la tarde', clockOffsetMs: null }),
      );

      expect(reply.status).toBe(201);
      expect(reply.body.timeFlags).toEqual(['unreadable']);
    });
  });

  describe('what it accepts and marks', () => {
    it('a price that is not the one of the catalog: it keeps the sold price and says so', async () => {
      const t = await team();
      const shiftId = await openShift(t, t.cashier.token);
      const cheaper = {
        productId: t.cola,
        quantityMilli: 2_000,
        unitPrice: 3_000,
        discount: 0,
        taxRateBp: 1900,
      };

      const reply = await call(
        'POST',
        '/v1/sales',
        t.cashier.token,
        sale(t, shiftId, {
          total: 6_000,
          lines: [cheaper],
          payments: [{ method: 'cash', amount: 6_000 }],
        }),
      );

      expect(reply.status).toBe(201);
      expect(reply.body.lines[0]?.unitPrice).toBe(3_000);
      expect(reply.body.total).toBe(6_000);
      expect(reply.body.flags).toEqual(['price-differs']);
    });

    it('a total that the device calculated differently, and payments that do not add up', async () => {
      const t = await team();
      const shiftId = await openShift(t, t.cashier.token);

      const reply = await call(
        'POST',
        '/v1/sales',
        t.cashier.token,
        sale(t, shiftId, { total: 12_999, payments: [{ method: 'cash', amount: 12_000 }] }),
      );

      expect(reply.body.total).toBe(13_000);
      expect(reply.body.flags).toEqual(['total-differs', 'payment-mismatch']);
    });

    it('a sale that arrives to a shift that was already closed, which shows apart in the cash count', async () => {
      const t = await team();
      const shiftId = await openShift(t, t.cashier.token, {
        deviceTime: new Date(Date.now() - 3_600_000).toISOString(),
      });
      const closed = await call('POST', `/v1/shifts/${shiftId}/close`, t.cashier.token, {
        operationId: randomUUID(),
        countedAmount: 50_000,
        deviceTime: new Date(Date.now() - 60_000).toISOString(),
        clockOffsetMs: 0,
      });
      expect(closed.status).toBe(200);

      const reply = await call('POST', '/v1/sales', t.cashier.token, sale(t, shiftId));

      expect(reply.status).toBe(201);
      expect(reply.body.flags).toEqual(['late-shift']);
      const shift = await call('GET', `/v1/shifts/${shiftId}`, t.cashier.token);
      expect(shift.body.summary).toMatchObject({
        cashSales: 0,
        expectedAmount: 50_000,
        lateSales: { count: 1, cashAmount: 10_000 },
      });
    });

    it('a device that was revoked before the sale', async () => {
      const t = await team();
      const shiftId = await openShift(t, t.cashier.token);
      const revoked = await call('POST', `/v1/devices/${t.deviceId}/revoke`, t.owner);
      expect(revoked.status).toBe(200);

      const reply = await call('POST', '/v1/sales', t.cashier.token, sale(t, shiftId));

      expect(reply.status).toBe(201);
      expect(reply.body.flags).toEqual(['revoked-device']);
    });

    it('a folio that is already another sale: both are kept, and the second is marked', async () => {
      const t = await team();
      const shiftId = await openShift(t, t.cashier.token);
      const first = await call(
        'POST',
        '/v1/sales',
        t.cashier.token,
        sale(t, shiftId, { folio: 'AA-000500' }),
      );

      const second = await call(
        'POST',
        '/v1/sales',
        t.cashier.token,
        sale(t, shiftId, { folio: 'AA-000500' }),
      );

      expect(first.body.folioConflict).toBe(false);
      expect(second.status).toBe(201);
      expect(second.body.folioConflict).toBe(true);
      expect(second.body.folioReported).toBe('AA-000500');
      expect(second.body.folio).toBe(`AA-000500~${second.body.operationId.slice(0, 8)}`);
    });

    it('a folio with the code of another device', async () => {
      const t = await team();
      const shiftId = await openShift(t, t.cashier.token);

      const reply = await call(
        'POST',
        '/v1/sales',
        t.cashier.token,
        sale(t, shiftId, { folio: 'AB-000001' }),
      );

      expect(reply.status).toBe(201);
      expect(reply.body.flags).toEqual(['folio-device']);
    });
  });

  describe('the cash count', () => {
    it('adds the cash of the sales to what the shift expects, and not the cards', async () => {
      const t = await team();
      const shiftId = await openShift(t, t.cashier.token);
      await call('POST', '/v1/sales', t.cashier.token, sale(t, shiftId));
      await call('POST', '/v1/sales', t.cashier.token, sale(t, shiftId));

      const shift = await call('GET', `/v1/shifts/${shiftId}`, t.cashier.token);

      expect(shift.body.summary).toMatchObject({ cashSales: 20_000, expectedAmount: 70_000 });
    });
  });

  describe('repeating the same operation', () => {
    it('answers 200 with the same sale and Idempotent-Replayed, selling nothing else', async () => {
      const t = await team();
      const shiftId = await openShift(t, t.cashier.token);
      const body = sale(t, shiftId);
      const first = await call('POST', '/v1/sales', t.cashier.token, body);

      const again = await call('POST', '/v1/sales', t.cashier.token, {
        ...body,
        clockOffsetMs: 300,
      });

      expect(again.status).toBe(200);
      expect(again.headers.get('idempotent-replayed')).toBe('true');
      expect(again.body).toEqual(first.body);
      expect(await select(admin, 'SELECT count(*)::int AS n FROM sale')).toEqual([{ n: 1 }]);
      expect(
        await select(admin, "SELECT count(*)::int AS n FROM stock_movement WHERE reason = 'sale'"),
      ).toEqual([{ n: 2 }]);
    });

    it('sells once when the same sale arrives six times at the same time', async () => {
      const t = await team();
      const shiftId = await openShift(t, t.cashier.token);
      const body = sale(t, shiftId);

      const replies = await Promise.all(
        Array.from({ length: 6 }, () => call('POST', '/v1/sales', t.cashier.token, body)),
      );

      expect(replies.filter((reply) => reply.status === 201)).toHaveLength(1);
      expect(replies.filter((reply) => reply.status === 200)).toHaveLength(5);
      expect(new Set(replies.map((reply) => reply.body.id)).size).toBe(1);
      expect(await select(admin, 'SELECT count(*)::int AS n FROM sale')).toEqual([{ n: 1 }]);
    });

    it('refuses the same operation with another sale: 409 operation-id-reused', async () => {
      const t = await team();
      const shiftId = await openShift(t, t.cashier.token);
      const body = sale(t, shiftId);
      await call('POST', '/v1/sales', t.cashier.token, body);

      const reply = await call('POST', '/v1/sales', t.cashier.token, { ...body, total: 1 });

      expect(reply.status).toBe(409);
      expect(reply.body.code).toBe('operation-id-reused');
    });
  });

  describe('what it refuses', () => {
    it('a shift that is not the one of the person who sells, or does not exist: 400 on /shiftId', async () => {
      const t = await team();
      const ownersShift = await openShift(t, t.owner);

      const reply = await call('POST', '/v1/sales', t.cashier.token, sale(t, ownersShift));
      const unknown = await call('POST', '/v1/sales', t.cashier.token, sale(t, randomUUID()));

      expect(reply.status).toBe(400);
      expect(fields(reply)).toEqual(['/shiftId:unknown-shift']);
      expect(unknown.status).toBe(400);
      expect(fields(unknown)).toEqual(['/shiftId:unknown-shift']);
      expect(await select(admin, 'SELECT count(*)::int AS n FROM sale')).toEqual([{ n: 0 }]);
    });

    it('a product the business does not have, and a quantity with decimals of a product sold by the unit', async () => {
      const t = await team();
      const shiftId = await openShift(t, t.cashier.token);
      const stranger = {
        productId: randomUUID(),
        quantityMilli: 1_000,
        unitPrice: 1,
        discount: 0,
        taxRateBp: 0,
      };
      const half = {
        productId: t.cola,
        quantityMilli: 1_500,
        unitPrice: 3_500,
        discount: 0,
        taxRateBp: 1900,
      };

      const reply = await call(
        'POST',
        '/v1/sales',
        t.cashier.token,
        sale(t, shiftId, { lines: [stranger, half] }),
      );

      expect(reply.status).toBe(400);
      expect(reply.body.code).toBe('validation-failed');
      expect(fields(reply)).toEqual([
        '/lines/0/productId:unknown-product',
        '/lines/1/quantityMilli:not-whole',
      ]);
      expect(
        await select(admin, "SELECT count(*)::int AS n FROM operation WHERE kind = 'sale'"),
      ).toEqual([{ n: 0 }]);
    });

    it('a body that is not a sale, saying every problem at once', async () => {
      const t = await team();
      const shiftId = await openShift(t, t.cashier.token);

      const reply = await call('POST', '/v1/sales', t.cashier.token, {
        operationId: 'no-es-un-uuid',
        shiftId,
        folio: 'sin guion',
        total: -5,
        lines: [],
        payments: [{ method: 'cheque', amount: 0 }],
        deviceTime: new Date().toISOString(),
        extra: true,
      });

      expect(reply.status).toBe(400);
      expect(fields(reply)).toEqual([
        '/extra:unknown-field',
        '/operationId:invalid-id',
        '/folio:invalid-folio',
        '/total:out-of-range',
        '/lines:too-few',
        '/payments/0/method:invalid-value',
        '/payments/0/amount:out-of-range',
      ]);
    });

    it('a request without a session, and someone who was let go', async () => {
      const t = await team();
      const shiftId = await openShift(t, t.cashier.token);
      const body = sale(t, shiftId);

      const anonymous = await call('POST', '/v1/sales', undefined, body);
      await call('PATCH', `/v1/users/${t.cashier.userId}`, t.owner, { active: false });
      const dismissed = await call('POST', '/v1/sales', t.cashier.token, body);

      expect(anonymous.status).toBe(401);
      expect(dismissed.status).toBe(403);
      expect(dismissed.body.code).toBe('user-inactive');
    });
  });

  describe('reading and reviewing sales (C3-04)', () => {
    /** El equipo de siempre, con existencia de sobra: así una venta normal no queda marcada. */
    const stockedTeam = async () => {
      const t = await team();
      for (const productId of [t.cola, t.bread]) {
        await call('POST', '/v1/stock-adjustments', t.owner, {
          operationId: randomUUID(),
          productId,
          deltaMilli: 100_000,
          reason: 'Inventario inicial',
        });
      }
      return t;
    };

    /** Registra una venta y devuelve su identificador. */
    const register = async (
      t: Team,
      token: string,
      shiftId: string,
      change: Record<string, unknown> = {},
    ) => {
      const reply = await call('POST', '/v1/sales', token, sale(t, shiftId, change));
      expect(reply.status, JSON.stringify(reply.body)).toBe(201);
      return reply.body;
    };

    /** Lo normal en un mostrador: nada raro. */
    const plain = (t: Team, token: string, shiftId: string, change: Record<string, unknown> = {}) =>
      register(t, token, shiftId, change);

    /** Una venta que el servidor acepta pero marca: el total que trajo no es el de sus lineas. */
    const odd = (t: Team, token: string, shiftId: string, change: Record<string, unknown> = {}) =>
      register(t, token, shiftId, { total: 1, ...change });

    describe('the list', () => {
      it('gives the management every sale, newest first, without lines or payments, saying which ones ask for attention', async () => {
        const t = await stockedTeam();
        const mine = await openShift(t, t.cashier.token);
        const first = await plain(t, t.cashier.token, mine);
        const second = await odd(t, t.cashier.token, mine);

        const reply = await call('GET', '/v1/sales', t.owner);

        expect(reply.status).toBe(200);
        expect(reply.body.nextCursor).toBeNull();
        expect(reply.body.items.map((item) => item.id)).toEqual([second.id, first.id]);
        expect(reply.body.items.map((item) => item.attention)).toEqual([true, false]);
        expect(reply.body.items[0]).toMatchObject({
          shiftId: mine,
          folio: second.folio,
          total: 13_000,
          flags: ['total-differs'],
          review: null,
        });
        expect(reply.body.items[0]).not.toHaveProperty('lines');
        expect(reply.body.items[0]).not.toHaveProperty('payments');
        expect(reply.body.items[0]).not.toHaveProperty('summary');
      });

      it('gives a cashier only the sales of his own shifts', async () => {
        const t = await stockedTeam();
        const cashierShift = await openShift(t, t.cashier.token);
        const adminShift = await openShift(t, t.admin.token);
        const ofCashier = await plain(t, t.cashier.token, cashierShift);
        const ofAdmin = await plain(t, t.admin.token, adminShift);

        const asCashier = await call('GET', '/v1/sales', t.cashier.token);
        const asAdmin = await call('GET', '/v1/sales', t.admin.token);

        expect(asCashier.status).toBe(200);
        expect(asCashier.body.items.map((item) => item.id)).toEqual([ofCashier.id]);
        expect(asAdmin.body.items.map((item) => item.id)).toEqual([ofAdmin.id, ofCashier.id]);
      });

      it('pages with a cursor, and rejects one that is not a cursor', async () => {
        const t = await stockedTeam();
        const shiftId = await openShift(t, t.cashier.token);
        const ids = [
          (await plain(t, t.cashier.token, shiftId)).id,
          (await plain(t, t.cashier.token, shiftId)).id,
          (await plain(t, t.cashier.token, shiftId)).id,
        ];

        const one = await call('GET', '/v1/sales?limit=2', t.owner);
        const two = await call(
          'GET',
          `/v1/sales?limit=2&cursor=${encodeURIComponent(one.body.nextCursor!)}`,
          t.owner,
        );
        const bad = await call('GET', '/v1/sales?cursor=no-es-un-cursor', t.owner);

        expect(one.body.items).toHaveLength(2);
        expect(one.body.nextCursor).not.toBeNull();
        expect(two.body.items).toHaveLength(1);
        expect(two.body.nextCursor).toBeNull();
        expect([...one.body.items, ...two.body.items].map((item) => item.id).sort()).toEqual(
          [...ids].sort(),
        );
        expect(bad.status).toBe(400);
        expect(fields(bad)).toEqual(['/cursor:invalid-cursor']);
      });

      it('filters by shift, by folio, and by the tray «Requiere atención»', async () => {
        const t = await stockedTeam();
        const cashierShift = await openShift(t, t.cashier.token);
        const adminShift = await openShift(t, t.admin.token);
        const fine = await plain(t, t.cashier.token, cashierShift, { folio: 'AA-000500' });
        const marked = await odd(t, t.admin.token, adminShift, { folio: 'AA-000501' });
        const ids = (reply: Reply) => reply.body.items.map((item) => item.id);

        expect(ids(await call('GET', `/v1/sales?shiftId=${adminShift}`, t.owner))).toEqual([
          marked.id,
        ]);
        expect(ids(await call('GET', '/v1/sales?folio=AA-000500', t.owner))).toEqual([fine.id]);
        expect(ids(await call('GET', '/v1/sales?attention=true', t.owner))).toEqual([marked.id]);
        expect(ids(await call('GET', '/v1/sales?attention=false', t.owner))).toEqual([fine.id]);
        expect(
          ids(await call('GET', `/v1/sales?attention=true&shiftId=${cashierShift}`, t.owner)),
        ).toEqual([]);
      });

      it('keeps the tray for the management: a cashier who asks for it is told no', async () => {
        const t = await stockedTeam();
        const shiftId = await openShift(t, t.cashier.token);
        await odd(t, t.cashier.token, shiftId);

        const asking = await call('GET', '/v1/sales?attention=true', t.cashier.token);
        const other = await call('GET', '/v1/sales?attention=false', t.cashier.token);

        expect(asking.status).toBe(403);
        expect(asking.body.code).toBe('forbidden');
        expect(other.status).toBe(403);
      });

      it('rejects a filter that is not one, saying every problem at once', async () => {
        const t = await stockedTeam();

        const reply = await call(
          'GET',
          '/v1/sales?shiftId=no&attention=quizas&folio=sin-guion&extra=1&limit=0',
          t.owner,
        );

        expect(reply.status).toBe(400);
        expect(fields(reply)).toEqual([
          '/extra:unknown-field',
          '/limit:out-of-range',
          '/shiftId:invalid-id',
          '/attention:invalid-value',
          '/folio:invalid-folio',
        ]);
      });

      it('wants a session', async () => {
        const anonymous = await call('GET', '/v1/sales');

        expect(anonymous.status).toBe(401);
      });
    });

    describe('one sale', () => {
      it('gives the whole sale: lines, payments, the tax split, the marks and no review yet', async () => {
        const t = await stockedTeam();
        const shiftId = await openShift(t, t.cashier.token);
        const registered = await odd(t, t.cashier.token, shiftId);

        const reply = await call('GET', `/v1/sales/${registered.id}`, t.owner);

        expect(reply.status).toBe(200);
        expect(reply.body).toEqual(registered);
        expect(reply.body.attention).toBe(true);
        expect(reply.body.review).toBeNull();
        expect(reply.body.lines).toHaveLength(2);
        expect(reply.body.payments).toHaveLength(2);
        expect(reply.body.summary.total).toBe(13_000);
      });

      it('hides the sale of another shift from a cashier, exactly as if it did not exist', async () => {
        const t = await stockedTeam();
        const cashierShift = await openShift(t, t.cashier.token);
        const adminShift = await openShift(t, t.admin.token);
        const ofCashier = await plain(t, t.cashier.token, cashierShift);
        const ofAdmin = await plain(t, t.admin.token, adminShift);

        const own = await call('GET', `/v1/sales/${ofCashier.id}`, t.cashier.token);
        const foreign = await call('GET', `/v1/sales/${ofAdmin.id}`, t.cashier.token);
        const missing = await call('GET', `/v1/sales/${randomUUID()}`, t.cashier.token);
        const notAnId = await call('GET', '/v1/sales/no-es-un-uuid', t.cashier.token);

        expect(own.status).toBe(200);
        for (const reply of [foreign, missing, notAnId]) {
          expect(reply.status).toBe(404);
          expect(reply.body.code).toBe('sale-not-found');
        }
        // Lo único que cambia es lo que identifica la petición: de la respuesta no se deduce que la venta existe.
        const {
          instance: _a,
          traceId: _b,
          ...ofForeign
        } = foreign.body as unknown as Record<string, unknown>;
        const {
          instance: _c,
          traceId: _d,
          ...ofMissing
        } = missing.body as unknown as Record<string, unknown>;
        expect(ofForeign).toEqual(ofMissing);
      });

      it('is not there for another business', async () => {
        const t = await stockedTeam();
        const other = await team();
        const shiftId = await openShift(t, t.cashier.token);
        const registered = await plain(t, t.cashier.token, shiftId);

        const reply = await call('GET', `/v1/sales/${registered.id}`, other.owner);

        expect(reply.status).toBe(404);
        expect(reply.body.code).toBe('sale-not-found');
      });
    });

    describe('reviewing', () => {
      it('takes the sale out of the tray without changing it, and says who and when', async () => {
        const t = await stockedTeam();
        const shiftId = await openShift(t, t.cashier.token);
        const registered = await odd(t, t.cashier.token, shiftId);

        const reply = await call('POST', `/v1/sales/${registered.id}/review`, t.owner, {
          note: 'Se corrigió el total',
        });

        expect(reply.status).toBe(201);
        expect(reply.headers.get('Idempotent-Replayed')).toBeNull();
        expect(reply.body).toMatchObject({
          saleId: registered.id,
          reviewedByUserId: expect.any(String),
          note: 'Se corrigió el total',
        });
        expect(Date.parse(reply.body.reviewedAt)).not.toBeNaN();
        const tray = await call('GET', '/v1/sales?attention=true', t.owner);
        const after = await call('GET', `/v1/sales/${registered.id}`, t.owner);
        expect(tray.body.items).toEqual([]);
        expect(after.body).toEqual({
          ...registered,
          attention: false,
          review: {
            reviewedAt: reply.body.reviewedAt,
            reviewedByUserId: reply.body.reviewedByUserId,
            note: 'Se corrigió el total',
          },
        });
        expect(after.body.flags).toEqual(['total-differs']);
        expect(
          await select(admin, 'SELECT flags FROM sale WHERE id = $1', [registered.id]),
        ).toEqual([{ flags: ['total-differs'] }]);
      });

      it('answers with the identifier of the sale in lowercase, however it was written in the path', async () => {
        const t = await stockedTeam();
        const shiftId = await openShift(t, t.cashier.token);
        const registered = await odd(t, t.cashier.token, shiftId);

        const reply = await call(
          'POST',
          `/v1/sales/${registered.id.toUpperCase()}/review`,
          t.owner,
          {},
        );

        expect(reply.status).toBe(201);
        expect(reply.body.saleId).toBe(registered.id);
      });

      it('is idempotent: the second time gives back the first review with 200 and Idempotent-Replayed', async () => {
        const t = await stockedTeam();
        const shiftId = await openShift(t, t.cashier.token);
        const registered = await odd(t, t.cashier.token, shiftId);

        const first = await call('POST', `/v1/sales/${registered.id}/review`, t.owner, {
          note: 'Primera',
        });
        const again = await call('POST', `/v1/sales/${registered.id}/review`, t.admin.token, {
          note: 'Segunda',
        });

        expect(first.status).toBe(201);
        expect(again.status).toBe(200);
        expect(again.headers.get('Idempotent-Replayed')).toBe('true');
        expect(again.body).toEqual(first.body);
        expect(await select(admin, 'SELECT count(*)::int AS n FROM sale_review')).toEqual([
          { n: 1 },
        ]);
      });

      it('can be done without a note, with an empty body', async () => {
        const t = await stockedTeam();
        const shiftId = await openShift(t, t.cashier.token);
        const registered = await odd(t, t.cashier.token, shiftId);

        const reply = await call('POST', `/v1/sales/${registered.id}/review`, t.admin.token, {});

        expect(reply.status).toBe(201);
        expect(reply.body.note).toBeNull();
      });

      it('also takes a sale that was not in the tray: reviewing is the management saying it looked', async () => {
        const t = await stockedTeam();
        const shiftId = await openShift(t, t.cashier.token);
        const registered = await plain(t, t.cashier.token, shiftId);

        const reply = await call('POST', `/v1/sales/${registered.id}/review`, t.owner, {});

        expect(reply.status).toBe(201);
      });

      it('is for the management only', async () => {
        const t = await stockedTeam();
        const shiftId = await openShift(t, t.cashier.token);
        const registered = await odd(t, t.cashier.token, shiftId);

        const byCashier = await call(
          'POST',
          `/v1/sales/${registered.id}/review`,
          t.cashier.token,
          {},
        );
        const anonymous = await call('POST', `/v1/sales/${registered.id}/review`, undefined, {});

        expect(byCashier.status).toBe(403);
        expect(byCashier.body.code).toBe('forbidden');
        expect(anonymous.status).toBe(401);
        expect(await select(admin, 'SELECT count(*)::int AS n FROM sale_review')).toEqual([
          { n: 0 },
        ]);
      });

      it('does not exist for a sale that is not there, or is of another business', async () => {
        const t = await stockedTeam();
        const other = await team();
        const shiftId = await openShift(t, t.cashier.token);
        const registered = await odd(t, t.cashier.token, shiftId);

        const missing = await call('POST', `/v1/sales/${randomUUID()}/review`, t.owner, {});
        const notAnId = await call('POST', '/v1/sales/no-es-un-uuid/review', t.owner, {});
        const foreign = await call('POST', `/v1/sales/${registered.id}/review`, other.owner, {});

        for (const reply of [missing, notAnId, foreign]) {
          expect(reply.status).toBe(404);
          expect(reply.body.code).toBe('sale-not-found');
        }
      });

      it('rejects a note that is too long, has a line break, or comes with other fields', async () => {
        const t = await stockedTeam();
        const shiftId = await openShift(t, t.cashier.token);
        const registered = await odd(t, t.cashier.token, shiftId);
        const review = (body: unknown) =>
          call('POST', `/v1/sales/${registered.id}/review`, t.owner, body);

        const long = await review({ note: 'x'.repeat(201) });
        const lines = await review({ note: 'uno\ndos' });
        const extra = await review({ note: 'bien', otra: 1 });
        const notText = await review({ note: 5 });
        const limit = await review({ note: 'x'.repeat(200) });

        for (const reply of [long, lines, extra, notText]) expect(reply.status).toBe(400);
        expect(fields(long)).toEqual(['/note:too-long']);
        expect(fields(extra)).toEqual(['/otra:unknown-field']);
        expect(limit.status).toBe(201);
        expect(await select(admin, 'SELECT count(*)::int AS n FROM sale_review')).toEqual([
          { n: 1 },
        ]);
      });
    });
  });
});
