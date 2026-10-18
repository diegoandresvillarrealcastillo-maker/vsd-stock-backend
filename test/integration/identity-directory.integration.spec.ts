import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applicationUrlOf } from '../../scripts/prepare-database.ts';
import { createPrismaClient } from '../../src/adapters/out/persistence/create-prisma-client.js';
import { PrismaIdentityDirectory } from '../../src/adapters/out/persistence/prisma-identity-directory.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { createAdminPool } from './support/database.js';
import { BUSINESS_A, BUSINESS_B, resetData, seedBusiness } from './support/seed.js';

/**
 * Saber a que negocio pertenece una persona ANTES de conocer el negocio (ADR 0021, punto 7 y ADR 0022), con el rol real
 * de la aplicacion: la base solo deja ver la fila propia, y el contexto de identidad no se queda en la conexion.
 */
describe('the identity directory against PostgreSQL', () => {
  let admin: pg.Pool;
  let prisma: PrismaClient;
  let directory: PrismaIdentityDirectory;

  const authUserOf = async (userId: string): Promise<string> =>
    (
      await admin.query<{ auth_user_id: string }>(
        'SELECT auth_user_id FROM app_user WHERE id = $1',
        [userId],
      )
    ).rows[0]!.auth_user_id;

  beforeAll(() => {
    admin = createAdminPool(2);
    prisma = createPrismaClient(applicationUrlOf(process.env['TEST_DATABASE_URL']!), { max: 1 });
    directory = new PrismaIdentityDirectory(prisma);
  });

  beforeEach(async () => {
    await resetData(admin);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await admin.end();
  });

  it('gives a person their business, their role and their name', async () => {
    const a = await seedBusiness(admin, BUSINESS_A);

    const membership = await directory.findMembership(await authUserOf(a.ownerId));

    expect(membership).toEqual({
      userId: a.ownerId,
      businessId: BUSINESS_A,
      role: 'owner',
      active: true,
      fullName: 'Dueña',
    });
  });

  it('gives each person their own business, never the other one', async () => {
    const a = await seedBusiness(admin, BUSINESS_A);
    const b = await seedBusiness(admin, BUSINESS_B);

    const ofA = await directory.findMembership(await authUserOf(a.ownerId));
    const ofB = await directory.findMembership(await authUserOf(b.ownerId));

    expect(ofA?.businessId).toBe(BUSINESS_A);
    expect(ofB?.businessId).toBe(BUSINESS_B);
  });

  it('says null for a person who signed in but belongs to no business', async () => {
    await seedBusiness(admin, BUSINESS_A);

    expect(await directory.findMembership(randomUUID())).toBeNull();
  });

  it('keeps a deactivated person visible, flagged inactive, so that the API can refuse them with the right error', async () => {
    const a = await seedBusiness(admin, BUSINESS_A);
    await admin.query(
      "UPDATE app_user SET active = false, deactivated_at = now(), role = 'cashier' WHERE id = $1",
      [a.ownerId],
    );

    const membership = await directory.findMembership(await authUserOf(a.ownerId));

    expect(membership).toMatchObject({ active: false, role: 'cashier' });
  });

  it('never matches a pending invitation, which has no identity yet', async () => {
    const a = await seedBusiness(admin, BUSINESS_A);
    await admin.query(
      `INSERT INTO app_user (id_negocio, full_name, role, invitation_hash, invitation_expires_at)
       VALUES ($1, 'Pendiente', 'cashier', 'abc', now() + interval '1 day')`,
      [a.businessId],
    );

    expect(await directory.findMembership(randomUUID())).toBeNull();
  });

  it('does not leave the identity context behind on the connection', async () => {
    const a = await seedBusiness(admin, BUSINESS_A);
    await directory.findMembership(await authUserOf(a.ownerId));

    // La misma y unica conexion, ya sin transaccion: el contexto se fue con ella.
    expect(await prisma.appUser.findMany()).toEqual([]);
  });

  it('refuses an identifier that is not a UUID before touching the database', async () => {
    await expect(directory.findMembership("'; DROP TABLE app_user; --")).rejects.toThrow(
      'not a valid identity identifier',
    );
  });
});
