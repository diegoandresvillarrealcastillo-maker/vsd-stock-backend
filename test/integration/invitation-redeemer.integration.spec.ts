import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applicationUrlOf } from '../../scripts/prepare-database.ts';
import { createPrismaClient } from '../../src/adapters/out/persistence/create-prisma-client.js';
import { PrismaIdentityDirectory } from '../../src/adapters/out/persistence/prisma-identity-directory.js';
import { PrismaInvitationRedeemer } from '../../src/adapters/out/persistence/prisma-invitation-redeemer.js';
import {
  AlreadyMemberError,
  InvitationExpiredError,
  InvitationNotFoundError,
} from '../../src/domain/model/people-errors.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { select } from './support/sql.js';
import { createAdminPool } from './support/database.js';
import { BUSINESS_A, BUSINESS_B, resetData, seedBusiness } from './support/seed.js';

const hashOf = (code: string): string => createHash('sha256').update(code).digest('hex');

/**
 * Canjear una invitacion contra PostgreSQL (ADR 0023), con el rol real de la aplicacion: quien canjea aun no pertenece a
 * ningun negocio, y la base le deja tomar UNA fila, la del hash que conoce, una sola vez.
 */
describe('redeeming an invitation against PostgreSQL (ADR 0023)', () => {
  let admin: pg.Pool;
  let prisma: PrismaClient;
  let redeemer: PrismaInvitationRedeemer;

  const NOW = new Date();
  const IN_A_WEEK = new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000);

  /** Una invitacion pendiente escrita con la conexion de administracion. */
  const seedInvitation = async (
    businessId: string,
    code: string,
    overrides: Partial<{
      role: string;
      fullName: string;
      email: string | null;
      active: boolean;
      expiresAt: Date;
    }> = {},
  ): Promise<string> => {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO app_user (id, id_negocio, full_name, role, email, active, invitation_hash, invitation_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        businessId,
        overrides.fullName ?? 'Luis Pérez',
        overrides.role ?? 'cashier',
        overrides.email ?? null,
        overrides.active ?? true,
        hashOf(code),
        overrides.expiresAt ?? IN_A_WEEK,
      ],
    );
    return id;
  };

  const redemption = (
    code: string,
    overrides: Partial<{ authUserId: string; email: string | null; now: Date }> = {},
  ) => ({
    invitationHash: hashOf(code),
    authUserId: randomUUID(),
    email: 'luis@ejemplo.co' as string | null,
    now: NOW,
    ...overrides,
  });

  const rowOf = async (id: string) =>
    (await select(admin, 'SELECT * FROM app_user WHERE id = $1', [id]))[0]!;

  beforeAll(() => {
    admin = createAdminPool(2);
    prisma = createPrismaClient(applicationUrlOf(process.env['TEST_DATABASE_URL']!), { max: 3 });
    redeemer = new PrismaInvitationRedeemer(prisma);
  });

  beforeEach(async () => {
    await resetData(admin);
    await seedBusiness(admin, BUSINESS_A, 'Tienda A');
    await seedBusiness(admin, BUSINESS_B, 'Tienda B');
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await admin.end();
  });

  it('joins the person to the business of the code, with the role they were invited with', async () => {
    const id = await seedInvitation(BUSINESS_A, 'CODIGO-A', {
      role: 'admin',
      fullName: 'Adela Ruiz',
    });
    const request = redemption('CODIGO-A');

    const redeemed = await redeemer.redeem(request);

    expect(redeemed).toEqual({
      businessId: BUSINESS_A,
      businessName: 'Tienda A',
      userId: id,
      role: 'admin',
      fullName: 'Adela Ruiz',
    });
  });

  it('binds the identity, clears the code and keeps the verified email', async () => {
    const id = await seedInvitation(BUSINESS_A, 'CODIGO-A', {
      email: 'escrito-por-el-admin@ejemplo.co',
    });
    const request = redemption('CODIGO-A', { email: 'verificado@ejemplo.co' });

    await redeemer.redeem(request);

    const row = await rowOf(id);
    expect(row).toMatchObject({
      auth_user_id: request.authUserId,
      invitation_hash: null,
      invitation_expires_at: null,
      email: 'verificado@ejemplo.co',
      active: true,
    });
  });

  it('keeps the email the administrator wrote when the identity brings none', async () => {
    const id = await seedInvitation(BUSINESS_A, 'CODIGO-A', { email: 'escrito@ejemplo.co' });

    await redeemer.redeem(redemption('CODIGO-A', { email: null }));

    expect((await rowOf(id)).email).toBe('escrito@ejemplo.co');
  });

  it('lets the person work right away: the identity directory now finds their business and role', async () => {
    const id = await seedInvitation(BUSINESS_B, 'CODIGO-B', { role: 'cashier' });
    const request = redemption('CODIGO-B');

    await redeemer.redeem(request);

    const membership = await new PrismaIdentityDirectory(prisma).findMembership(request.authUserId);
    expect(membership).toMatchObject({
      userId: id,
      businessId: BUSINESS_B,
      role: 'cashier',
      active: true,
    });
  });

  it('works only once: the same code a second time is not found', async () => {
    await seedInvitation(BUSINESS_A, 'CODIGO-A');
    await redeemer.redeem(redemption('CODIGO-A'));

    await expect(redeemer.redeem(redemption('CODIGO-A'))).rejects.toBeInstanceOf(
      InvitationNotFoundError,
    );
  });

  it('lets only one of two people redeeming the same code at once get it', async () => {
    const id = await seedInvitation(BUSINESS_A, 'CODIGO-A');
    const first = redemption('CODIGO-A');
    const second = redemption('CODIGO-A');

    const outcomes = await Promise.allSettled([redeemer.redeem(first), redeemer.redeem(second)]);

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1);
    expect([first.authUserId, second.authUserId]).toContain((await rowOf(id)).auth_user_id);
  });

  it('does not find a code that never existed', async () => {
    await seedInvitation(BUSINESS_A, 'CODIGO-A');

    await expect(redeemer.redeem(redemption('OTRO-CODIGO'))).rejects.toBeInstanceOf(
      InvitationNotFoundError,
    );
  });

  it('does not find the code of a revoked invitation', async () => {
    await seedInvitation(BUSINESS_A, 'CODIGO-A', { active: false });

    await expect(redeemer.redeem(redemption('CODIGO-A'))).rejects.toBeInstanceOf(
      InvitationNotFoundError,
    );
  });

  it('says an expired code expired, and leaves the invitation as it was', async () => {
    const id = await seedInvitation(BUSINESS_A, 'CODIGO-A', {
      expiresAt: new Date(NOW.getTime() - 60_000),
    });

    await expect(redeemer.redeem(redemption('CODIGO-A'))).rejects.toBeInstanceOf(
      InvitationExpiredError,
    );

    expect(await rowOf(id)).toMatchObject({
      auth_user_id: null,
      invitation_hash: hashOf('CODIGO-A'),
    });
  });

  it('measures the expiry with the clock it is given', async () => {
    await seedInvitation(BUSINESS_A, 'CODIGO-A', { expiresAt: IN_A_WEEK });
    const afterExpiry = new Date(IN_A_WEEK.getTime() + 1);

    await expect(
      redeemer.redeem(redemption('CODIGO-A', { now: afterExpiry })),
    ).rejects.toBeInstanceOf(InvitationExpiredError);
  });

  it('refuses a person who already belongs to a business, and keeps the invitation pending', async () => {
    const existing = await seedBusiness(admin, '33333333-3333-4333-8333-333333333333');
    const authUserId = (await rowOf(existing.ownerId)).auth_user_id as string;
    const id = await seedInvitation(BUSINESS_A, 'CODIGO-A');

    await expect(redeemer.redeem(redemption('CODIGO-A', { authUserId }))).rejects.toBeInstanceOf(
      AlreadyMemberError,
    );

    expect(await rowOf(id)).toMatchObject({
      auth_user_id: null,
      invitation_hash: hashOf('CODIGO-A'),
    });
  });

  it('touches no other invitation, in the same business or in another', async () => {
    const mine = await seedInvitation(BUSINESS_A, 'CODIGO-A');
    const sameBusiness = await seedInvitation(BUSINESS_A, 'CODIGO-B');
    const otherBusiness = await seedInvitation(BUSINESS_B, 'CODIGO-C');

    await redeemer.redeem(redemption('CODIGO-A'));

    expect((await rowOf(mine)).auth_user_id).not.toBeNull();
    expect(await rowOf(sameBusiness)).toMatchObject({
      auth_user_id: null,
      invitation_hash: hashOf('CODIGO-B'),
    });
    expect(await rowOf(otherBusiness)).toMatchObject({
      auth_user_id: null,
      invitation_hash: hashOf('CODIGO-C'),
    });
  });

  it.each(['', 'no-es-un-uuid', "'; DROP TABLE app_user; --"])(
    'rejects the identity %j before touching the database',
    async (authUserId) => {
      await expect(redeemer.redeem(redemption('CODIGO-A', { authUserId }))).rejects.toThrow(
        RangeError,
      );
    },
  );
});
