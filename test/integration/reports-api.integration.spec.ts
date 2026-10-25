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

interface Row {
  taxKind: string;
  rateBp: number;
  total: number;
  base: number;
  tax: number;
}

interface Section {
  count: number;
  total: number;
  base: number;
  tax: number;
  rows: Row[];
  payments: { method: string; amount: number }[];
}

interface Body {
  month: string;
  from: string;
  to: string;
  sales: Section;
  voids: Section;
  items: { total: number }[];
  businessId: string;
  invitation: { code: string };
  userId: string;
  id: string;
  code: string;
  errors: { pointer: string; code: string }[];
}

interface Reply {
  status: number;
  body: Body;
}

/** El mes de hoy como lo dice un reloj de Bogota, sacado de la base de zonas horarias y no de la resta que usa el codigo. */
const currentMonth = (): string => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}`;
};

/**
 * El reporte mensual de punta a punta (C4-R1, ADR 0035): un token firmado, la API real y la base real. Lo que los dobles de
 * memoria no pueden probar: que el mes se corta a medianoche de Bogota sobre horas que la base guarda en UTC, que una
 * anulacion cae en el mes en que se hizo, que cada negocio ve solo lo suyo y que el reporte coincide con lo que las ventas
 * guardaron.
 */
describe('the monthly report, end to end (C4-R1)', () => {
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
    return { status: response.status, body: (text === '' ? null : JSON.parse(text)) as Body };
  };

  const newcomer = async () => {
    const subject = randomUUID();
    return await provider.token({ subject, email: `${subject.slice(0, 8)}@ejemplo.co` });
  };

  /** Un negocio con dueno, administracion y cajero, un dispositivo y un producto de cada tipo y tarifa. */
  const team = async () => {
    const owner = await newcomer();
    await call('POST', '/v1/businesses', owner, {
      businessName: 'Tienda La Esquina',
      ownerName: 'Ana',
    });
    const hire = async (role: 'admin' | 'cashier') => {
      const invited = await call('POST', '/v1/invitations', owner, { fullName: role, role });
      const person = await newcomer();
      await call('POST', '/v1/invitations/redeem', person, { code: invited.body.invitation.code });
      return person;
    };
    const deviceId = randomUUID();
    await call('POST', '/v1/devices', owner, { id: deviceId, name: 'Caja' });
    const product = async (sku: string, taxRateBp: number, taxKind: string) =>
      (
        await call('POST', '/v1/products', owner, {
          name: sku,
          sku,
          unit: 'unit',
          unitPrice: 1_000,
          taxRateBp,
          taxKind,
        })
      ).body.id;
    const shiftId = randomUUID();
    await call('POST', '/v1/shifts', owner, {
      operationId: randomUUID(),
      shiftId,
      deviceId,
      openingAmount: 0,
      deviceTime: new Date().toISOString(),
      clockOffsetMs: 0,
    });
    return {
      owner,
      admin: await hire('admin'),
      cashier: await hire('cashier'),
      shiftId,
      general: await product('GEN', 1900, 'taxed'),
      reduced: await product('RED', 500, 'taxed'),
      exempt: await product('EXE', 0, 'exempt'),
      excluded: await product('EXC', 0, 'excluded'),
    };
  };
  type Team = Awaited<ReturnType<typeof team>>;

  let serial = 0;
  /** Una venta de la gaseosa a 11.900 (19 %) y del pan a 700 (exento), pagada con tarjeta, hecha a la hora que se diga. */
  const sell = async (t: Team, at: string, change: Record<string, unknown> = {}) => {
    serial += 1;
    const reply = await call('POST', '/v1/sales', t.owner, {
      operationId: randomUUID(),
      shiftId: t.shiftId,
      folio: `AA-${String(serial).padStart(6, '0')}`,
      total: 12_600,
      lines: [
        {
          productId: t.general,
          quantityMilli: 1_000,
          unitPrice: 11_900,
          discount: 0,
          taxRateBp: 1900,
          taxKind: 'taxed',
        },
        {
          productId: t.exempt,
          quantityMilli: 1_000,
          unitPrice: 700,
          discount: 0,
          taxRateBp: 0,
          taxKind: 'exempt',
        },
      ],
      payments: [{ method: 'card', amount: 12_600, reference: 'aprobacion 1' }],
      deviceTime: at,
      clockOffsetMs: 0,
      ...change,
    });
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    return reply.body;
  };

  const fields = (reply: Reply) => reply.body.errors.map((e) => `${e.pointer}:${e.code}`);

  it('gives the sales of the month by kind and rate, how they were paid, and what the receipts say', async () => {
    const t = await team();
    await sell(t, '2026-10-10T15:00:00.000Z');
    await sell(t, '2026-10-12T15:00:00.000Z', {
      total: 2_050,
      lines: [
        {
          productId: t.reduced,
          quantityMilli: 1_000,
          unitPrice: 1_050,
          discount: 0,
          taxRateBp: 500,
          taxKind: 'taxed',
        },
        {
          productId: t.excluded,
          quantityMilli: 1_000,
          unitPrice: 1_000,
          discount: 0,
          taxRateBp: 0,
          taxKind: 'excluded',
        },
      ],
      payments: [
        { method: 'cash', amount: 1_050 },
        { method: 'transfer', amount: 1_000, reference: 'ref-9' },
      ],
    });

    const reply = await call('GET', '/v1/reports/monthly?month=2026-10', t.owner);

    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(reply.body).toMatchObject({
      month: '2026-10',
      from: '2026-10-01T05:00:00.000Z',
      to: '2026-11-01T05:00:00.000Z',
    });
    expect(reply.body.sales.rows).toEqual([
      { taxKind: 'taxed', rateBp: 1900, total: 11_900, base: 10_000, tax: 1_900 },
      { taxKind: 'taxed', rateBp: 500, total: 1_050, base: 1_000, tax: 50 },
      { taxKind: 'exempt', rateBp: 0, total: 700, base: 700, tax: 0 },
      { taxKind: 'excluded', rateBp: 0, total: 1_000, base: 1_000, tax: 0 },
    ]);
    expect(reply.body.sales).toMatchObject({ count: 2, total: 14_650, base: 12_700, tax: 1_950 });
    expect(reply.body.sales.payments).toEqual([
      { method: 'cash', amount: 1_050 },
      { method: 'card', amount: 12_600 },
      { method: 'transfer', amount: 1_000 },
    ]);
    expect(reply.body.voids).toMatchObject({ count: 0, total: 0 });
    // Lo que la venta guardo (su total) y lo que el reporte suma son la misma cuenta.
    const stored = await call('GET', '/v1/sales', t.owner);
    expect(stored.body.items.reduce((sum, sale) => sum + sale.total, 0)).toBe(
      reply.body.sales.total,
    );
    expect(reply.body.sales.payments.reduce((sum, p) => sum + p.amount, 0)).toBe(
      reply.body.sales.total,
    );
  });

  it('cuts the months at midnight in Bogotá: 23:30 of the 30th is September, 00:30 of the 1st is October', async () => {
    const t = await team();
    // 30 de septiembre, 23:30 en Bogota = 04:30 UTC del 1 de octubre.
    await sell(t, '2026-10-01T04:30:00.000Z');
    // 1 de octubre, 00:30 en Bogota = 05:30 UTC.
    await sell(t, '2026-10-01T05:30:00.000Z');

    const september = await call('GET', '/v1/reports/monthly?month=2026-09', t.owner);
    const october = await call('GET', '/v1/reports/monthly?month=2026-10', t.owner);

    expect(september.body.sales.count).toBe(1);
    expect(october.body.sales.count).toBe(1);
  });

  it('takes the first instant of the month in and leaves the last millisecond before it out, for the sales', async () => {
    const t = await team();
    // El corte esta en el pasado a proposito: una venta con hora futura se topa a la hora de llegada (ADR 0016).
    // Octubre es [2026-10-01T05:00Z, 2026-11-01T05:00Z): el primer instante entra y el milisegundo anterior es de septiembre.
    await sell(t, '2026-10-01T05:00:00.000Z');
    await sell(t, '2026-10-01T04:59:59.999Z');

    const september = await call('GET', '/v1/reports/monthly?month=2026-09', t.owner);
    const october = await call('GET', '/v1/reports/monthly?month=2026-10', t.owner);

    expect(september.body.sales.count).toBe(1);
    expect(october.body.sales.count).toBe(1);
  });

  /**
   * La hora de una anulacion es la del servidor (`sale_void.created_at`), que no se puede escoger por la API. Para probar
   * el borde exacto se la fija con la conexion de administracion, sin disparadores, como hace el resto de datos de prueba.
   */
  const voidAt = async (t: Team, madeAt: string, voidedAt: string) => {
    const made = await sell(t, madeAt);
    const voided = await call('POST', `/v1/sales/${made.id}/void`, t.owner, {
      operationId: randomUUID(),
      reason: 'Se equivocó de producto',
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(201);
    const client = await admin.connect();
    try {
      await client.query('SET session_replication_role = replica');
      await client.query('UPDATE sale_void SET created_at = $1 WHERE sale_id = $2', [
        voidedAt,
        made.id,
      ]);
      await client.query('SET session_replication_role = DEFAULT');
    } finally {
      client.release();
    }
  };

  it('takes the first instant of the month in and leaves the last millisecond before it out, for the voids', async () => {
    const t = await team();
    await voidAt(t, '2026-08-10T15:00:00.000Z', '2026-10-01T05:00:00.000Z');
    await voidAt(t, '2026-08-11T15:00:00.000Z', '2026-10-01T04:59:59.999Z');

    const september = await call('GET', '/v1/reports/monthly?month=2026-09', t.owner);
    const october = await call('GET', '/v1/reports/monthly?month=2026-10', t.owner);
    const august = await call('GET', '/v1/reports/monthly?month=2026-08', t.owner);

    expect(september.body.voids.count).toBe(1);
    expect(october.body.voids.count).toBe(1);
    // Las dos ventas anuladas son de agosto, y siguen alli.
    expect(august.body.sales.count).toBe(2);
    expect(august.body.voids.count).toBe(0);
  });

  it('counts a discount in the line, as the receipt does: the tax is taken out of what was charged', async () => {
    const t = await team();
    await sell(t, '2026-10-10T15:00:00.000Z', {
      total: 10_000,
      lines: [
        {
          productId: t.general,
          quantityMilli: 1_000,
          unitPrice: 11_900,
          discount: 1_900,
          taxRateBp: 1900,
          taxKind: 'taxed',
        },
      ],
      payments: [{ method: 'cash', amount: 10_000 }],
    });

    const reply = await call('GET', '/v1/reports/monthly?month=2026-10', t.owner);

    expect(reply.body.sales.rows[0]).toEqual({
      taxKind: 'taxed',
      rateBp: 1900,
      total: 10_000,
      base: 8_403,
      tax: 1_597,
    });
  });

  it('puts a void in the month it was made, and leaves the sale in the month it happened', async () => {
    const t = await team();
    const made = await sell(t, '2026-09-15T15:00:00.000Z');
    const voided = await call('POST', `/v1/sales/${made.id}/void`, t.owner, {
      operationId: randomUUID(),
      reason: 'Se equivocó de producto',
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(201);

    const september = await call('GET', '/v1/reports/monthly?month=2026-09', t.owner);
    const now = await call('GET', `/v1/reports/monthly?month=${currentMonth()}`, t.owner);

    expect(september.body.sales).toMatchObject({ count: 1, total: 12_600 });
    expect(september.body.voids).toMatchObject({ count: 0, total: 0 });
    expect(now.body.sales).toMatchObject({ count: 0, total: 0 });
    expect(now.body.voids).toMatchObject({ count: 1, total: 12_600, base: 10_700, tax: 1_900 });
    expect(now.body.voids.payments).toEqual([
      { method: 'cash', amount: 0 },
      { method: 'card', amount: 12_600 },
      { method: 'transfer', amount: 0 },
    ]);
  });

  it('gives the four rows at zero for a month without sales', async () => {
    const t = await team();

    const reply = await call('GET', '/v1/reports/monthly?month=2026-01', t.owner);

    expect(reply.status).toBe(200);
    expect(reply.body.sales.rows.map((r) => [r.taxKind, r.rateBp, r.total])).toEqual([
      ['taxed', 1900, 0],
      ['taxed', 500, 0],
      ['exempt', 0, 0],
      ['excluded', 0, 0],
    ]);
  });

  it('is for the management: the owner and the admin read it, the cashier is told no', async () => {
    const t = await team();
    await sell(t, '2026-10-10T15:00:00.000Z');

    const asOwner = await call('GET', '/v1/reports/monthly?month=2026-10', t.owner);
    const asAdmin = await call('GET', '/v1/reports/monthly?month=2026-10', t.admin);
    const asCashier = await call('GET', '/v1/reports/monthly?month=2026-10', t.cashier);

    expect(asOwner.status).toBe(200);
    expect(asAdmin.body).toEqual(asOwner.body);
    expect(asCashier.status).toBe(403);
  });

  it('asks for a token, and for a person who already has a business', async () => {
    const t = await team();

    const anonymous = await call('GET', '/v1/reports/monthly?month=2026-10');
    const lone = await call('GET', '/v1/reports/monthly?month=2026-10', await newcomer());

    expect(anonymous.status).toBe(401);
    expect(lone.status).toBe(403);
    expect(t.owner).toBeDefined();
  });

  it.each([
    ['', ['/month:required']],
    ['?month=2026-13', ['/month:invalid-month']],
    ['?month=octubre', ['/month:invalid-month']],
    ['?month=2026-10&year=2026', ['/year:unknown-field']],
  ])('refuses the query «%s» with 400 and says which parameter', async (query, expected) => {
    const t = await team();

    const reply = await call('GET', `/v1/reports/monthly${query}`, t.owner);

    expect(reply.status).toBe(400);
    expect(fields(reply)).toEqual(expected);
  });

  it('never shows the sales of another business', async () => {
    const mine = await team();
    const other = await team();
    await sell(mine, '2026-10-10T15:00:00.000Z');
    await sell(other, '2026-10-11T15:00:00.000Z');
    await sell(other, '2026-10-12T15:00:00.000Z');

    const ofMine = await call('GET', '/v1/reports/monthly?month=2026-10', mine.owner);
    const ofOther = await call('GET', '/v1/reports/monthly?month=2026-10', other.owner);

    expect(ofMine.body.sales.count).toBe(1);
    expect(ofOther.body.sales.count).toBe(2);
  });
});
