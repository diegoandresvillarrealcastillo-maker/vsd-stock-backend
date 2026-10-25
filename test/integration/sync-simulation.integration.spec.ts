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

/**
 * La simulacion del ADR 0016, ahora de punta a punta (C3-15): varios dispositivos, cada uno con su turno y su serie de folios,
 * venden en cualquier orden y mandan sus lotes por HTTP a la API real y a la base real; a veces **la respuesta se pierde** (el
 * dispositivo no se entera de que el lote llego) y a veces **lo vuelve a mandar entero**, tambien mientras otros dispositivos
 * mandan los suyos. Al final: ningun folio repetido, ninguna venta duplicada, la existencia cuadra con el libro y el arqueo de
 * cada turno cuadra con lo que se cobro en efectivo. Es determinista: la misma semilla da siempre el mismo negocio.
 */

/** Generador pseudoaleatorio con semilla (mulberry32): para que una falla se pueda repetir. */
function randomFrom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

interface ResultBody {
  operationId: string | null;
  status: number;
  replayed: boolean;
  problem: { code: string } | null;
}
interface Operation {
  kind: string;
  shiftId?: string;
  body: { operationId: string };
}
interface Device {
  token: string;
  deviceId: string;
  shiftId: string;
  /** Todo lo que este dispositivo hizo sin conexion, en orden: abrir, vender y cerrar. */
  queue: Operation[];
  /** Cuantas operaciones del principio de la cola el dispositivo ya SABE que el servidor tiene. */
  acknowledged: number;
  cashTotal: number;
  sold: Map<string, number>;
}

const DEVICES = 6;
const SALES_PER_DEVICE = 14;
const OPENING = 50_000;
const INITIAL_STOCK_MILLI = 1_000_000;
const PRICES = [3_500, 4_000, 12_500];

describe('a simulation of devices that sell without a connection and send their batches by HTTP (C3-15)', () => {
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

  const call = async <T>(method: string, path: string, token: string, body?: unknown) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: (text === '' ? null : JSON.parse(text)) as T };
  };

  const newcomer = async () => {
    const subject = randomUUID();
    return await provider.token({ subject, email: `${subject.slice(0, 8)}@ejemplo.co` });
  };

  /** Un negocio con su dueno, tres productos con mucha existencia, y un cajero con su dispositivo por cada simulado. */
  async function business(random: () => number) {
    const owner = await newcomer();
    await call('POST', '/v1/businesses', owner, {
      businessName: 'Tienda La Esquina',
      ownerName: 'Ana',
    });
    const products: string[] = [];
    for (const [index, unitPrice] of PRICES.entries()) {
      const created = await call<{ id: string }>('POST', '/v1/products', owner, {
        name: `Producto ${String(index)}`,
        sku: `P${String(index)}`,
        unit: 'unit',
        unitPrice,
        taxRateBp: 1900,
        taxKind: 'taxed',
      });
      await call('POST', '/v1/stock-adjustments', owner, {
        operationId: randomUUID(),
        productId: created.body.id,
        deltaMilli: INITIAL_STOCK_MILLI,
        reason: 'Inventario inicial',
      });
      products.push(created.body.id);
    }

    const devices: Device[] = [];
    for (let n = 0; n < DEVICES; n += 1) {
      const invited = await call<{ invitation: { code: string } }>(
        'POST',
        '/v1/invitations',
        owner,
        {
          fullName: `Cajero ${String(n)}`,
          role: 'cashier',
        },
      );
      const token = await newcomer();
      await call('POST', '/v1/invitations/redeem', token, { code: invited.body.invitation.code });
      const deviceId = randomUUID();
      const registered = await call<{ code: string }>('POST', '/v1/devices', token, {
        id: deviceId,
        name: `Caja ${String(n)}`,
      });
      devices.push(makeDevice(token, deviceId, registered.body.code, products, random));
    }
    return { owner, products, devices };
  }

  /** Lo que el dispositivo hace sin conexion, ya armado: abrir su turno, vender y cerrar contando lo que debe haber. */
  function makeDevice(
    token: string,
    deviceId: string,
    code: string,
    products: readonly string[],
    random: () => number,
  ): Device {
    const shiftId = randomUUID();
    const device: Device = {
      token,
      deviceId,
      shiftId,
      queue: [],
      acknowledged: 0,
      cashTotal: 0,
      sold: new Map(),
    };
    device.queue.push({
      kind: 'shift-open',
      body: {
        operationId: randomUUID(),
        shiftId,
        deviceId,
        openingAmount: OPENING,
        deviceTime: new Date().toISOString(),
        clockOffsetMs: 0,
      } as Operation['body'],
    });
    for (let serial = 1; serial <= SALES_PER_DEVICE; serial += 1) {
      const lines = Array.from({ length: 1 + Math.floor(random() * 3) }, () => {
        const index = Math.floor(random() * products.length);
        const units = 1 + Math.floor(random() * 3);
        const unitPrice = PRICES[index]!;
        device.sold.set(products[index]!, (device.sold.get(products[index]!) ?? 0) + units * 1_000);
        return {
          productId: products[index]!,
          quantityMilli: units * 1_000,
          unitPrice,
          discount: 0,
          taxRateBp: 1900,
          taxKind: 'taxed',
        };
      });
      const total = lines.reduce(
        (sum, line) => sum + (line.quantityMilli / 1_000) * line.unitPrice,
        0,
      );
      const cash = random() < 0.7;
      if (cash) device.cashTotal += total;
      device.queue.push({
        kind: 'sale',
        body: {
          operationId: randomUUID(),
          shiftId,
          folio: `${code}-${String(serial).padStart(6, '0')}`,
          total,
          lines,
          payments: [{ method: cash ? 'cash' : 'card', amount: total }],
          deviceTime: new Date().toISOString(),
          clockOffsetMs: 0,
        } as Operation['body'],
      });
    }
    device.queue.push({
      kind: 'shift-close',
      shiftId,
      body: {
        operationId: randomUUID(),
        countedAmount: OPENING + device.cashTotal,
        deviceTime: new Date().toISOString(),
        clockOffsetMs: 0,
      } as Operation['body'],
    });
    return device;
  }

  const count = async (table: string) =>
    Number((await select(admin, `SELECT count(*)::int AS n FROM ${table}`))[0]?.['n']);

  it.each([1, 2, 3])(
    'with the seed %i: no folio repeats, no sale is duplicated, the stock matches the ledger and each shift balances',
    async (seed) => {
      const random = randomFrom(seed);
      const { owner, products, devices } = await business(random);
      let lost = 0;
      let resent = 0;

      // Cada vuelta, los dispositivos que se conectan mandan, a la vez, un pedazo de lo que todavia no saben entregado.
      for (
        let round = 0;
        round < 400 && devices.some((d) => d.acknowledged < d.queue.length);
        round += 1
      ) {
        const connected = devices.filter(() => random() < 0.6);
        await Promise.all(
          connected.map(async (device) => {
            if (device.acknowledged >= device.queue.length) return;
            // Un lote de 1 a 8 operaciones desde la primera que no sabe entregada: tambien repite lo que ya llego.
            const size = 1 + Math.floor(random() * 8);
            const operations = device.queue.slice(device.acknowledged, device.acknowledged + size);
            // A veces el dispositivo manda ademas lo que ya habia mandado antes: un reenvio completo del tramo anterior.
            const before = random() < 0.25 ? Math.min(device.acknowledged, 3) : 0;
            const batch = device.queue.slice(
              device.acknowledged - before,
              device.acknowledged + size,
            );
            if (before > 0) resent += before;
            const reply = await call<{ results: ResultBody[] }>('POST', '/v1/sync', device.token, {
              operations: batch,
            });
            expect(reply.status).toBe(200);
            // La respuesta se pierde: el dispositivo no se entera de que el lote llego y lo vuelve a mandar despues.
            if (random() < 0.3) {
              lost += 1;
              return;
            }
            expect(reply.body.results).toHaveLength(batch.length);
            for (const result of reply.body.results) {
              expect(result.status, JSON.stringify(result)).toBeLessThan(300);
            }
            device.acknowledged += operations.length;
          }),
        );
      }

      expect(devices.every((d) => d.acknowledged === d.queue.length)).toBe(true);
      // Que la simulacion de verdad ejerza lo que dice ejercer.
      expect(lost).toBeGreaterThan(0);
      expect(resent).toBeGreaterThan(0);

      const totalSales = DEVICES * SALES_PER_DEVICE;
      // Ninguna venta duplicada y ningun folio repetido, a pesar de los reenvios y las respuestas perdidas.
      expect(await count('sale')).toBe(totalSales);
      expect(
        Number((await select(admin, 'SELECT count(DISTINCT folio)::int AS n FROM sale'))[0]?.['n']),
      ).toBe(totalSales);
      expect(await count('cash_shift')).toBe(DEVICES);
      expect(
        await select(admin, 'SELECT count(*)::int AS n FROM cash_shift WHERE closed_at IS NULL'),
      ).toEqual([{ n: 0 }]);

      // La existencia cuadra con el libro: lo que habia, menos lo vendido, y el saldo es la suma del libro.
      for (const productId of products) {
        const sold = devices.reduce((sum, device) => sum + (device.sold.get(productId) ?? 0), 0);
        const ledger = await select(
          admin,
          `SELECT COALESCE(sum(delta), 0)::bigint AS total FROM stock_movement WHERE product_id = '${productId}'`,
        );
        expect(Number(ledger[0]?.['total'])).toBe(INITIAL_STOCK_MILLI - sold);
        const balance = await select(
          admin,
          `SELECT quantity::bigint AS quantity FROM stock_balance WHERE product_id = '${productId}'`,
        );
        expect(Number(balance[0]?.['quantity'])).toBe(INITIAL_STOCK_MILLI - sold);
      }

      // El arqueo de cada turno cuadra con lo que se cobro en efectivo: lo contado es lo esperado.
      for (const device of devices) {
        const shift = await call<{
          summary: {
            cashSales: number;
            expectedAmount: number;
            countedAmount: number;
            difference: number;
          };
        }>('GET', `/v1/shifts/${device.shiftId}`, owner);
        expect(shift.status).toBe(200);
        expect(shift.body.summary).toMatchObject({
          cashSales: device.cashTotal,
          expectedAmount: OPENING + device.cashTotal,
          countedAmount: OPENING + device.cashTotal,
          difference: 0,
        });
      }

      // Y mandarlo todo otra vez, de todos a la vez, no escribe nada: cada resultado dice que ya estaba aplicado.
      const before = {
        sale: await count('sale'),
        movements: await count('stock_movement'),
        shifts: await count('cash_shift'),
      };
      const replies = await Promise.all(
        devices.map(async (device) => {
          const out: ResultBody[] = [];
          for (let from = 0; from < device.queue.length; from += 50) {
            const reply = await call<{ results: ResultBody[] }>('POST', '/v1/sync', device.token, {
              operations: device.queue.slice(from, from + 50),
            });
            expect(reply.status).toBe(200);
            out.push(...reply.body.results);
          }
          return out;
        }),
      );
      for (const results of replies) {
        for (const result of results) {
          expect(result.replayed, JSON.stringify(result)).toBe(true);
          expect(result.status).toBe(200);
          expect(result.problem).toBeNull();
        }
      }
      expect({
        sale: await count('sale'),
        movements: await count('stock_movement'),
        shifts: await count('cash_shift'),
      }).toEqual(before);
    },
    120_000,
  );
});
