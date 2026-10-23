import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applicationUrlOf } from '../../scripts/prepare-database.ts';
import { createApp } from '../../src/infrastructure/config/create-app.js';
import { FakeIdentityProvider } from '../support/fake-identity-provider.js';
import { createAdminPool } from './support/database.js';
import { recordStockEntry } from './support/ledger-design.js';
import { resetData } from './support/seed.js';

interface CategoryBody {
  id: string;
  name: string;
  createdAt: string;
}

interface ProductBody {
  id: string;
  name: string;
  sku: string;
  barcode: string | null;
  unit: string;
  unitPrice: number;
  taxRateBp: number;
  taxKind: string;
  active: boolean;
  categoryId: string | null;
  minStockMilli: number | null;
  createdAt: string;
  updatedAt: string;
}

interface Body extends CategoryBody, ProductBody {
  code: string;
  errors: { pointer: string; code: string; detail: string }[];
  items: (CategoryBody & ProductBody)[];
  nextCursor: string | null;
  userId: string;
  businessId: string;
  invitation: { code: string };
}

interface Reply {
  status: number;
  headers: Headers;
  body: Body;
}

const UPC_A = '036000291452';
const EAN_13_OF_THE_UPC_A = '0036000291452';

const arroz = {
  name: 'Arroz 500 g',
  sku: 'ARR-500',
  unit: 'unit',
  unitPrice: 3200,
  taxRateBp: 0,
  taxKind: 'exempt',
};

/**
 * De punta a punta (ADR 0015): un token firmado, la API real y la base real. El catalogo que ve y cambia cada rol, lo
 * unico que la base no deja repetir, la unidad que se queda con la historia y el aislamiento entre negocios.
 */
describe('the catalog, end to end (ADR 0015)', () => {
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
    return {
      subject,
      token: await provider.token({ subject, email: `${subject.slice(0, 8)}@ejemplo.co` }),
    };
  };

  /** Un negocio abierto por la API, con su dueno, un administrador y un cajero. */
  const team = async () => {
    const owner = await newcomer();
    const opened = await call('POST', '/v1/businesses', owner.token, {
      businessName: 'Tienda La Esquina',
      ownerName: 'Ana',
    });
    const hire = async (role: 'admin' | 'cashier') => {
      const invited = await call('POST', '/v1/invitations', owner.token, { fullName: role, role });
      const person = await newcomer();
      await call('POST', '/v1/invitations/redeem', person.token, {
        code: invited.body.invitation.code,
      });
      return person.token;
    };
    return {
      businessId: opened.body.businessId,
      owner: owner.token,
      admin: await hire('admin'),
      cashier: await hire('cashier'),
    };
  };

  const create = async (token: string, overrides: Record<string, unknown> = {}) => {
    const reply = await call('POST', '/v1/products', token, { ...arroz, ...overrides });
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    return reply.body;
  };

  describe('categories', () => {
    it('lets the management create, rename and delete, and every role list', async () => {
      const { owner, admin: manager, cashier } = await team();

      const created = await call('POST', '/v1/categories', manager, { name: '  Granos ' });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ name: 'Granos' });
      expect(created.headers.get('cache-control')).toBe('no-store');

      const renamed = await call('PATCH', `/v1/categories/${created.body.id}`, owner, {
        name: 'Cereales',
      });
      expect(renamed.body.name).toBe('Cereales');

      for (const token of [owner, manager, cashier]) {
        const listed = await call('GET', '/v1/categories', token);
        expect(listed.status).toBe(200);
        expect(listed.body.items.map((c) => c.name)).toEqual(['Cereales']);
        expect(listed.body.nextCursor).toBeNull();
      }

      const removed = await call('DELETE', `/v1/categories/${created.body.id}`, manager);
      expect(removed.status).toBe(204);
      expect((await call('GET', '/v1/categories', owner)).body.items).toEqual([]);
    });

    it('does not let a cashier change the categories', async () => {
      const { owner, cashier } = await team();
      const created = await call('POST', '/v1/categories', owner, { name: 'Granos' });

      const attempts = [
        await call('POST', '/v1/categories', cashier, { name: 'Otra' }),
        await call('PATCH', `/v1/categories/${created.body.id}`, cashier, { name: 'Otra' }),
        await call('DELETE', `/v1/categories/${created.body.id}`, cashier),
      ];

      for (const attempt of attempts) {
        expect(attempt.status).toBe(403);
        expect(attempt.body.code).toBe('forbidden');
      }
    });

    it('keeps the name unique whatever its case', async () => {
      const { owner } = await team();
      await call('POST', '/v1/categories', owner, { name: 'Granos' });

      const again = await call('POST', '/v1/categories', owner, { name: 'GRANOS' });

      expect(again.status).toBe(409);
      expect(again.body.code).toBe('category-name-taken');
    });

    it('will not delete a category that still has products, until they move', async () => {
      const { owner } = await team();
      const granos = (await call('POST', '/v1/categories', owner, { name: 'Granos' })).body;
      const product = await create(owner, { categoryId: granos.id });

      const blocked = await call('DELETE', `/v1/categories/${granos.id}`, owner);
      expect(blocked.status).toBe(409);
      expect(blocked.body.code).toBe('category-in-use');

      await call('PATCH', `/v1/products/${product.id}`, owner, { categoryId: null });
      expect((await call('DELETE', `/v1/categories/${granos.id}`, owner)).status).toBe(204);
    });

    it('walks the list in pages by following the cursor', async () => {
      const { owner } = await team();
      for (const name of ['Dulces', 'Aseo', 'Bebidas', 'Granos', 'Carnes']) {
        await call('POST', '/v1/categories', owner, { name });
      }

      const first = await call('GET', '/v1/categories?limit=2', owner);
      const second = await call(
        'GET',
        `/v1/categories?limit=2&cursor=${encodeURIComponent(first.body.nextCursor!)}`,
        owner,
      );
      const third = await call(
        'GET',
        `/v1/categories?limit=2&cursor=${encodeURIComponent(second.body.nextCursor!)}`,
        owner,
      );

      expect(first.body.items.map((c) => c.name)).toEqual(['Aseo', 'Bebidas']);
      expect(second.body.items.map((c) => c.name)).toEqual(['Carnes', 'Dulces']);
      expect(third.body.items.map((c) => c.name)).toEqual(['Granos']);
      expect(third.body.nextCursor).toBeNull();
    });

    it('says there is no such category for an unknown id, a malformed id and another business', async () => {
      const { owner } = await team();
      const other = await team();
      const foreign = (await call('POST', '/v1/categories', other.owner, { name: 'Ajena' })).body;

      for (const id of [randomUUID(), 'no-es-un-uuid', foreign.id]) {
        const renamed = await call('PATCH', `/v1/categories/${id}`, owner, { name: 'X' });
        const removed = await call('DELETE', `/v1/categories/${id}`, owner);
        expect([renamed.status, renamed.body.code]).toEqual([404, 'category-not-found']);
        expect([removed.status, removed.body.code]).toEqual([404, 'category-not-found']);
      }
      expect((await call('GET', '/v1/categories', other.owner)).body.items).toHaveLength(1);
    });

    it('needs a token', async () => {
      expect((await call('GET', '/v1/categories')).status).toBe(401);
    });
  });

  describe('products', () => {
    it('lets the management create a product, and hands it back with the price in whole pesos', async () => {
      const { admin: manager } = await team();

      const created = await create(manager, { barcode: UPC_A, minStockMilli: 2500 });

      expect(created).toMatchObject({
        name: 'Arroz 500 g',
        sku: 'ARR-500',
        barcode: UPC_A,
        unit: 'unit',
        unitPrice: 3200,
        taxRateBp: 0,
        taxKind: 'exempt',
        active: true,
        categoryId: null,
        minStockMilli: 2500,
      });
      expect(Number.isInteger(created.unitPrice)).toBe(true);
      expect(new Date(created.createdAt).toISOString()).toBe(created.createdAt);
    });

    it('lets every role look at the catalog, and only the management change it', async () => {
      const { owner, admin: manager, cashier } = await team();
      const created = await create(owner);

      for (const token of [owner, manager, cashier]) {
        const listed = await call('GET', '/v1/products', token);
        expect(listed.body.items.map((p) => p.sku)).toEqual(['ARR-500']);
        const single = await call('GET', `/v1/products/${created.id}`, token);
        expect(single.body).toEqual(created);
      }

      const forbidden = [
        await call('POST', '/v1/products', cashier, { ...arroz, sku: 'OTRO' }),
        await call('PATCH', `/v1/products/${created.id}`, cashier, { unitPrice: 1 }),
        await call('PATCH', `/v1/products/${created.id}`, cashier, { active: false }),
      ];
      for (const attempt of forbidden) {
        expect(attempt.status).toBe(403);
      }
      expect((await call('GET', `/v1/products/${created.id}`, owner)).body.unitPrice).toBe(3200);
    });

    it('lists every problem of a bad product at once, each with its pointer', async () => {
      const { owner } = await team();

      const reply = await call('POST', '/v1/products', owner, {
        name: '',
        sku: 'mal é',
        barcode: '123',
        unit: 'box',
        unitPrice: -1,
        taxRateBp: 7,
        taxKind: 'taxed',
        categoryId: 'x',
        minStockMilli: -3,
        extra: true,
      });

      expect(reply.status).toBe(400);
      expect(reply.body.code).toBe('validation-failed');
      expect(reply.body.errors.map((e) => `${e.pointer}:${e.code}`)).toEqual([
        '/extra:unknown-field',
        '/name:blank',
        '/sku:invalid-sku',
        '/barcode:invalid-barcode',
        '/unit:invalid-value',
        '/unitPrice:out-of-range',
        '/taxRateBp:invalid-value',
        '/categoryId:invalid-id',
        '/minStockMilli:out-of-range',
      ]);
    });

    describe('the tax kind (ADR 0034)', () => {
      it.each([
        ['taxed', 1900],
        ['taxed', 500],
        ['exempt', 0],
        ['excluded', 0],
      ])(
        'keeps a product that is %s at %i basis points, in the reading and in the list',
        async (taxKind, taxRateBp) => {
          const { owner } = await team();

          const created = await create(owner, { taxKind, taxRateBp });

          expect(created).toMatchObject({ taxKind, taxRateBp });
          expect((await call('GET', `/v1/products/${created.id}`, owner)).body).toMatchObject({
            taxKind,
            taxRateBp,
          });
          expect((await call('GET', '/v1/products', owner)).body.items[0]).toMatchObject({
            taxKind,
            taxRateBp,
          });
        },
      );

      it('refuses a kind that does not fit the rate, as a problem of the kind', async () => {
        const { owner } = await team();

        const reply = await call('POST', '/v1/products', owner, {
          ...arroz,
          taxKind: 'taxed',
          taxRateBp: 0,
        });

        expect(reply.status).toBe(400);
        expect(reply.body.errors).toEqual([
          {
            pointer: '/taxKind',
            code: 'tax-kind-rate-mismatch',
            detail:
              'El tipo gravado lleva una tarifa de 5 % o 19 %; el exento y el excluido llevan 0 %.',
          },
        ]);
        expect((await call('GET', '/v1/products', owner)).body.items).toEqual([]);
      });

      it('wants the kind: a product without it is refused, not classified by itself', async () => {
        const { owner } = await team();
        const { taxKind: _kind, ...withoutKind } = arroz;

        const reply = await call('POST', '/v1/products', owner, withoutKind);

        expect(reply.status).toBe(400);
        expect(reply.body.errors.map((e) => `${e.pointer}:${e.code}`)).toEqual([
          '/taxKind:required',
        ]);
      });

      it('moves an exempt product to excluded with the kind alone', async () => {
        const { owner } = await team();
        const created = await create(owner);

        const changed = await call('PATCH', `/v1/products/${created.id}`, owner, {
          taxKind: 'excluded',
        });

        expect(changed.status).toBe(200);
        expect(changed.body).toMatchObject({ taxKind: 'excluded', taxRateBp: 0 });
      });

      it('moves a product to taxed when the kind and the rate come together', async () => {
        const { owner } = await team();
        const created = await create(owner);

        const changed = await call('PATCH', `/v1/products/${created.id}`, owner, {
          taxKind: 'taxed',
          taxRateBp: 1900,
        });

        expect(changed.status).toBe(200);
        expect(changed.body).toMatchObject({ taxKind: 'taxed', taxRateBp: 1900 });
      });

      it('refuses the rate alone when it does not fit the kind the product already has, and changes nothing', async () => {
        const { owner } = await team();
        const created = await create(owner);

        const reply = await call('PATCH', `/v1/products/${created.id}`, owner, {
          taxRateBp: 1900,
        });

        expect(reply.status).toBe(400);
        expect(reply.body.errors.map((e) => `${e.pointer}:${e.code}`)).toEqual([
          '/taxRateBp:tax-kind-rate-mismatch',
        ]);
        expect((await call('GET', `/v1/products/${created.id}`, owner)).body).toMatchObject({
          taxKind: 'exempt',
          taxRateBp: 0,
        });
      });

      it('refuses the kind alone when it does not fit the rate the product already has', async () => {
        const { owner } = await team();
        const created = await create(owner, { taxKind: 'taxed', taxRateBp: 1900 });

        const reply = await call('PATCH', `/v1/products/${created.id}`, owner, {
          taxKind: 'exempt',
        });

        expect(reply.status).toBe(400);
        expect(reply.body.errors.map((e) => `${e.pointer}:${e.code}`)).toEqual([
          '/taxKind:tax-kind-rate-mismatch',
        ]);
      });
    });

    it('keeps the SKU and the barcode unique, whatever the case and whatever the form of the barcode', async () => {
      const { owner } = await team();
      await create(owner, { barcode: UPC_A });

      const sku = await call('POST', '/v1/products', owner, { ...arroz, sku: 'arr-500' });
      const barcode = await call('POST', '/v1/products', owner, {
        ...arroz,
        sku: 'OTRO',
        barcode: EAN_13_OF_THE_UPC_A,
      });

      expect([sku.status, sku.body.code]).toEqual([409, 'sku-taken']);
      expect([barcode.status, barcode.body.code]).toEqual([409, 'barcode-taken']);
    });

    it('lets two businesses use the same SKU and the same barcode', async () => {
      const one = await team();
      const two = await team();

      await create(one.owner, { barcode: UPC_A });
      await expect(create(two.owner, { barcode: UPC_A })).resolves.toBeDefined();
    });

    it('refuses a category that does not exist in the business, as a problem of that field', async () => {
      const { owner } = await team();
      const other = await team();
      const foreign = (await call('POST', '/v1/categories', other.owner, { name: 'Ajena' })).body;

      for (const categoryId of [randomUUID(), foreign.id]) {
        const reply = await call('POST', '/v1/products', owner, { ...arroz, categoryId });
        expect(reply.status).toBe(400);
        expect(reply.body.errors).toEqual([
          {
            pointer: '/categoryId',
            code: 'unknown-category',
            detail: 'No existe esa categoría en este negocio.',
          },
        ]);
      }
    });

    it('changes only what is sent, archives, and clears with null', async () => {
      const { owner } = await team();
      const granos = (await call('POST', '/v1/categories', owner, { name: 'Granos' })).body;
      const created = await create(owner, {
        barcode: UPC_A,
        categoryId: granos.id,
        minStockMilli: 1000,
      });

      const renamed = await call('PATCH', `/v1/products/${created.id}`, owner, {
        name: 'Arroz blanco',
        unitPrice: 3500,
      });
      expect(renamed.body).toMatchObject({
        name: 'Arroz blanco',
        unitPrice: 3500,
        sku: 'ARR-500',
        barcode: UPC_A,
      });
      expect(new Date(renamed.body.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(created.updatedAt).getTime(),
      );

      const archived = await call('PATCH', `/v1/products/${created.id}`, owner, { active: false });
      expect(archived.body.active).toBe(false);

      const cleared = await call('PATCH', `/v1/products/${created.id}`, owner, {
        barcode: null,
        categoryId: null,
        minStockMilli: null,
      });
      expect(cleared.body).toMatchObject({
        barcode: null,
        categoryId: null,
        minStockMilli: null,
        active: false,
      });
    });

    it('asks for at least one change, and refuses a field it does not know', async () => {
      const { owner } = await team();
      const created = await create(owner);

      const empty = await call('PATCH', `/v1/products/${created.id}`, owner, {});
      const unknown = await call('PATCH', `/v1/products/${created.id}`, owner, { price: 5 });

      expect(empty.body.errors[0]?.code).toBe('empty-change');
      expect(unknown.body.errors[0]).toMatchObject({ pointer: '/price', code: 'unknown-field' });
    });

    it('keeps the unit once the product has stock movements (ADR 0015)', async () => {
      const { owner, businessId } = await team();
      const created = await create(owner);
      const before = await call('PATCH', `/v1/products/${created.id}`, owner, { unit: 'kilogram' });
      expect(before.body.unit).toBe('kilogram');

      await recordStockEntry(admin, {
        businessId,
        operationId: randomUUID(),
        productId: created.id,
        delta: 5000,
        reason: 'purchase',
      });

      const locked = await call('PATCH', `/v1/products/${created.id}`, owner, { unit: 'gram' });
      expect([locked.status, locked.body.code]).toEqual([409, 'unit-locked']);
      const sameUnit = await call('PATCH', `/v1/products/${created.id}`, owner, {
        unit: 'kilogram',
        name: 'Arroz',
      });
      expect(sameUnit.status).toBe(200);
      const otherField = await call('PATCH', `/v1/products/${created.id}`, owner, {
        unitPrice: 4000,
      });
      expect(otherField.status).toBe(200);
    });

    it('says there is no such product for an unknown id, a malformed id and another business', async () => {
      const { owner } = await team();
      const other = await team();
      const foreign = await create(other.owner);

      for (const id of [randomUUID(), 'no-es-un-uuid', foreign.id]) {
        const got = await call('GET', `/v1/products/${id}`, owner);
        const patched = await call('PATCH', `/v1/products/${id}`, owner, { name: 'X' });
        expect([got.status, got.body.code]).toEqual([404, 'product-not-found']);
        expect([patched.status, patched.body.code]).toEqual([404, 'product-not-found']);
      }
      expect((await call('GET', `/v1/products/${foreign.id}`, other.owner)).body.name).toBe(
        'Arroz 500 g',
      );
    });

    it('never lists the products of another business', async () => {
      const one = await team();
      const two = await team();
      await create(one.owner, { sku: 'UNO', name: 'Del uno' });
      await create(two.owner, { sku: 'DOS', name: 'Del dos' });

      expect((await call('GET', '/v1/products', one.owner)).body.items.map((p) => p.sku)).toEqual([
        'UNO',
      ]);
      expect((await call('GET', '/v1/products?search=dos', one.owner)).body.items).toEqual([]);
    });
  });

  describe('looking for products', () => {
    const fill = async () => {
      const t = await team();
      const granos = (await call('POST', '/v1/categories', t.owner, { name: 'Granos' })).body;
      await create(t.owner, {
        name: 'Arroz 500 g',
        sku: 'ARR-500',
        categoryId: granos.id,
        barcode: UPC_A,
      });
      await create(t.owner, { name: 'Azúcar 1 kg', sku: 'AZU-1K' });
      await create(t.owner, { name: 'Leche 100% entera', sku: 'LEC_1L' });
      await create(t.owner, { name: 'Caja\\azul', sku: 'CAJ-1' });
      const archived = await create(t.owner, { name: 'Aceite', sku: 'ACE-1L' });
      await call('PATCH', `/v1/products/${archived.id}`, t.owner, { active: false });
      return { ...t, granos };
    };
    const skus = async (token: string, query: string) =>
      (await call('GET', `/v1/products${query}`, token)).body.items.map((p) => p.sku);

    it('lists by name, the same for every role', async () => {
      const { cashier } = await fill();

      expect(await skus(cashier, '')).toEqual(['ACE-1L', 'ARR-500', 'AZU-1K', 'CAJ-1', 'LEC_1L']);
    });

    it('searches a part of the name or the SKU, whatever the case', async () => {
      const { cashier } = await fill();

      expect(await skus(cashier, '?search=arr')).toEqual(['ARR-500']);
      expect(await skus(cashier, '?search=LECHE')).toEqual(['LEC_1L']);
      expect(await skus(cashier, '?search=-1l')).toEqual(['ACE-1L']);
    });

    it('finds a product by its whole barcode', async () => {
      const { cashier } = await fill();

      expect(await skus(cashier, `?search=${UPC_A}`)).toEqual(['ARR-500']);
    });

    it('takes % _ and the backslash in the search as the characters they are', async () => {
      const { cashier } = await fill();

      expect(await skus(cashier, `?search=${encodeURIComponent('%')}`)).toEqual(['LEC_1L']);
      expect(await skus(cashier, `?search=${encodeURIComponent('_')}`)).toEqual(['LEC_1L']);
      expect(await skus(cashier, `?search=${encodeURIComponent('\\')}`)).toEqual(['CAJ-1']);
      expect(await skus(cashier, `?search=${encodeURIComponent('A_R')}`)).toEqual([]);
    });

    it('filters by category and by whether it is active', async () => {
      const { cashier, granos } = await fill();

      expect(await skus(cashier, `?categoryId=${granos.id}`)).toEqual(['ARR-500']);
      expect(await skus(cashier, '?active=false')).toEqual(['ACE-1L']);
      expect(await skus(cashier, '?active=true')).toEqual(['ARR-500', 'AZU-1K', 'CAJ-1', 'LEC_1L']);
    });

    it('walks the list in pages by following the cursor', async () => {
      const { owner } = await fill();
      const seen: string[] = [];
      let query = '?limit=2';

      for (let pages = 0; pages < 10; pages += 1) {
        const page = await call('GET', `/v1/products${query}`, owner);
        seen.push(...page.body.items.map((p) => p.sku));
        if (page.body.nextCursor === null) break;
        query = `?limit=2&cursor=${encodeURIComponent(page.body.nextCursor)}`;
      }

      expect(seen).toEqual(['ACE-1L', 'ARR-500', 'AZU-1K', 'CAJ-1', 'LEC_1L']);
    });

    it('refuses a filter it does not understand, every one at once', async () => {
      const { owner } = await fill();

      const reply = await call(
        'GET',
        '/v1/products?active=quizas&categoryId=x&limit=0&cursor=basura',
        owner,
      );

      expect(reply.status).toBe(400);
      expect(reply.body.errors.map((e) => e.pointer)).toEqual([
        '/limit',
        '/cursor',
        '/categoryId',
        '/active',
      ]);
    });
  });

  it('asks a person with no business to open one first', async () => {
    const lone = await newcomer();

    const reply = await call('GET', '/v1/products', lone.token);

    expect(reply.status).toBe(403);
    expect(reply.body.code).toBe('no-membership');
  });
});
