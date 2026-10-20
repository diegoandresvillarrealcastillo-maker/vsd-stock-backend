import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applicationUrlOf } from '../../scripts/prepare-database.ts';
import { ROLES, type Role } from '../../src/domain/model/role.js';
import { createApp } from '../../src/infrastructure/config/create-app.js';
import { FakeIdentityProvider } from '../support/fake-identity-provider.js';
import { createAdminPool } from './support/database.js';
import { resetData } from './support/seed.js';
import { select } from './support/sql.js';

/** Quien llama dentro de un negocio: los tres roles y una persona que ya fue dada de baja y conserva su token. */
type Actor = Role | 'dismissed';

const MANAGEMENT: readonly Role[] = ['owner', 'admin'];
const EVERYONE: readonly Role[] = ROLES;

interface Body {
  id: string;
  code: string;
  errors: { pointer: string; code: string }[];
  userId: string;
  businessId: string;
  invitation: { code: string };
  person: { id: string };
}

interface Reply {
  status: number;
  text: string;
  body: Body;
}

interface Request {
  method: string;
  path: string;
  body?: unknown;
}

/** Un negocio abierto por la API real, con sus tres roles y a quien dieron de baja. */
interface Team {
  readonly label: string;
  readonly businessId: string;
  /** Una palabra que aparece en TODO nombre y correo de este negocio. */
  readonly marker: string;
  readonly tokens: Record<Actor, string>;
  readonly userIds: Record<Actor, string>;
  /** Lo que delata a este negocio: si aparece en lo que ve otro, se filtro. */
  readonly traces: Set<string>;
}

/**
 * Que recibe quien es de OTRO negocio y tiene el rol que si podria hacer esto, cuando la peticion apunta a cosas de
 * este negocio:
 * - `not-found`: la cosa de la ruta no existe para el (404), igual que una que nunca existio;
 * - `unknown-reference`: lo que nombra el cuerpo no existe para el (400, con el campo);
 * - `own-business`: nada de la peticion apunta a otro negocio: actua en el suyo.
 */
type Outsider =
  | { readonly kind: 'not-found'; readonly code: string }
  | { readonly kind: 'unknown-reference'; readonly errors: readonly string[] }
  | { readonly kind: 'own-business' };

interface Row {
  /** Metodo y ruta tal como los registra la API. */
  readonly route: string;
  /** Los roles que ADR 0017 deja hacer esto. */
  readonly allowed: readonly Role[];
  /** El estado cuando se logra. */
  readonly success: number;
  /** Una peticion nueva hacia el negocio de `team`, con su propia cosa para no gastar la de otra prueba. */
  readonly aim: (team: Team) => Promise<Request>;
  readonly outsider: Outsider;
  /** Lo que recibe, de otro negocio, quien tiene un rol que no puede hacer esto. Por omision, 403. */
  readonly deniedOutsider?: number;
  /**
   * Lo que recibe, en su propio negocio, quien tiene un rol que no puede hacer esto. Por omision, 403 `forbidden`. Un recurso
   * que el rol no puede ver no existe para el: 404, igual que uno que nunca existio.
   */
  readonly deniedInside?: { readonly status: number; readonly code: string };
}

/**
 * Los casos de uso, y la ruta (o las rutas) que los alcanza. Si aparece uno nuevo sin lista, o una ruta que ya no
 * existe, la prueba lo dice: la matriz no puede quedarse atras de la API.
 */
const USE_CASES: Record<string, readonly string[]> = {
  authenticate: ['GET /v1/me'],
  categories: [
    'GET /v1/categories',
    'POST /v1/categories',
    'PATCH /v1/categories/:categoryId',
    'DELETE /v1/categories/:categoryId',
  ],
  'cash-movements': ['POST /v1/cash-movements'],
  'create-business': ['POST /v1/businesses'],
  devices: ['POST /v1/devices', 'GET /v1/devices', 'POST /v1/devices/:deviceId/revoke'],
  'get-health': ['GET /health'],
  'get-me': ['GET /v1/me'],
  'get-readiness': ['GET /v1/ready'],
  'invite-user': ['POST /v1/invitations'],
  'list-users': ['GET /v1/users'],
  products: [
    'GET /v1/products',
    'GET /v1/products/:productId',
    'POST /v1/products',
    'PATCH /v1/products/:productId',
  ],
  purchases: ['POST /v1/purchases', 'GET /v1/purchases', 'GET /v1/purchases/:purchaseId'],
  'redeem-invitation': ['POST /v1/invitations/redeem'],
  'regenerate-invitation': ['POST /v1/users/:userId/invitation'],
  shifts: [
    'POST /v1/shifts',
    'POST /v1/shifts/:shiftId/close',
    'GET /v1/shifts',
    'GET /v1/shifts/:shiftId',
  ],
  'stock-adjustments': ['POST /v1/stock-adjustments'],
  stock: ['GET /v1/stock', 'GET /v1/stock-movements'],
  suppliers: [
    'GET /v1/suppliers',
    'POST /v1/suppliers',
    'PATCH /v1/suppliers/:supplierId',
    'DELETE /v1/suppliers/:supplierId',
  ],
  'update-user': ['PATCH /v1/users/:userId'],
  warehouse: ['GET /v1/warehouse'],
};

/** Lo que cualquiera puede pedir sin sesion, y lo que pide una sesion sin negocio todavia. */
const OPEN_ROUTES = ['GET /health', 'GET /v1/ready'];
const SESSION_ONLY_ROUTES = ['GET /v1/me', 'POST /v1/businesses', 'POST /v1/invitations/redeem'];

interface Layer {
  route?: { path: string; methods: Record<string, boolean> };
}

/** Todas las rutas que la API de verdad atiende, leidas del enrutador y no de una lista escrita a mano. */
function routesOf(app: NestExpressApplication): string[] {
  const express = app.getHttpAdapter().getInstance() as {
    router?: { stack: Layer[] };
    _router?: { stack: Layer[] };
  };
  const stack = (express.router ?? express._router)?.stack ?? [];
  return stack
    .filter((layer) => layer.route !== undefined)
    .flatMap((layer) =>
      Object.keys(layer.route!.methods).map(
        (method) => `${method.toUpperCase()} ${layer.route!.path}`,
      ),
    )
    .sort();
}

/**
 * De punta a punta (ADR 0017 y 0021): dos negocios abiertos por la API real, con un dueno, un administrador y un
 * cajero cada uno. Cada ruta se prueba con cada rol en su negocio, sin sesion, sin negocio, dada de baja y desde el
 * otro negocio. La lista de rutas sale del enrutador: una ruta nueva sin su fila hace fallar esto.
 */
describe('isolation between businesses and the matrix of roles, through the whole API', () => {
  let provider: FakeIdentityProvider;
  let admin: pg.Pool;
  let app: NestExpressApplication;
  let baseUrl: string;
  let a: Team;
  let b: Team;
  let counter = 0;

  beforeAll(async () => {
    provider = await FakeIdentityProvider.start();
    admin = createAdminPool(2);
    await resetData(admin);
    app = await createApp({
      quiet: true,
      databaseUrl: applicationUrlOf(process.env['TEST_DATABASE_URL']!),
      auth: { issuer: provider.issuer, jwksUrl: provider.jwksUrl, audience: provider.audience },
    });
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
    a = await openTeam('A');
    b = await openTeam('B');
  });

  afterAll(async () => {
    await app.close();
    await provider.stop();
    await admin.end();
  });

  // ---------------------------------------------------------------------------------------------------- ayudas

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
      text,
      body: (text === '' ? null : JSON.parse(text)) as Body,
    };
  };

  const send = (request: Request, token?: string) =>
    call(request.method, request.path, token, request.body);

  const unique = (team: Team, what: string) => `${what} ${team.marker}-${++counter}`;

  /** Una peticion de preparacion: tiene que salir bien, y lo que crea se anota como rastro del negocio. */
  const setup = async (team: Team, method: string, path: string, body?: unknown): Promise<Body> => {
    const reply = await call(method, path, team.tokens.owner, body);
    expect(reply.status, `${method} ${path} (preparacion): ${reply.text}`).toBeLessThan(300);
    if (reply.body?.id !== undefined) team.traces.add(reply.body.id);
    return reply.body;
  };

  async function openTeam(label: string): Promise<Team> {
    const marker = `zz${randomUUID().slice(0, 8)}`;
    const traces = new Set<string>([marker]);
    const person = async (role: string) => {
      const subject = randomUUID();
      const email = `${marker}-${role}@ejemplo.co`;
      traces.add(subject).add(email);
      return { subject, token: await provider.token({ subject, email }) };
    };

    const owner = await person('owner');
    const opened = await call('POST', '/v1/businesses', owner.token, {
      businessName: `Negocio ${marker}`,
      ownerName: `Dueno ${marker}`,
    });
    expect(opened.status, opened.text).toBe(201);
    traces.add(opened.body.businessId).add(opened.body.userId);

    const hire = async (role: 'admin' | 'cashier', name: string) => {
      const invited = await call('POST', '/v1/invitations', owner.token, {
        fullName: `${name} ${marker}`,
        role,
      });
      expect(invited.status, invited.text).toBe(201);
      traces.add(invited.body.invitation.code).add(invited.body.person.id);
      const hired = await person(name);
      const redeemed = await call('POST', '/v1/invitations/redeem', hired.token, {
        code: invited.body.invitation.code,
      });
      expect(redeemed.status, redeemed.text).toBe(200);
      traces.add(redeemed.body.userId);
      return { token: hired.token, userId: redeemed.body.userId };
    };
    const adminPerson = await hire('admin', 'admin');
    const cashier = await hire('cashier', 'cashier');
    const dismissed = await hire('cashier', 'dismissed');
    const dismissal = await call('PATCH', `/v1/users/${dismissed.userId}`, owner.token, {
      active: false,
    });
    expect(dismissal.status, dismissal.text).toBe(200);

    return {
      label,
      businessId: opened.body.businessId,
      marker,
      tokens: {
        owner: owner.token,
        admin: adminPerson.token,
        cashier: cashier.token,
        dismissed: dismissed.token,
      },
      userIds: {
        owner: opened.body.userId,
        admin: adminPerson.userId,
        cashier: cashier.userId,
        dismissed: dismissed.userId,
      },
      traces,
    };
  }

  const makeCategory = async (team: Team) =>
    (await setup(team, 'POST', '/v1/categories', { name: unique(team, 'Categoria') })).id;

  const makeProduct = async (team: Team) =>
    (
      await setup(team, 'POST', '/v1/products', {
        name: unique(team, 'Producto'),
        sku: `${team.marker}-${++counter}`,
        unit: 'unit',
        unitPrice: 3200,
        taxRateBp: 0,
      })
    ).id;

  const makeSupplier = async (team: Team) =>
    (await setup(team, 'POST', '/v1/suppliers', { name: unique(team, 'Proveedor') })).id;

  const makePurchase = async (team: Team) =>
    (
      await setup(team, 'POST', '/v1/purchases', {
        operationId: randomUUID(),
        supplierId: await makeSupplier(team),
        lines: [{ productId: await makeProduct(team), quantityMilli: 1000, unitCost: 1500 }],
      })
    ).id;

  const makeDevice = async (team: Team) =>
    (await setup(team, 'POST', '/v1/devices', { id: randomUUID(), name: unique(team, 'Caja') })).id;

  /** Un turno abierto por el dueno en un dispositivo nuevo del negocio. */
  const makeShift = async (team: Team) =>
    (
      await setup(team, 'POST', '/v1/shifts', {
        operationId: randomUUID(),
        shiftId: randomUUID(),
        deviceId: await makeDevice(team),
        openingAmount: 20000,
        deviceTime: new Date().toISOString(),
        clockOffsetMs: 0,
      })
    ).id;

  /** Una persona invitada que todavia no canjea su codigo, y otra que ya trabaja: las dos cajeras del negocio. */
  const makePending = async (team: Team, role: 'admin' | 'cashier' = 'cashier') => {
    const invited = await setup(team, 'POST', '/v1/invitations', {
      fullName: unique(team, 'Pendiente'),
      role,
    });
    team.traces.add(invited.invitation.code);
    return invited.person.id;
  };

  let tablesOfBusiness: string[] | undefined;

  /** Todo lo que el negocio guarda: cuantas filas y una huella de cada tabla con `id_negocio`, mas el negocio mismo. */
  const snapshot = async (team: Team): Promise<Record<string, string>> => {
    tablesOfBusiness ??= (
      await select(
        admin,
        `SELECT table_name FROM information_schema.columns
          WHERE table_schema = 'public' AND column_name = 'id_negocio' ORDER BY table_name`,
      )
    ).map((row) => row['table_name'] as string);
    // Una sola ida a la base: una consulta por tabla haria lenta la matriz entera.
    const parts = [...tablesOfBusiness, 'business'].map((table) => {
      const column = table === 'business' ? 'id' : 'id_negocio';
      return `SELECT '${table}' AS name, count(*)::int AS n,
                md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS h
                FROM "${table}" t WHERE t.${column} = $1`;
    });
    const rows = await select(admin, parts.join(' UNION ALL '), [team.businessId]);
    return Object.fromEntries(
      rows.map((row) => [row['name'] as string, `${String(row['n'])} ${String(row['h'])}`]),
    );
  };

  /** Lo que la respuesta cuenta, sin la direccion de la peticion que repite tal cual: eso lo escribio quien pregunto. */
  const visible = (reply: Reply) => reply.text.replace(/"instance":"[^"]*"/g, '');

  const expectNoTraceOf = (team: Team, reply: Reply, what: string) => {
    const text = visible(reply);
    for (const trace of team.traces) {
      expect(
        text.includes(trace),
        `${what}: la respuesta trae «${trace}» del negocio ${team.label}`,
      ).toBe(false);
    }
  };

  const fieldsOf = (reply: Reply) => reply.body.errors.map((e) => `${e.pointer}:${e.code}`);

  // ---------------------------------------------------------------------------------------------------- la matriz

  const ROWS: readonly Row[] = [
    // ---------------- categorias
    {
      route: 'GET /v1/categories',
      allowed: EVERYONE,
      success: 200,
      aim: async (team) => {
        await makeCategory(team);
        return { method: 'GET', path: '/v1/categories' };
      },
      outsider: { kind: 'own-business' },
    },
    {
      route: 'POST /v1/categories',
      allowed: MANAGEMENT,
      success: 201,
      aim: (team) =>
        Promise.resolve({
          method: 'POST',
          path: '/v1/categories',
          body: { name: unique(team, 'Categoria') },
        }),
      outsider: { kind: 'own-business' },
    },
    {
      route: 'PATCH /v1/categories/:categoryId',
      allowed: MANAGEMENT,
      success: 200,
      aim: async (team) => ({
        method: 'PATCH',
        path: `/v1/categories/${await makeCategory(team)}`,
        body: { name: unique(team, 'Renombrada') },
      }),
      outsider: { kind: 'not-found', code: 'category-not-found' },
    },
    {
      route: 'DELETE /v1/categories/:categoryId',
      allowed: MANAGEMENT,
      success: 204,
      aim: async (team) => ({
        method: 'DELETE',
        path: `/v1/categories/${await makeCategory(team)}`,
      }),
      outsider: { kind: 'not-found', code: 'category-not-found' },
    },
    // ---------------- productos
    {
      route: 'GET /v1/products',
      allowed: EVERYONE,
      success: 200,
      aim: async (team) => {
        await makeProduct(team);
        return { method: 'GET', path: '/v1/products' };
      },
      outsider: { kind: 'own-business' },
    },
    {
      route: 'GET /v1/products/:productId',
      allowed: EVERYONE,
      success: 200,
      aim: async (team) => ({ method: 'GET', path: `/v1/products/${await makeProduct(team)}` }),
      outsider: { kind: 'not-found', code: 'product-not-found' },
    },
    {
      route: 'POST /v1/products',
      allowed: MANAGEMENT,
      success: 201,
      aim: (team) =>
        Promise.resolve({
          method: 'POST',
          path: '/v1/products',
          body: {
            name: unique(team, 'Producto'),
            sku: `${team.marker}-${++counter}`,
            unit: 'unit',
            unitPrice: 3200,
            taxRateBp: 0,
          },
        }),
      outsider: { kind: 'own-business' },
    },
    {
      route: 'PATCH /v1/products/:productId',
      allowed: MANAGEMENT,
      success: 200,
      aim: async (team) => ({
        method: 'PATCH',
        path: `/v1/products/${await makeProduct(team)}`,
        body: { name: unique(team, 'Cambiado'), unitPrice: 3500 },
      }),
      outsider: { kind: 'not-found', code: 'product-not-found' },
    },
    // ---------------- existencias
    {
      route: 'GET /v1/stock',
      allowed: EVERYONE,
      success: 200,
      aim: async (team) => {
        const productId = await makeProduct(team);
        await setup(team, 'POST', '/v1/stock-adjustments', {
          operationId: randomUUID(),
          productId,
          deltaMilli: 5000,
          reason: 'Existencia inicial',
        });
        return { method: 'GET', path: '/v1/stock' };
      },
      outsider: { kind: 'own-business' },
    },
    {
      route: 'GET /v1/stock-movements',
      allowed: EVERYONE,
      success: 200,
      aim: async (team) => {
        const productId = await makeProduct(team);
        await setup(team, 'POST', '/v1/stock-adjustments', {
          operationId: randomUUID(),
          productId,
          deltaMilli: 5000,
          reason: 'Existencia inicial',
        });
        return { method: 'GET', path: `/v1/stock-movements?productId=${productId}` };
      },
      outsider: { kind: 'not-found', code: 'product-not-found' },
    },
    {
      route: 'POST /v1/stock-adjustments',
      allowed: MANAGEMENT,
      success: 201,
      aim: async (team) => ({
        method: 'POST',
        path: '/v1/stock-adjustments',
        body: {
          operationId: randomUUID(),
          productId: await makeProduct(team),
          deltaMilli: 2000,
          reason: 'Conteo',
        },
      }),
      outsider: { kind: 'unknown-reference', errors: ['/productId:unknown-product'] },
    },
    {
      route: 'GET /v1/warehouse',
      allowed: EVERYONE,
      success: 200,
      aim: () => Promise.resolve({ method: 'GET', path: '/v1/warehouse' }),
      outsider: { kind: 'own-business' },
    },
    // ---------------- proveedores y compras
    {
      route: 'GET /v1/suppliers',
      allowed: MANAGEMENT,
      success: 200,
      aim: async (team) => {
        await makeSupplier(team);
        return { method: 'GET', path: '/v1/suppliers' };
      },
      outsider: { kind: 'own-business' },
    },
    {
      route: 'POST /v1/suppliers',
      allowed: MANAGEMENT,
      success: 201,
      aim: (team) =>
        Promise.resolve({
          method: 'POST',
          path: '/v1/suppliers',
          body: { name: unique(team, 'Proveedor') },
        }),
      outsider: { kind: 'own-business' },
    },
    {
      route: 'PATCH /v1/suppliers/:supplierId',
      allowed: MANAGEMENT,
      success: 200,
      aim: async (team) => ({
        method: 'PATCH',
        path: `/v1/suppliers/${await makeSupplier(team)}`,
        body: { name: unique(team, 'Renombrado') },
      }),
      outsider: { kind: 'not-found', code: 'supplier-not-found' },
    },
    {
      route: 'DELETE /v1/suppliers/:supplierId',
      allowed: MANAGEMENT,
      success: 204,
      aim: async (team) => ({
        method: 'DELETE',
        path: `/v1/suppliers/${await makeSupplier(team)}`,
      }),
      outsider: { kind: 'not-found', code: 'supplier-not-found' },
    },
    {
      route: 'POST /v1/purchases',
      allowed: MANAGEMENT,
      success: 201,
      aim: async (team) => ({
        method: 'POST',
        path: '/v1/purchases',
        body: {
          operationId: randomUUID(),
          supplierId: await makeSupplier(team),
          lines: [{ productId: await makeProduct(team), quantityMilli: 3000, unitCost: 900 }],
        },
      }),
      outsider: {
        kind: 'unknown-reference',
        errors: ['/supplierId:unknown-supplier', '/lines/0/productId:unknown-product'],
      },
    },
    {
      route: 'GET /v1/purchases',
      allowed: MANAGEMENT,
      success: 200,
      aim: async (team) => {
        await makePurchase(team);
        return { method: 'GET', path: '/v1/purchases' };
      },
      outsider: { kind: 'own-business' },
    },
    {
      route: 'GET /v1/purchases/:purchaseId',
      allowed: MANAGEMENT,
      success: 200,
      aim: async (team) => ({ method: 'GET', path: `/v1/purchases/${await makePurchase(team)}` }),
      outsider: { kind: 'not-found', code: 'purchase-not-found' },
    },
    // ---------------- dispositivos
    {
      route: 'POST /v1/devices',
      allowed: EVERYONE,
      success: 201,
      aim: (team) =>
        Promise.resolve({
          method: 'POST',
          path: '/v1/devices',
          body: { id: randomUUID(), name: unique(team, 'Caja') },
        }),
      outsider: { kind: 'own-business' },
    },
    {
      route: 'GET /v1/devices',
      allowed: MANAGEMENT,
      success: 200,
      aim: async (team) => {
        await makeDevice(team);
        return { method: 'GET', path: '/v1/devices' };
      },
      outsider: { kind: 'own-business' },
    },
    {
      route: 'POST /v1/devices/:deviceId/revoke',
      allowed: MANAGEMENT,
      success: 200,
      aim: async (team) => ({
        method: 'POST',
        path: `/v1/devices/${await makeDevice(team)}/revoke`,
      }),
      outsider: { kind: 'not-found', code: 'device-not-found' },
    },
    // ---------------- turnos y efectivo
    {
      route: 'POST /v1/shifts',
      allowed: EVERYONE,
      success: 201,
      aim: async (team) => ({
        method: 'POST',
        path: '/v1/shifts',
        body: {
          operationId: randomUUID(),
          shiftId: randomUUID(),
          deviceId: await makeDevice(team),
          openingAmount: 10000,
          deviceTime: new Date().toISOString(),
          clockOffsetMs: 0,
        },
      }),
      outsider: { kind: 'unknown-reference', errors: ['/deviceId:unknown-device'] },
    },
    {
      route: 'POST /v1/shifts/:shiftId/close',
      allowed: MANAGEMENT,
      success: 200,
      aim: async (team) => ({
        method: 'POST',
        path: `/v1/shifts/${await makeShift(team)}/close`,
        body: {
          operationId: randomUUID(),
          countedAmount: 20000,
          deviceTime: new Date().toISOString(),
        },
      }),
      outsider: { kind: 'not-found', code: 'shift-not-found' },
      // Primero se busca el turno (y en otro negocio no existe) y despues se mira de quien es.
      deniedOutsider: 404,
    },
    {
      route: 'GET /v1/shifts',
      allowed: EVERYONE,
      success: 200,
      aim: async (team) => {
        await makeShift(team);
        return { method: 'GET', path: '/v1/shifts' };
      },
      outsider: { kind: 'own-business' },
    },
    {
      route: 'GET /v1/shifts/:shiftId',
      allowed: MANAGEMENT,
      success: 200,
      aim: async (team) => ({ method: 'GET', path: `/v1/shifts/${await makeShift(team)}` }),
      outsider: { kind: 'not-found', code: 'shift-not-found' },
      // El turno es del dueno: para un cajero es de otra persona, y el turno de otra persona no existe para el.
      deniedInside: { status: 404, code: 'shift-not-found' },
      deniedOutsider: 404,
    },
    {
      route: 'POST /v1/cash-movements',
      allowed: MANAGEMENT,
      success: 201,
      aim: async (team) => ({
        method: 'POST',
        path: '/v1/cash-movements',
        body: {
          operationId: randomUUID(),
          shiftId: await makeShift(team),
          direction: 'in',
          amount: 1000,
          reason: unique(team, 'Cambio'),
        },
      }),
      outsider: { kind: 'unknown-reference', errors: ['/shiftId:unknown-shift'] },
    },
    // ---------------- personas
    {
      route: 'GET /v1/users',
      allowed: MANAGEMENT,
      success: 200,
      aim: () => Promise.resolve({ method: 'GET', path: '/v1/users' }),
      outsider: { kind: 'own-business' },
    },
    {
      route: 'POST /v1/invitations',
      allowed: MANAGEMENT,
      success: 201,
      aim: (team) =>
        Promise.resolve({
          method: 'POST',
          path: '/v1/invitations',
          body: { fullName: unique(team, 'Nueva'), role: 'cashier' },
        }),
      outsider: { kind: 'own-business' },
    },
    {
      route: 'PATCH /v1/users/:userId',
      allowed: MANAGEMENT,
      success: 200,
      aim: async (team) => ({
        method: 'PATCH',
        path: `/v1/users/${await makePending(team)}`,
        body: { fullName: unique(team, 'Cambiada') },
      }),
      outsider: { kind: 'not-found', code: 'person-not-found' },
    },
    {
      route: 'POST /v1/users/:userId/invitation',
      allowed: MANAGEMENT,
      success: 200,
      aim: async (team) => ({
        method: 'POST',
        path: `/v1/users/${await makePending(team)}/invitation`,
      }),
      outsider: { kind: 'not-found', code: 'person-not-found' },
      // Primero se busca a la persona (y en otro negocio no existe) y despues se mira el rol.
      deniedOutsider: 404,
    },
  ];

  const MEMBER_ROUTES = ROWS.map((row) => row.route);

  // ---------------------------------------------------------------------------------------------------- pruebas

  describe('the list of routes', () => {
    it('is exactly what the API serves: open ones, ones for any session, and the rows of the matrix', () => {
      expect(routesOf(app)).toEqual(
        [...OPEN_ROUTES, ...SESSION_ONLY_ROUTES, ...MEMBER_ROUTES].sort(),
      );
    });

    it('has no repeated row', () => {
      expect(new Set(MEMBER_ROUTES).size).toBe(MEMBER_ROUTES.length);
    });

    it('names, for every use case of the application, the routes that reach it, and only real ones', () => {
      const directory = resolve(import.meta.dirname, '../../src/application/usecases');
      const useCases = readdirSync(directory)
        .filter((file) => file.endsWith('.usecase.ts'))
        .map((file) => file.replace('.usecase.ts', ''))
        .sort();
      const served = new Set(routesOf(app));

      expect(Object.keys(USE_CASES).sort()).toEqual(useCases);
      for (const [useCase, routes] of Object.entries(USE_CASES)) {
        expect(routes.length, useCase).toBeGreaterThan(0);
        for (const route of routes) expect(served.has(route), `${useCase}: ${route}`).toBe(true);
      }
    });

    it('lets every route of the matrix be reached by at least one use case', () => {
      const reached = new Set(Object.values(USE_CASES).flat());
      for (const route of [...OPEN_ROUTES, ...SESSION_ONLY_ROUTES, ...MEMBER_ROUTES]) {
        expect(reached.has(route), route).toBe(true);
      }
    });

    it('agrees with the table of permissions about who may do what in each row', () => {
      for (const row of ROWS) {
        expect(
          row.allowed.every((role) => ROLES.includes(role)),
          row.route,
        ).toBe(true);
        // Nadie puede menos que un cajero: toda fila deja pasar al dueno.
        expect(row.allowed, row.route).toContain('owner');
      }
    });
  });

  describe('without a session', () => {
    it.each(OPEN_ROUTES)('answers %s to anyone', async (route) => {
      const [method, path] = route.split(' ') as [string, string];

      expect((await call(method, path)).status).toBe(200);
    });

    it.each([...SESSION_ONLY_ROUTES, ...MEMBER_ROUTES])(
      'asks %s for a session, and does not accept a token that is not one',
      async (route) => {
        const [method, path] = route.split(' ') as [string, string];
        const concrete = path.replace(/:\w+/g, randomUUID());

        const none = await call(method, concrete);
        const garbage = await call(method, concrete, 'no-es-un-token');

        expect(none.status).toBe(401);
        expect(none.body.code).toBe('unauthenticated');
        expect(garbage.status).toBe(401);
        expect(garbage.body.code).toBe('invalid-token');
      },
    );
  });

  describe('with a session but no business yet', () => {
    it.each(MEMBER_ROUTES)('tells %s to open a business or redeem a code first', async (route) => {
      const row = ROWS.find((candidate) => candidate.route === route)!;
      const request = await row.aim(a);
      const newcomer = await provider.token({
        subject: randomUUID(),
        email: `${randomUUID().slice(0, 8)}@ejemplo.co`,
      });

      const reply = await send(request, newcomer);

      expect(reply.status).toBe(403);
      expect(reply.body.code).toBe('no-membership');
      expectNoTraceOf(a, reply, route);
    });
  });

  describe('each role in its own business', () => {
    const cells = ROWS.flatMap((row) => ROLES.map((role) => [row.route, role] as const));

    it.each(cells)('%s as the %s does what the table says', async (route, role) => {
      const row = ROWS.find((candidate) => candidate.route === route)!;
      const request = await row.aim(a);
      const before = await snapshot(a);

      const reply = await send(request, a.tokens[role]);

      if (row.allowed.includes(role)) {
        expect(reply.status, reply.text).toBe(row.success);
      } else {
        expect(reply.status, reply.text).toBe(row.deniedInside?.status ?? 403);
        expect(reply.body.code).toBe(row.deniedInside?.code ?? 'forbidden');
        // Negado de verdad: no quedo nada hecho a medias.
        expect(await snapshot(a)).toEqual(before);
      }
      expectNoTraceOf(b, reply, route);
    });
  });

  describe('someone who was let go', () => {
    it.each(MEMBER_ROUTES)('can not use %s with the token they still hold', async (route) => {
      const row = ROWS.find((candidate) => candidate.route === route)!;
      const request = await row.aim(a);
      const before = await snapshot(a);

      const reply = await send(request, a.tokens.dismissed);

      expect(reply.status).toBe(403);
      expect(reply.body.code).toBe('user-inactive');
      expect(await snapshot(a)).toEqual(before);
    });

    it('is told so by /v1/me, and can not open or join another business either', async () => {
      const me = await call('GET', '/v1/me', a.tokens.dismissed);
      const open = await call('POST', '/v1/businesses', a.tokens.dismissed, {
        businessName: 'Otro',
        ownerName: 'Otra',
      });

      expect(me.status).toBe(403);
      expect(me.body.code).toBe('user-inactive');
      expect(open.status).toBe(409);
      expect(open.body.code).toBe('already-member');
    });
  });

  describe('someone from the other business', () => {
    const cells = ROWS.flatMap((row) => ROLES.map((role) => [row.route, role] as const));

    it.each(cells)(
      '%s as the %s of A never reads or changes anything of B',
      async (route, role) => {
        const row = ROWS.find((candidate) => candidate.route === route)!;
        // La peticion apunta a cosas de B, y la hace una persona de A. Si nada de ella nombra a otro negocio, es la
        // peticion de A en su negocio: B solo tiene que seguir igual.
        const pointsAtB = await row.aim(b);
        const request = row.outsider.kind === 'own-business' ? await row.aim(a) : pointsAtB;
        const before = await snapshot(b);

        const reply = await send(request, a.tokens[role]);

        if (!row.allowed.includes(role)) {
          expect(reply.status, reply.text).toBe(row.deniedOutsider ?? 403);
        } else if (row.outsider.kind === 'not-found') {
          expect(reply.status, reply.text).toBe(404);
          expect(reply.body.code).toBe(row.outsider.code);
        } else if (row.outsider.kind === 'unknown-reference') {
          expect(reply.status, reply.text).toBe(400);
          expect(fieldsOf(reply)).toEqual(row.outsider.errors);
        } else {
          expect(reply.status, reply.text).toBe(row.success);
        }
        expectNoTraceOf(b, reply, `${route} as ${role} of A`);
        expect(await snapshot(b)).toEqual(before);
      },
    );

    it.each(cells)(
      '%s as the %s of B never reads or changes anything of A',
      async (route, role) => {
        const row = ROWS.find((candidate) => candidate.route === route)!;
        const pointsAtA = await row.aim(a);
        const request = row.outsider.kind === 'own-business' ? await row.aim(b) : pointsAtA;
        const before = await snapshot(a);

        const reply = await send(request, b.tokens[role]);

        if (!row.allowed.includes(role)) {
          expect(reply.status, reply.text).toBe(row.deniedOutsider ?? 403);
        } else if (row.outsider.kind === 'not-found') {
          expect(reply.status, reply.text).toBe(404);
        } else if (row.outsider.kind === 'unknown-reference') {
          expect(reply.status, reply.text).toBe(400);
        } else {
          expect(reply.status, reply.text).toBe(row.success);
        }
        expectNoTraceOf(a, reply, `${route} as ${role} of B`);
        expect(await snapshot(a)).toEqual(before);
      },
    );

    it('keeps the lists of each business to its own, whoever asks', async () => {
      const lists = ROWS.filter(
        (row) =>
          row.route.startsWith('GET') &&
          !row.route.includes(':') &&
          row.outsider.kind === 'own-business',
      );
      expect(lists.length).toBeGreaterThan(5);

      for (const row of lists) {
        for (const role of row.allowed) {
          const inA = await send(await row.aim(a), a.tokens[role]);
          const inB = await send(await row.aim(b), b.tokens[role]);

          expect(inA.status, `${row.route} ${role}`).toBe(200);
          expectNoTraceOf(b, inA, `${row.route} as ${role} of A`);
          expect(inB.status, `${row.route} ${role}`).toBe(200);
          expectNoTraceOf(a, inB, `${row.route} as ${role} of B`);
        }
      }
    });
  });

  describe('what the body names', () => {
    it('does not let a product point to a category of another business, when created or changed', async () => {
      const foreign = await makeCategory(b);
      const mine = await makeProduct(a);
      const before = await snapshot(b);

      const created = await call('POST', '/v1/products', a.tokens.owner, {
        name: unique(a, 'Producto'),
        sku: `${a.marker}-${++counter}`,
        unit: 'unit',
        unitPrice: 3200,
        taxRateBp: 0,
        categoryId: foreign,
      });
      const changed = await call('PATCH', `/v1/products/${mine}`, a.tokens.owner, {
        categoryId: foreign,
      });

      for (const reply of [created, changed]) {
        expect(reply.status, reply.text).toBe(400);
        expect(fieldsOf(reply)).toEqual(['/categoryId:unknown-category']);
        expectNoTraceOf(b, reply, 'category of another business');
      }
      expect(await snapshot(b)).toEqual(before);
    });

    it('does not let a purchase buy from, or put on the shelf, what belongs to another business', async () => {
      const foreignProduct = await makeProduct(b);
      const foreignSupplier = await makeSupplier(b);
      const before = await snapshot(b);

      const reply = await call('POST', '/v1/purchases', a.tokens.owner, {
        operationId: randomUUID(),
        supplierId: foreignSupplier,
        lines: [{ productId: foreignProduct, quantityMilli: 1000, unitCost: 100 }],
      });

      expect(reply.status, reply.text).toBe(400);
      expect(fieldsOf(reply)).toEqual([
        '/supplierId:unknown-supplier',
        '/lines/0/productId:unknown-product',
      ]);
      expect(await snapshot(b)).toEqual(before);
      expectNoTraceOf(b, reply, 'purchase');
    });

    it('does not take as a repetition the operation id that another business used', async () => {
      const operationId = randomUUID();
      const mine = await makeProduct(a);
      const theirs = await makeProduct(b);
      const first = await call('POST', '/v1/stock-adjustments', b.tokens.owner, {
        operationId,
        productId: theirs,
        deltaMilli: 1000,
        reason: 'Conteo',
      });
      expect(first.status, first.text).toBe(201);
      const before = await snapshot(b);

      const second = await call('POST', '/v1/stock-adjustments', a.tokens.owner, {
        operationId,
        productId: mine,
        deltaMilli: 4000,
        reason: 'Conteo',
      });

      expect(second.status, second.text).toBe(201);
      expect(second.body.id).not.toBe(first.body.id);
      expect(await snapshot(b)).toEqual(before);
      expectNoTraceOf(b, second, 'operation id of another business');
    });
  });

  describe('who may manage whom inside a business', () => {
    const targets = ['cashier', 'admin', 'owner'] as const;
    const cases = ROLES.flatMap((actor) => targets.map((target) => [actor, target] as const));

    const person = async (team: Team, role: (typeof targets)[number]) => {
      if (role === 'owner') {
        // Un segundo dueno se nombra cambiando el rol de alguien que ya esta (solo lo hace un dueno).
        const id = await makePending(team, 'admin');
        const promoted = await call('PATCH', `/v1/users/${id}`, team.tokens.owner, {
          role: 'owner',
        });
        expect(promoted.status, promoted.text).toBe(200);
        return id;
      }
      return makePending(team, role);
    };

    it.each(cases)('the %s changing the name of a %s', async (actor, target) => {
      const id = await person(a, target);
      // Solo el dueno administra a un administrador o a otro dueno; la gerencia, al cajero.
      const allowed = actor === 'owner' || (actor === 'admin' && target === 'cashier');

      const reply = await call('PATCH', `/v1/users/${id}`, a.tokens[actor], {
        fullName: unique(a, 'Nuevo nombre'),
      });

      expect(reply.status, reply.text).toBe(allowed ? 200 : 403);
    });

    it.each(cases)('the %s renewing the code of a pending %s', async (actor, target) => {
      const id = await makePending(a, target === 'owner' ? 'admin' : target);
      const kind = target === 'owner' ? 'admin' : target;
      const allowed = actor === 'owner' || (actor === 'admin' && kind === 'cashier');

      const reply = await call('POST', `/v1/users/${id}/invitation`, a.tokens[actor]);

      expect(reply.status, reply.text).toBe(allowed ? 200 : 403);
    });

    it.each(
      ROLES.flatMap((actor) =>
        (['admin', 'cashier'] as const).map((role) => [actor, role] as const),
      ),
    )('the %s inviting a %s', async (actor, role) => {
      const allowed = actor === 'owner' || (actor === 'admin' && role === 'cashier');

      const reply = await call('POST', '/v1/invitations', a.tokens[actor], {
        fullName: unique(a, 'Invitada'),
        role,
      });

      expect(reply.status, reply.text).toBe(allowed ? 201 : 403);
    });

    it('does not let anyone invite an owner: a second one is named by changing a role', async () => {
      const reply = await call('POST', '/v1/invitations', a.tokens.owner, {
        fullName: unique(a, 'Dueno'),
        role: 'owner',
      });

      expect(reply.status).toBe(400);
      expect(fieldsOf(reply)).toEqual(['/role:invalid-value']);
    });

    it('does not let an administrator promote a cashier to administrator, but lets the owner', async () => {
      const id = await makePending(a, 'cashier');

      const byAdmin = await call('PATCH', `/v1/users/${id}`, a.tokens.admin, { role: 'admin' });
      const byOwner = await call('PATCH', `/v1/users/${id}`, a.tokens.owner, { role: 'admin' });

      expect(byAdmin.status).toBe(403);
      expect(byOwner.status, byOwner.text).toBe(200);
    });

    it('does not leave the business without an active owner, even if the owner asks for it', async () => {
      const lonely = await openTeam('C');

      const demote = await call('PATCH', `/v1/users/${lonely.userIds.owner}`, lonely.tokens.owner, {
        role: 'admin',
      });
      const leave = await call('PATCH', `/v1/users/${lonely.userIds.owner}`, lonely.tokens.owner, {
        active: false,
      });

      for (const reply of [demote, leave]) {
        expect(reply.status, reply.text).toBe(409);
        expect(reply.body.code).toBe('last-owner');
      }
    });
  });

  describe('what is said before looking at what was sent', () => {
    it.each([
      ['the name', { name: 'Otro nombre' }],
      ['the SKU', { sku: 'OTRO-SKU' }],
      ['whether it is active', { active: false }],
      ['the price', { unitPrice: 9900 }],
    ])(
      'a cashier can not change %s of a product, and an administrator can',
      async (_what, change) => {
        const productId = await makeProduct(a);

        const byCashier = await call(
          'PATCH',
          `/v1/products/${productId}`,
          a.tokens.cashier,
          change,
        );
        const byAdmin = await call('PATCH', `/v1/products/${productId}`, a.tokens.admin, change);

        expect(byCashier.status, byCashier.text).toBe(403);
        expect(byCashier.body.code).toBe('forbidden');
        expect(byAdmin.status, byAdmin.text).toBe(200);
      },
    );

    it('tells a cashier that it is not for them before telling them what is wrong with what they sent', async () => {
      const reply = await call('POST', '/v1/invitations', a.tokens.cashier, { unknown: true });

      expect(reply.status).toBe(403);
      expect(reply.body.code).toBe('forbidden');
    });

    it('does not renew the code of someone who already redeemed it, nor of someone let go', async () => {
      const pending = await makePending(a);
      await call('PATCH', `/v1/users/${pending}`, a.tokens.owner, { active: false });

      const redeemed = await call(
        'POST',
        `/v1/users/${a.userIds.cashier}/invitation`,
        a.tokens.owner,
      );
      const letGo = await call('POST', `/v1/users/${pending}/invitation`, a.tokens.owner);

      for (const reply of [redeemed, letGo]) {
        expect(reply.status, reply.text).toBe(409);
        expect(reply.body.code).toBe('invitation-not-pending');
      }
    });
  });

  describe('the doors that are for any session', () => {
    const fresh = () =>
      provider.token({ subject: randomUUID(), email: `${randomUUID().slice(0, 8)}@ejemplo.co` });

    it('lets /v1/me answer for a person with no business, saying so, and for each role in A', async () => {
      const nobody = await call('GET', '/v1/me', await fresh());
      expect(nobody.status).toBe(200);

      for (const role of ROLES) {
        const me = await call('GET', '/v1/me', a.tokens[role]);
        expect(me.status, me.text).toBe(200);
        expect(me.text).toContain(a.businessId);
        expectNoTraceOf(b, me, `me as ${role}`);
      }
    });

    it('lets whoever already works in a business neither open another nor redeem a code', async () => {
      const code = (
        await setup(a, 'POST', '/v1/invitations', {
          fullName: unique(a, 'Otra'),
          role: 'cashier',
        })
      ).invitation.code;

      for (const role of [...ROLES, 'dismissed'] as const) {
        const open = await call('POST', '/v1/businesses', a.tokens[role], {
          businessName: 'Otro',
          ownerName: 'Otra',
        });
        const redeem = await call('POST', '/v1/invitations/redeem', b.tokens[role], { code });

        expect(open.status, `${role}: ${open.text}`).toBe(409);
        expect(open.body.code).toBe('already-member');
        expect(redeem.status, `${role}: ${redeem.text}`).toBe(409);
        expect(redeem.body.code).toBe('already-member');
      }
    });

    it('says only that a code does not exist, for one that never did and for one of another business', async () => {
      const code = (
        await setup(b, 'POST', '/v1/invitations', {
          fullName: unique(b, 'Otra'),
          role: 'cashier',
        })
      ).invitation.code;
      const newcomer = await fresh();

      const unknown = await call('POST', '/v1/invitations/redeem', newcomer, {
        code: '2345-6789-ABCD-EFGH',
      });
      const redeemed = await call('POST', '/v1/invitations/redeem', newcomer, { code });

      expect(unknown.status).toBe(404);
      expect(unknown.body.code).toBe('invitation-not-found');
      // El codigo de B vale para quien lo recibe: es su puerta, no una fuga.
      expect(redeemed.status, redeemed.text).toBe(200);
      expect(redeemed.body.businessId).toBe(b.businessId);
      const again = await call('POST', '/v1/invitations/redeem', await fresh(), { code });
      expect(again.status).toBe(404);
      expect(again.body.code).toBe('invitation-not-found');
    });
  });
});
