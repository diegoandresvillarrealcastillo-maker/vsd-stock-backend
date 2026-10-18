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

interface ShiftBody {
  id: string;
  deviceId: string;
  userId: string;
  openedAt: string;
  closedAt: string | null;
  closedByUserId: string | null;
  openingAmount: number;
  countedAmount: number | null;
  summary: {
    openingAmount: number;
    cashSales: number;
    cashIn: number;
    cashOut: number;
    expectedAmount: number;
    countedAmount: number | null;
    difference: number | null;
    lateSales: { count: number; cashAmount: number };
  };
}

interface Body extends ShiftBody {
  code: string;
  errors: { pointer: string; code: string; detail: string }[];
  items: ShiftBody[];
  nextCursor: string | null;
  businessId: string;
  userId: string;
  invitation: { code: string };
  operationId: string;
  shiftId: string;
  direction: string;
  amount: number;
  reason: string;
}

interface Reply {
  status: number;
  headers: Headers;
  body: Body;
}

/**
 * De punta a punta (C3-02): un token firmado, la API real y la base real. Abrir y cerrar turnos con el rol de cada persona,
 * el arqueo que suma lo que hay en la base, el efectivo que entra y sale, la hora que el servidor guarda y la idempotencia.
 */
describe('shifts and cash, end to end (C3-02)', () => {
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

  /** Un negocio abierto por la API, con su dueno, un administrador y un cajero, y un dispositivo registrado. */
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
    return {
      businessId: opened.body.businessId,
      ownerUserId: opened.body.userId,
      owner,
      admin: await hire('admin'),
      cashier: await hire('cashier'),
      deviceId,
    };
  };

  const NOW = () => new Date().toISOString();

  const opening = (deviceId: string, change: Record<string, unknown> = {}) => ({
    operationId: randomUUID(),
    shiftId: randomUUID(),
    deviceId,
    openingAmount: 50_000,
    deviceTime: NOW(),
    clockOffsetMs: 0,
    ...change,
  });

  const closing = (change: Record<string, unknown> = {}) => ({
    operationId: randomUUID(),
    countedAmount: 175_000,
    deviceTime: NOW(),
    clockOffsetMs: 0,
    ...change,
  });

  describe('opening a shift', () => {
    it('opens it for the person who asks: 201 with the shift and its count, for any of the three roles', async () => {
      const t = await team();
      const body = opening(t.deviceId);

      const reply = await call('POST', '/v1/shifts', t.cashier.token, body);

      expect(reply.status, JSON.stringify(reply.body)).toBe(201);
      expect(reply.body).toMatchObject({
        id: body.shiftId,
        deviceId: t.deviceId,
        userId: t.cashier.userId,
        openingAmount: 50_000,
        closedAt: null,
        closedByUserId: null,
        countedAmount: null,
        summary: {
          expectedAmount: 50_000,
          cashSales: 0,
          cashIn: 0,
          cashOut: 0,
          countedAmount: null,
          difference: null,
          lateSales: { count: 0, cashAmount: 0 },
        },
      });
      expect(reply.headers.get('idempotent-replayed')).toBeNull();
      expect((await call('POST', '/v1/shifts', t.owner, opening(t.deviceId))).status).toBe(201);
      expect((await call('POST', '/v1/shifts', t.admin.token, opening(t.deviceId))).status).toBe(
        201,
      );
    });

    it('keeps the time the device gave, corrected with the difference measured against the server', async () => {
      const t = await team();
      const body = opening(t.deviceId, {
        deviceTime: new Date(Date.now() - 60_000).toISOString(),
        clockOffsetMs: 5_000,
      });

      const reply = await call('POST', '/v1/shifts', t.cashier.token, body);

      const opened = new Date(reply.body.openedAt).getTime();
      expect(Math.abs(opened - (new Date(body.deviceTime).getTime() + 5_000))).toBeLessThan(1);
      const [row] = await select(
        admin,
        `SELECT device_id, device_time_raw, time_source, time_flags, kind FROM operation WHERE operation_id = $1`,
        [body.operationId],
      );
      expect(row).toMatchObject({
        device_id: t.deviceId,
        device_time_raw: body.deviceTime,
        time_source: 'corrected',
        time_flags: [],
        kind: 'shift_open',
      });
    });

    it('accepts a time it can not read and flags it, because the shift already opened at the counter', async () => {
      const t = await team();
      const body = opening(t.deviceId, { deviceTime: 'ayer por la tarde', clockOffsetMs: null });

      const reply = await call('POST', '/v1/shifts', t.cashier.token, body);

      expect(reply.status).toBe(201);
      const [row] = await select(
        admin,
        'SELECT time_source, time_flags FROM operation WHERE operation_id = $1',
        [body.operationId],
      );
      expect(row).toEqual({ time_source: 'received', time_flags: ['unreadable'] });
    });

    it('answers the same opening again with 200, the same shift and Idempotent-Replayed, opening nothing else', async () => {
      const t = await team();
      const body = opening(t.deviceId);
      const first = await call('POST', '/v1/shifts', t.cashier.token, body);

      const again = await call('POST', '/v1/shifts', t.cashier.token, {
        ...body,
        clockOffsetMs: 300,
      });

      expect(again.status).toBe(200);
      expect(again.headers.get('idempotent-replayed')).toBe('true');
      expect(again.body).toEqual(first.body);
      const rows = await select(admin, 'SELECT 1 FROM cash_shift WHERE id_negocio = $1', [
        t.businessId,
      ]);
      expect(rows).toHaveLength(1);
    });

    it('refuses the same operation with other data: 409 operation-id-reused', async () => {
      const t = await team();
      const body = opening(t.deviceId);
      await call('POST', '/v1/shifts', t.cashier.token, body);

      const reply = await call('POST', '/v1/shifts', t.cashier.token, {
        ...body,
        openingAmount: 1,
      });

      expect(reply.status).toBe(409);
      expect(reply.body.code).toBe('operation-id-reused');
    });

    it('does not let a person open two shifts on a device: 409 shift-already-open, and leaves nothing behind', async () => {
      const t = await team();
      await call('POST', '/v1/shifts', t.cashier.token, opening(t.deviceId));
      const second = opening(t.deviceId);

      const reply = await call('POST', '/v1/shifts', t.cashier.token, second);

      expect(reply.status).toBe(409);
      expect(reply.body.code).toBe('shift-already-open');
      // La operacion no se quedo reclamada: con el turno anterior cerrado se puede reenviar tal cual.
      const operations = await select(admin, 'SELECT 1 FROM operation WHERE operation_id = $1', [
        second.operationId,
      ]);
      expect(operations).toEqual([]);
    });

    it('does not reuse the id of another shift: 409 shift-id-reused', async () => {
      const t = await team();
      const first = opening(t.deviceId);
      await call('POST', '/v1/shifts', t.cashier.token, first);

      const reply = await call(
        'POST',
        '/v1/shifts',
        t.admin.token,
        opening(t.deviceId, { shiftId: first.shiftId }),
      );

      expect(reply.status).toBe(409);
      expect(reply.body.code).toBe('shift-id-reused');
    });

    it('says the device does not exist, with the field, for one that is not of this business', async () => {
      const t = await team();
      const other = await team();

      const reply = await call('POST', '/v1/shifts', t.cashier.token, opening(other.deviceId));

      expect(reply.status).toBe(400);
      expect(reply.body.errors.map((e) => `${e.pointer}:${e.code}`)).toEqual([
        '/deviceId:unknown-device',
      ]);
    });

    it('reports every problem of the body together, with its pointer', async () => {
      const t = await team();

      const reply = await call('POST', '/v1/shifts', t.cashier.token, {
        shiftId: 'turno',
        openingAmount: -5,
        clockOffsetMs: 1.5,
        extra: true,
      });

      expect(reply.status).toBe(400);
      expect(reply.body.code).toBe('validation-failed');
      expect(reply.body.errors.map((e) => `${e.pointer}:${e.code}`)).toEqual([
        '/extra:unknown-field',
        '/operationId:required',
        '/shiftId:invalid-id',
        '/deviceId:required',
        '/openingAmount:out-of-range',
        '/deviceTime:required',
        '/clockOffsetMs:invalid-type',
      ]);
    });
  });

  describe('closing a shift and the cash count', () => {
    const openOne = async (t: Awaited<ReturnType<typeof team>>, who: string = t.cashier.token) => {
      const body = opening(t.deviceId);
      const reply = await call('POST', '/v1/shifts', who, body);
      return { id: body.shiftId, reply };
    };

    /** Una venta ya hecha, escrita con la conexion de administracion (las ventas llegan en C3-03). */
    const sell = async (
      t: Awaited<ReturnType<typeof team>>,
      shiftId: string,
      payments: { method: 'cash' | 'card'; amount: number }[],
      occurredAt: string,
    ) => {
      const operationId = randomUUID();
      const saleId = randomUUID();
      await admin.query(
        `INSERT INTO operation (id_negocio, operation_id, kind, user_id, occurred_at)
         VALUES ($1, $2, 'sale', $3, $4)`,
        [t.businessId, operationId, t.ownerUserId, occurredAt],
      );
      await admin.query(
        `INSERT INTO sale (id, id_negocio, operation_id, shift_id, folio, folio_reported, total, needs_adjustment)
         VALUES ($1, $2, $3, $4, $5, $5, $6, false)`,
        [
          saleId,
          t.businessId,
          operationId,
          shiftId,
          `ZZ-${randomUUID().slice(0, 6)}`,
          payments.reduce((s, p) => s + p.amount, 0),
        ],
      );
      for (const payment of payments) {
        await admin.query(
          'INSERT INTO payment (id_negocio, sale_id, method, amount) VALUES ($1, $2, $3, $4)',
          [t.businessId, saleId, payment.method, payment.amount],
        );
      }
    };

    it('closes it with the cash counted, says who and when, and makes the count from what is in the database', async () => {
      const t = await team();
      const { id } = await openOne(t);
      await sell(t, id, [{ method: 'cash', amount: 100_000 }], new Date().toISOString());
      await sell(
        t,
        id,
        [
          { method: 'cash', amount: 20_000 },
          { method: 'card', amount: 30_000 },
        ],
        new Date().toISOString(),
      );
      await call('POST', '/v1/cash-movements', t.owner, {
        operationId: randomUUID(),
        shiftId: id,
        direction: 'out',
        amount: 5_000,
        reason: 'Pago al proveedor',
      });
      const body = closing({ countedAmount: 170_000 });

      const reply = await call('POST', `/v1/shifts/${id}/close`, t.cashier.token, body);

      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      expect(reply.body).toMatchObject({
        id,
        closedByUserId: t.cashier.userId,
        countedAmount: 170_000,
        summary: {
          openingAmount: 50_000,
          cashSales: 120_000,
          cashIn: 0,
          cashOut: 5_000,
          expectedAmount: 165_000,
          countedAmount: 170_000,
          difference: 5_000,
          lateSales: { count: 0, cashAmount: 0 },
        },
      });
      expect(reply.body.closedAt).toEqual(expect.any(String));
      expect(reply.headers.get('idempotent-replayed')).toBeNull();
    });

    it('lets the management close the shift of another person, and not a cashier', async () => {
      const t = await team();
      const { id } = await openOne(t, t.cashier.token);

      const byOtherCashier = await call('POST', `/v1/shifts/${id}/close`, t.owner, closing());
      expect(byOtherCashier.status).toBe(200);
      expect(byOtherCashier.body.closedByUserId).toBe(t.ownerUserId);
      expect(byOtherCashier.body.userId).toBe(t.cashier.userId);
    });

    it('does not let a cashier close the shift of someone else', async () => {
      const t = await team();
      const { id } = await openOne(t, t.owner);

      const reply = await call('POST', `/v1/shifts/${id}/close`, t.cashier.token, closing());

      expect(reply.status).toBe(403);
      expect(reply.body.code).toBe('forbidden');
      const [row] = await select(admin, 'SELECT closed_at FROM cash_shift WHERE id = $1', [id]);
      expect(row?.['closed_at']).toBeNull();
    });

    it('answers a repeated closing with 200 and Idempotent-Replayed, and a second closing with another operation with 409', async () => {
      const t = await team();
      const { id } = await openOne(t);
      const body = closing();
      const first = await call('POST', `/v1/shifts/${id}/close`, t.cashier.token, body);

      const again = await call('POST', `/v1/shifts/${id}/close`, t.cashier.token, body);
      const other = await call('POST', `/v1/shifts/${id}/close`, t.cashier.token, closing());
      const changed = await call('POST', `/v1/shifts/${id}/close`, t.cashier.token, {
        ...body,
        countedAmount: 1,
      });

      expect(again.status).toBe(200);
      expect(again.headers.get('idempotent-replayed')).toBe('true');
      expect(again.body).toEqual(first.body);
      expect(other.status).toBe(409);
      expect(other.body.code).toBe('shift-closed');
      expect(changed.status).toBe(409);
      expect(changed.body.code).toBe('operation-id-reused');
    });

    it('closes only once when the same closing arrives five times at once', async () => {
      const t = await team();
      const { id } = await openOne(t);
      const body = closing();

      const replies = await Promise.all(
        Array.from({ length: 5 }, () =>
          call('POST', `/v1/shifts/${id}/close`, t.cashier.token, body),
        ),
      );

      expect(replies.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200]);
      expect(replies.filter((r) => r.headers.get('idempotent-replayed') === 'true')).toHaveLength(
        4,
      );
      expect(new Set(replies.map((r) => r.body.closedAt)).size).toBe(1);
    });

    it('keeps the sales that arrive after closing apart, as late, and does not add them to what is expected', async () => {
      const t = await team();
      const { id } = await openOne(t);
      const closed = await call(
        'POST',
        `/v1/shifts/${id}/close`,
        t.cashier.token,
        closing({ countedAmount: 50_000 }),
      );
      const closedAt = new Date(closed.body.closedAt!);
      await sell(
        t,
        id,
        [{ method: 'cash', amount: 7_000 }],
        new Date(closedAt.getTime() + 60_000).toISOString(),
      );

      const reply = await call('GET', `/v1/shifts/${id}`, t.owner);

      expect(reply.body.summary).toMatchObject({
        cashSales: 0,
        expectedAmount: 50_000,
        difference: 0,
        lateSales: { count: 1, cashAmount: 7_000 },
      });
    });

    it('does not close before it opened, even if the clock of the device went back', async () => {
      const t = await team();
      const { id, reply: opened } = await openOne(t);

      const reply = await call(
        'POST',
        `/v1/shifts/${id}/close`,
        t.cashier.token,
        closing({ deviceTime: '2020-01-01T00:00:00.000Z', clockOffsetMs: 0 }),
      );

      expect(reply.status).toBe(200);
      expect(reply.body.closedAt).toBe(opened.body.openedAt);
    });

    it('says 404 shift-not-found for an unknown shift and for an id that is not a UUID', async () => {
      const t = await team();

      for (const path of [`/v1/shifts/${randomUUID()}/close`, '/v1/shifts/no-es-uuid/close']) {
        const reply = await call('POST', path, t.owner, closing());
        expect(reply.status, path).toBe(404);
        expect(reply.body.code, path).toBe('shift-not-found');
      }
    });

    it('reports every problem of the closing body, and does not take the shift from the body', async () => {
      const t = await team();
      const { id } = await openOne(t);

      const reply = await call('POST', `/v1/shifts/${id}/close`, t.cashier.token, {
        countedAmount: 'mucho',
        shiftId: id,
      });

      expect(reply.status).toBe(400);
      expect(reply.body.errors.map((e) => `${e.pointer}:${e.code}`)).toEqual([
        '/shiftId:unknown-field',
        '/operationId:required',
        '/countedAmount:invalid-type',
        '/deviceTime:required',
      ]);
    });
  });

  describe('moving cash outside a sale', () => {
    it('moves cash into an open shift: 201, and the count shows it', async () => {
      const t = await team();
      const shift = opening(t.deviceId);
      await call('POST', '/v1/shifts', t.cashier.token, shift);
      const body = {
        operationId: randomUUID(),
        shiftId: shift.shiftId,
        direction: 'in',
        amount: 15_000,
        reason: 'Fondo para cambio',
      };

      const reply = await call('POST', '/v1/cash-movements', t.admin.token, body);
      const seen = await call('GET', `/v1/shifts/${shift.shiftId}`, t.owner);

      expect(reply.status, JSON.stringify(reply.body)).toBe(201);
      expect(reply.body).toMatchObject(body);
      expect(seen.body.summary).toMatchObject({ cashIn: 15_000, expectedAmount: 65_000 });
    });

    it('answers a repeated movement with 200 and Idempotent-Replayed, and moves nothing twice', async () => {
      const t = await team();
      const shift = opening(t.deviceId);
      await call('POST', '/v1/shifts', t.cashier.token, shift);
      const body = {
        operationId: randomUUID(),
        shiftId: shift.shiftId,
        direction: 'out',
        amount: 4_000,
        reason: 'Bolsas',
      };
      const first = await call('POST', '/v1/cash-movements', t.owner, body);

      const again = await call('POST', '/v1/cash-movements', t.owner, body);
      const changed = await call('POST', '/v1/cash-movements', t.owner, { ...body, amount: 1 });

      expect(again.status).toBe(200);
      expect(again.headers.get('idempotent-replayed')).toBe('true');
      expect(again.body).toEqual(first.body);
      expect(changed.status).toBe(409);
      expect(changed.body.code).toBe('operation-id-reused');
      const seen = await call('GET', `/v1/shifts/${shift.shiftId}`, t.owner);
      expect(seen.body.summary.cashOut).toBe(4_000);
    });

    it('does not move the cash of a closed shift: 409 shift-closed', async () => {
      const t = await team();
      const shift = opening(t.deviceId);
      await call('POST', '/v1/shifts', t.cashier.token, shift);
      await call('POST', `/v1/shifts/${shift.shiftId}/close`, t.cashier.token, closing());

      const reply = await call('POST', '/v1/cash-movements', t.owner, {
        operationId: randomUUID(),
        shiftId: shift.shiftId,
        direction: 'out',
        amount: 100,
        reason: 'Tarde',
      });

      expect(reply.status).toBe(409);
      expect(reply.body.code).toBe('shift-closed');
    });

    it('is for the management, and says a shift that does not exist is a problem of the field', async () => {
      const t = await team();
      const body = {
        operationId: randomUUID(),
        shiftId: randomUUID(),
        direction: 'in',
        amount: 100,
        reason: 'x',
      };

      const byCashier = await call('POST', '/v1/cash-movements', t.cashier.token, body);
      const unknown = await call('POST', '/v1/cash-movements', t.owner, body);

      expect(byCashier.status).toBe(403);
      expect(unknown.status).toBe(400);
      expect(unknown.body.errors.map((e) => `${e.pointer}:${e.code}`)).toEqual([
        '/shiftId:unknown-shift',
      ]);
    });
  });

  describe('looking at shifts', () => {
    it('shows a cashier only their own shifts, newest first, and the management all of them', async () => {
      const t = await team();
      const mine = opening(t.deviceId, {
        deviceTime: new Date(Date.now() - 3_600_000).toISOString(),
      });
      const theirs = opening(t.deviceId, {
        deviceTime: new Date(Date.now() - 1_800_000).toISOString(),
      });
      await call('POST', '/v1/shifts', t.cashier.token, mine);
      await call('POST', '/v1/shifts', t.admin.token, theirs);

      const own = await call('GET', '/v1/shifts', t.cashier.token);
      const all = await call('GET', '/v1/shifts', t.owner);

      expect(own.body.items.map((s) => s.id)).toEqual([mine.shiftId]);
      expect(all.body.items.map((s) => s.id)).toEqual([theirs.shiftId, mine.shiftId]);
      expect(own.body.items[0]).not.toHaveProperty('summary');
    });

    it('filters by open or closed and pages with a cursor', async () => {
      const t = await team();
      const first = opening(t.deviceId, {
        deviceTime: new Date(Date.now() - 7_200_000).toISOString(),
      });
      await call('POST', '/v1/shifts', t.cashier.token, first);
      await call('POST', `/v1/shifts/${first.shiftId}/close`, t.cashier.token, closing());
      const second = opening(t.deviceId, {
        deviceTime: new Date(Date.now() - 3_600_000).toISOString(),
      });
      await call('POST', '/v1/shifts', t.cashier.token, second);

      const open = await call('GET', '/v1/shifts?open=true', t.owner);
      const closed = await call('GET', '/v1/shifts?open=false', t.owner);
      const page = await call('GET', '/v1/shifts?limit=1', t.owner);
      const next = await call(
        'GET',
        `/v1/shifts?limit=1&cursor=${encodeURIComponent(page.body.nextCursor!)}`,
        t.owner,
      );

      expect(open.body.items.map((s) => s.id)).toEqual([second.shiftId]);
      expect(closed.body.items.map((s) => s.id)).toEqual([first.shiftId]);
      expect(page.body.items.map((s) => s.id)).toEqual([second.shiftId]);
      expect(next.body.items.map((s) => s.id)).toEqual([first.shiftId]);
      expect(next.body.nextCursor).toBeNull();
    });

    it('refuses what it does not know: 400 for a parameter, an open that is not true or false, a cursor made up', async () => {
      const t = await team();

      const unknown = await call('GET', '/v1/shifts?orden=x', t.owner);
      const badOpen = await call('GET', '/v1/shifts?open=quizas', t.owner);
      const badCursor = await call('GET', '/v1/shifts?cursor=nada', t.owner);

      expect(unknown.body.errors.map((e) => e.code)).toEqual(['unknown-field']);
      expect(badOpen.body.errors.map((e) => e.code)).toEqual(['invalid-value']);
      expect(badCursor.body.errors.map((e) => e.code)).toEqual(['invalid-cursor']);
    });

    it('does not show a shift of another person to a cashier, as if it did not exist', async () => {
      const t = await team();
      const theirs = opening(t.deviceId);
      await call('POST', '/v1/shifts', t.admin.token, theirs);

      const reply = await call('GET', `/v1/shifts/${theirs.shiftId}`, t.cashier.token);
      const byOwner = await call('GET', `/v1/shifts/${theirs.shiftId}`, t.owner);

      expect(reply.status).toBe(404);
      expect(reply.body.code).toBe('shift-not-found');
      expect(byOwner.status).toBe(200);
    });

    it('never shows the shifts of another business', async () => {
      const mine = await team();
      const theirs = await team();
      const shift = opening(mine.deviceId);
      await call('POST', '/v1/shifts', mine.owner, shift);

      const list = await call('GET', '/v1/shifts', theirs.owner);
      const one = await call('GET', `/v1/shifts/${shift.shiftId}`, theirs.owner);

      expect(list.body.items).toEqual([]);
      expect(one.status).toBe(404);
    });
  });
});
