import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applicationUrlOf } from '../../scripts/prepare-database.ts';
import { createPrismaClient } from '../../src/adapters/out/persistence/create-prisma-client.js';
import { PrismaBusinessSetup } from '../../src/adapters/out/persistence/prisma-business-setup.js';
import { PrismaUnitOfWork } from '../../src/adapters/out/persistence/prisma-unit-of-work.js';
import { AlreadyMemberError } from '../../src/domain/model/people-errors.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { select } from './support/sql.js';
import { createAdminPool } from './support/database.js';
import { BUSINESS_A, resetData, seedBusiness } from './support/seed.js';

/**
 * Abrir un negocio contra PostgreSQL (ADR 0023): el negocio, su primera sucursal, su primera bodega y quien lo abre, como
 * dueno, nacen en UNA transaccion con el rol real de la aplicacion.
 */
describe('opening a business against PostgreSQL (ADR 0023)', () => {
  let admin: pg.Pool;
  let prisma: PrismaClient;
  let setup: PrismaBusinessSetup;
  let unitOfWork: PrismaUnitOfWork;

  const count = async (table: string): Promise<number> =>
    (await admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n;

  const owner = (
    overrides: Partial<{ authUserId: string; email: string | null; fullName: string }> = {},
  ) => ({
    authUserId: randomUUID(),
    email: 'ana@ejemplo.co' as string | null,
    fullName: 'Ana Gómez',
    ...overrides,
  });

  beforeAll(() => {
    admin = createAdminPool(2);
    prisma = createPrismaClient(applicationUrlOf(process.env['TEST_DATABASE_URL']!), { max: 3 });
    unitOfWork = new PrismaUnitOfWork(prisma);
    setup = new PrismaBusinessSetup(unitOfWork);
  });

  beforeEach(async () => {
    await resetData(admin);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await admin.end();
  });

  it('creates the business with its first branch, its first warehouse and its owner', async () => {
    const person = owner();

    const created = await setup.createBusiness({
      businessName: 'Tienda La Esquina',
      owner: person,
    });

    const business = await select(admin, 'SELECT id, name FROM business');
    expect(business).toEqual([{ id: created.businessId, name: 'Tienda La Esquina' }]);
    const branches = await select(admin, 'SELECT id, id_negocio, name FROM branch');
    expect(branches).toEqual([
      { id: expect.any(String), id_negocio: created.businessId, name: 'Principal' },
    ]);
    const warehouses = await select(admin, 'SELECT id_negocio, branch_id, name FROM warehouse');
    expect(warehouses).toEqual([
      { id_negocio: created.businessId, branch_id: branches[0]!['id'], name: 'Principal' },
    ]);
    const users = await select(
      admin,
      'SELECT id, id_negocio, auth_user_id, email, full_name, role, active, invitation_hash FROM app_user',
    );
    expect(users).toEqual([
      {
        id: created.userId,
        id_negocio: created.businessId,
        auth_user_id: person.authUserId,
        email: 'ana@ejemplo.co',
        full_name: 'Ana Gómez',
        role: 'owner',
        active: true,
        invitation_hash: null,
      },
    ]);
  });

  it('opens it without an email when the identity has none', async () => {
    const created = await setup.createBusiness({
      businessName: 'Tienda',
      owner: owner({ email: null }),
    });

    const row = (
      await select(admin, 'SELECT email FROM app_user WHERE id = $1', [created.userId])
    )[0]!;
    expect(row.email).toBeNull();
  });

  it('gives each business its own identifiers and keeps them apart', async () => {
    const first = await setup.createBusiness({ businessName: 'Uno', owner: owner() });
    const second = await setup.createBusiness({ businessName: 'Dos', owner: owner() });

    expect(first.businessId).not.toBe(second.businessId);
    expect(await count('business')).toBe(2);
    expect(await count('branch')).toBe(2);
    expect(await count('warehouse')).toBe(2);
    const seenByFirst = await unitOfWork.inBusiness(first.businessId, (scope) =>
      scope.people.list({ limit: 10 }),
    );
    expect(seenByFirst.map((p) => p.id)).toEqual([first.userId]);
  });

  it('leaves the owner able to work in the new business right away', async () => {
    const created = await setup.createBusiness({ businessName: 'Tienda', owner: owner() });

    const business = await unitOfWork.inBusiness(created.businessId, (scope) =>
      scope.business.current(),
    );

    expect(business).toEqual({ id: created.businessId, name: 'Tienda' });
  });

  it('refuses a person who already belongs to a business, and leaves no second business behind', async () => {
    const existing = await seedBusiness(admin, BUSINESS_A);
    const authUserId = (
      await select(admin, 'SELECT auth_user_id FROM app_user WHERE id = $1', [existing.ownerId])
    )[0]!.auth_user_id as string;

    await expect(
      setup.createBusiness({ businessName: 'Otro', owner: owner({ authUserId }) }),
    ).rejects.toBeInstanceOf(AlreadyMemberError);

    expect(await count('business')).toBe(1);
    expect(await count('branch')).toBe(1);
    expect(await count('warehouse')).toBe(1);
    expect(await count('app_user')).toBe(1);
  });

  it('leaves nothing behind when the last step fails', async () => {
    // El nombre con espacios alrededor no pasa la restriccion de la base, y es lo ULTIMO que se escribe.
    await expect(
      setup.createBusiness({
        businessName: 'Tienda',
        owner: owner({ fullName: ' con espacios ' }),
      }),
    ).rejects.toThrow();

    expect(await count('business')).toBe(0);
    expect(await count('branch')).toBe(0);
    expect(await count('warehouse')).toBe(0);
    expect(await count('app_user')).toBe(0);
  });

  it('opens two businesses at once for two people without mixing them', async () => {
    const results = await Promise.all(
      ['Uno', 'Dos', 'Tres'].map((name) =>
        setup.createBusiness({ businessName: name, owner: owner() }),
      ),
    );

    expect(new Set(results.map((r) => r.businessId)).size).toBe(3);
    expect(await count('business')).toBe(3);
    expect(await count('app_user')).toBe(3);
  });
});
