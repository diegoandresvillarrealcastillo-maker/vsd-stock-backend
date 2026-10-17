import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applicationUrlOf } from '../../scripts/prepare-database.ts';
import { createPrismaClient } from '../../src/adapters/out/persistence/create-prisma-client.js';
import { PrismaUnitOfWork } from '../../src/adapters/out/persistence/prisma-unit-of-work.js';
import { UpdateUserUseCase } from '../../src/application/usecases/update-user.usecase.js';
import { LastOwnerError } from '../../src/domain/model/people-errors.js';
import type { Session } from '../../src/domain/ports/in/authenticate.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { select } from './support/sql.js';
import { createAdminPool } from './support/database.js';
import {
  BUSINESS_A,
  BUSINESS_B,
  resetData,
  seedBusiness,
  type SeededBusiness,
} from './support/seed.js';

/**
 * Las personas de un negocio contra PostgreSQL (ADR 0023), con el rol real de la aplicacion: lo que lista, invita, renueva y
 * cambia, sin salir del negocio, y que dos cambios a la vez no dejen a un negocio sin dueno.
 */
describe('the people of a business against PostgreSQL (ADR 0023)', () => {
  let admin: pg.Pool;
  let prisma: PrismaClient;
  let unitOfWork: PrismaUnitOfWork;
  let a: SeededBusiness;
  let b: SeededBusiness;

  /** Una persona ya ligada a una identidad, escrita con la conexion de administracion. */
  const seedPerson = async (
    businessId: string,
    fullName: string,
    role: 'owner' | 'admin' | 'cashier' = 'cashier',
    active = true,
  ): Promise<string> => {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO app_user (id, id_negocio, auth_user_id, full_name, role, active)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, businessId, randomUUID(), fullName, role, active],
    );
    return id;
  };

  beforeAll(() => {
    admin = createAdminPool(3);
    // Pocas conexiones a proposito: asi las transacciones concurrentes de la prueba compiten de verdad.
    prisma = createPrismaClient(applicationUrlOf(process.env['TEST_DATABASE_URL']!), { max: 4 });
    unitOfWork = new PrismaUnitOfWork(prisma);
  });

  beforeEach(async () => {
    await resetData(admin);
    a = await seedBusiness(admin, BUSINESS_A);
    b = await seedBusiness(admin, BUSINESS_B);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await admin.end();
  });

  describe('listing', () => {
    it('lists the people of the business by name, and never those of another', async () => {
      await seedPerson(BUSINESS_A, 'Zoe');
      await seedPerson(BUSINESS_A, 'Beto', 'admin');
      await seedPerson(BUSINESS_B, 'Ajena');

      const listed = await unitOfWork.inBusiness(BUSINESS_A, (scope) =>
        scope.people.list({ limit: 10 }),
      );

      expect(listed.map((p) => p.fullName)).toEqual(['Beto', 'Dueña', 'Zoe']);
    });

    it('describes each person: role, state, email and when the invitation ends', async () => {
      await admin.query(
        `INSERT INTO app_user (id_negocio, full_name, role, email, invitation_hash, invitation_expires_at)
         VALUES ($1, 'Pendiente', 'cashier', 'p@ejemplo.co', 'hash-1', '2026-12-01T00:00:00Z')`,
        [BUSINESS_A],
      );

      const listed = await unitOfWork.inBusiness(BUSINESS_A, (scope) =>
        scope.people.list({ limit: 10 }),
      );
      const pending = listed.find((p) => p.fullName === 'Pendiente');

      expect(pending).toMatchObject({
        role: 'cashier',
        active: true,
        bound: false,
        email: 'p@ejemplo.co',
        invitationExpiresAt: new Date('2026-12-01T00:00:00Z'),
      });
      expect(listed.find((p) => p.id === a.ownerId)).toMatchObject({
        bound: true,
        invitationExpiresAt: null,
      });
    });

    it('walks the list in pages with no repeats and no gaps, even with equal names', async () => {
      for (const name of ['Ana', 'Ana', 'Ana', 'Beto', 'Carla']) await seedPerson(BUSINESS_A, name);
      const everyone = await unitOfWork.inBusiness(BUSINESS_A, (scope) =>
        scope.people.list({ limit: 100 }),
      );

      const seen: string[] = [];
      let after: readonly [string, string] | undefined;
      for (let pages = 0; pages < 10; pages += 1) {
        const rows = await unitOfWork.inBusiness(BUSINESS_A, (scope) =>
          scope.people.list({ limit: 2, ...(after ? { after } : {}) }),
        );
        if (rows.length === 0) break;
        seen.push(...rows.map((p) => p.id));
        const last = rows[rows.length - 1]!;
        after = [last.fullName, last.id];
      }

      expect(seen).toEqual(everyone.map((p) => p.id));
      expect(new Set(seen).size).toBe(everyone.length);
    });
  });

  describe('finding', () => {
    it('finds a person of the business', async () => {
      const found = await unitOfWork.inBusiness(BUSINESS_A, (scope) =>
        scope.people.find(a.ownerId),
      );

      expect(found).toMatchObject({ id: a.ownerId, fullName: 'Dueña', role: 'owner' });
    });

    it('does not find a person of another business', async () => {
      const found = await unitOfWork.inBusiness(BUSINESS_A, (scope) =>
        scope.people.find(b.ownerId),
      );

      expect(found).toBeNull();
    });
  });

  describe('inviting', () => {
    const invitation = {
      fullName: 'Luis Pérez',
      email: 'luis@ejemplo.co',
      role: 'cashier',
      invitationHash: 'a'.repeat(64),
      invitationExpiresAt: new Date('2026-12-01T00:00:00Z'),
    } as const;

    it('creates a pending invitation in the business, and keeps only the hash', async () => {
      const created = await unitOfWork.inBusiness(BUSINESS_A, (scope) =>
        scope.people.invite(invitation),
      );

      expect(created).toMatchObject({
        fullName: 'Luis Pérez',
        email: 'luis@ejemplo.co',
        role: 'cashier',
        active: true,
        bound: false,
        invitationExpiresAt: new Date('2026-12-01T00:00:00Z'),
      });
      const row = (
        await select(
          admin,
          'SELECT id_negocio, auth_user_id, invitation_hash FROM app_user WHERE id = $1',
          [created.id],
        )
      )[0]!;
      expect(row).toEqual({
        id_negocio: BUSINESS_A,
        auth_user_id: null,
        invitation_hash: 'a'.repeat(64),
      });
    });

    it('refuses a hash that another invitation already has, in any business', async () => {
      await unitOfWork.inBusiness(BUSINESS_A, (scope) => scope.people.invite(invitation));

      await expect(
        unitOfWork.inBusiness(BUSINESS_B, (scope) => scope.people.invite(invitation)),
      ).rejects.toThrow();
    });

    it('rolls back an invitation when the work fails afterwards', async () => {
      await expect(
        unitOfWork.inBusiness(BUSINESS_A, async (scope) => {
          await scope.people.invite(invitation);
          throw new Error('fallo despues de invitar');
        }),
      ).rejects.toThrow('fallo despues');

      const count = await select(
        admin,
        "SELECT count(*)::int AS n FROM app_user WHERE full_name = 'Luis Pérez'",
      );
      expect(count[0]!['n']).toBe(0);
    });
  });

  describe('renewing an invitation', () => {
    const pendingId = async (businessId = BUSINESS_A, active = true): Promise<string> => {
      const id = randomUUID();
      await admin.query(
        `INSERT INTO app_user (id, id_negocio, full_name, role, active, invitation_hash, invitation_expires_at)
         VALUES ($1, $2, 'Pendiente', 'cashier', $3, $4, '2026-10-01T00:00:00Z')`,
        [id, businessId, active, `viejo-${id}`],
      );
      return id;
    };

    it('replaces the hash and the expiry of a pending invitation', async () => {
      const id = await pendingId();

      const renewed = await unitOfWork.inBusiness(BUSINESS_A, (scope) =>
        scope.people.rotateInvitation(id, 'nuevo-hash', new Date('2026-12-01T00:00:00Z')),
      );

      expect(renewed).toMatchObject({
        id,
        bound: false,
        invitationExpiresAt: new Date('2026-12-01T00:00:00Z'),
      });
      const row = (
        await select(admin, 'SELECT invitation_hash FROM app_user WHERE id = $1', [id])
      )[0]!;
      expect(row.invitation_hash).toBe('nuevo-hash');
    });

    it('does nothing for a person who already redeemed theirs', async () => {
      const renewed = await unitOfWork.inBusiness(BUSINESS_A, (scope) =>
        scope.people.rotateInvitation(a.ownerId, 'nuevo-hash', new Date('2026-12-01T00:00:00Z')),
      );

      expect(renewed).toBeNull();
      const row = (
        await select(admin, 'SELECT invitation_hash FROM app_user WHERE id = $1', [a.ownerId])
      )[0]!;
      expect(row.invitation_hash).toBeNull();
    });

    it('does nothing for a revoked invitation', async () => {
      const id = await pendingId(BUSINESS_A, false);

      const renewed = await unitOfWork.inBusiness(BUSINESS_A, (scope) =>
        scope.people.rotateInvitation(id, 'nuevo-hash', new Date('2026-12-01T00:00:00Z')),
      );

      expect(renewed).toBeNull();
    });

    it('does nothing for an invitation of another business', async () => {
      const id = await pendingId(BUSINESS_B);

      const renewed = await unitOfWork.inBusiness(BUSINESS_A, (scope) =>
        scope.people.rotateInvitation(id, 'nuevo-hash', new Date('2026-12-01T00:00:00Z')),
      );

      expect(renewed).toBeNull();
      const row = (
        await select(admin, 'SELECT invitation_hash FROM app_user WHERE id = $1', [id])
      )[0]!;
      expect(row.invitation_hash).toBe(`viejo-${id}`);
    });
  });

  describe('changing a person', () => {
    it('changes the name, the role and the state, and only what was given', async () => {
      const id = await seedPerson(BUSINESS_A, 'Carlos');

      const updated = await unitOfWork.inBusiness(BUSINESS_A, (scope) =>
        scope.people.update(id, { fullName: 'Carlos Ruiz', role: 'admin' }),
      );

      expect(updated).toMatchObject({ fullName: 'Carlos Ruiz', role: 'admin', active: true });
    });

    it('stamps the moment of deactivation, and clears it when the person comes back', async () => {
      const id = await seedPerson(BUSINESS_A, 'Carlos');
      const deactivatedAt = async (): Promise<unknown> =>
        (await select(admin, 'SELECT deactivated_at FROM app_user WHERE id = $1', [id]))[0]!
          .deactivated_at;

      await unitOfWork.inBusiness(BUSINESS_A, (scope) =>
        scope.people.update(id, { active: false }),
      );
      expect(await deactivatedAt()).toBeInstanceOf(Date);

      await unitOfWork.inBusiness(BUSINESS_A, (scope) => scope.people.update(id, { active: true }));
      expect(await deactivatedAt()).toBeNull();
    });

    it('does not touch the stamp when the change is not about being active', async () => {
      const id = await seedPerson(BUSINESS_A, 'Carlos', 'cashier', false);
      await admin.query(
        "UPDATE app_user SET deactivated_at = '2026-01-01T00:00:00Z' WHERE id = $1",
        [id],
      );

      await unitOfWork.inBusiness(BUSINESS_A, (scope) =>
        scope.people.update(id, { fullName: 'Otro' }),
      );

      const row = (
        await select(admin, 'SELECT deactivated_at FROM app_user WHERE id = $1', [id])
      )[0]!;
      expect(row.deactivated_at).toEqual(new Date('2026-01-01T00:00:00Z'));
    });

    it('can not change a person of another business', async () => {
      await expect(
        unitOfWork.inBusiness(BUSINESS_A, (scope) =>
          scope.people.update(b.ownerId, { active: false }),
        ),
      ).rejects.toThrow();

      const row = (
        await select(admin, 'SELECT active FROM app_user WHERE id = $1', [b.ownerId])
      )[0]!;
      expect(row.active).toBe(true);
    });
  });

  describe('the owners', () => {
    it('lists the active owners of the business, and no one else', async () => {
      const second = await seedPerson(BUSINESS_A, 'Segundo', 'owner');
      await seedPerson(BUSINESS_A, 'Baja', 'owner', false);
      await seedPerson(BUSINESS_A, 'Admin', 'admin');

      const owners = await unitOfWork.inBusiness(BUSINESS_A, (scope) =>
        scope.people.lockActiveOwners(),
      );

      expect(owners).toEqual([a.ownerId, second].sort());
      expect(owners).not.toContain(b.ownerId);
    });

    it('makes two changes at once take turns: the business never ends up with no owner', async () => {
      const update = new UpdateUserUseCase(unitOfWork);
      const session = (userId: string): Session => ({
        identity: {
          subject: randomUUID(),
          email: null,
          expiresAt: new Date('2099-01-01T00:00:00Z'),
        },
        membership: {
          userId,
          businessId: BUSINESS_A,
          role: 'owner',
          active: true,
          fullName: 'Dueña',
        },
      });

      for (let round = 0; round < 15; round += 1) {
        await resetData(admin);
        a = await seedBusiness(admin, BUSINESS_A);
        const second = await seedPerson(BUSINESS_A, 'Segundo', 'owner');

        // Cada dueno se da de baja a si mismo, a la vez.
        const outcomes = await Promise.allSettled([
          update.execute(session(a.ownerId), a.ownerId, { active: false }),
          update.execute(session(second), second, { active: false }),
        ]);

        expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
        const refused = outcomes.find((o) => o.status === 'rejected');
        expect((refused as PromiseRejectedResult).reason).toBeInstanceOf(LastOwnerError);
        const left = await select(
          admin,
          "SELECT count(*)::int AS n FROM app_user WHERE id_negocio = $1 AND role = 'owner' AND active",
          [BUSINESS_A],
        );
        expect(left[0]!['n']).toBe(1);
      }
    });
  });
});
