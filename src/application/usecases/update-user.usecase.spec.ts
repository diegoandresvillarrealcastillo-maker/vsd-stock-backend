import { describe, expect, it } from 'vitest';
import {
  ForbiddenError,
  LastOwnerError,
  NoMembershipError,
  PersonNotFoundError,
} from '../../domain/model/people-errors.js';
import { ValidationFailedError } from '../../domain/model/validation.js';
import { UserInactiveError } from '../../domain/ports/in/authenticate.js';
import { FakePeople, fakeUnitOfWork, person } from '../../../test/support/fake-people.js';
import {
  ACTOR_ID,
  BUSINESS_ID,
  loneSession,
  memberSession,
} from '../../../test/support/sessions.js';
import { UpdateUserUseCase } from './update-user.usecase.js';

const OTHER_OWNER = '33333333-3333-4333-8333-333333333333';
const ADMIN = '44444444-4444-4444-8444-444444444444';
const CASHIER = '55555555-5555-4555-8555-555555555555';
const PENDING = '66666666-6666-4666-8666-666666666666';

/** Un negocio con un dueno (quien actua), otro dueno, un administrador, un cajero y una invitacion pendiente. */
const setup = (options: { secondOwner?: boolean } = {}) => {
  const people = new FakePeople([
    person({ id: ACTOR_ID, fullName: 'Ana Gómez', role: 'owner' }),
    ...(options.secondOwner === false
      ? []
      : [person({ id: OTHER_OWNER, fullName: 'Omar', role: 'owner' })]),
    person({ id: ADMIN, fullName: 'Adela', role: 'admin' }),
    person({ id: CASHIER, fullName: 'Carlos', role: 'cashier' }),
    person({
      id: PENDING,
      fullName: 'Paula',
      role: 'cashier',
      bound: false,
      invitationExpiresAt: new Date('2026-10-20T00:00:00Z'),
    }),
  ]);
  const work = fakeUnitOfWork(people);
  return { people, work, useCase: new UpdateUserUseCase(work) };
};

const stored = (people: FakePeople, id: string) => people.records.find((p) => p.id === id);

describe('UpdateUserUseCase', () => {
  describe('what a manager can do with a cashier', () => {
    it('renames them', async () => {
      const { people, useCase } = setup();

      const view = await useCase.execute(memberSession('admin'), CASHIER, {
        fullName: '  Carlos Ruiz ',
      });

      expect(view).toMatchObject({
        id: CASHIER,
        fullName: 'Carlos Ruiz',
        role: 'cashier',
        status: 'active',
      });
      expect(stored(people, CASHIER)?.fullName).toBe('Carlos Ruiz');
    });

    it('deactivates them, and reactivates them', async () => {
      const { people, useCase } = setup();

      const off = await useCase.execute(memberSession('admin'), CASHIER, { active: false });
      expect(off.status).toBe('inactive');
      expect(stored(people, CASHIER)?.active).toBe(false);

      const on = await useCase.execute(memberSession('admin'), CASHIER, { active: true });
      expect(on.status).toBe('active');
    });

    it('revokes a pending invitation by deactivating it', async () => {
      const { useCase } = setup();

      const view = await useCase.execute(memberSession('admin'), PENDING, { active: false });

      expect(view.status).toBe('inactive');
    });

    it('changes only what was sent', async () => {
      const { people, useCase } = setup();

      await useCase.execute(memberSession('admin'), CASHIER, { active: false });

      expect(stored(people, CASHIER)).toMatchObject({
        fullName: 'Carlos',
        role: 'cashier',
        active: false,
      });
    });
  });

  describe('what only the owner can do (ADR 0017)', () => {
    it('promotes a cashier to administrator, and an administrator can not', async () => {
      const { people, useCase } = setup();

      await expect(
        useCase.execute(memberSession('admin'), CASHIER, { role: 'admin' }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(stored(people, CASHIER)?.role).toBe('cashier');

      const view = await useCase.execute(memberSession('owner'), CASHIER, { role: 'admin' });
      expect(view.role).toBe('admin');
    });

    it('changes an administrator, and an administrator can not touch one', async () => {
      const { people, useCase } = setup();

      await expect(
        useCase.execute(memberSession('admin'), ADMIN, { active: false }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(stored(people, ADMIN)?.active).toBe(true);

      await expect(
        useCase.execute(memberSession('owner'), ADMIN, { active: false }),
      ).resolves.toBeDefined();
    });

    it('lets an administrator not touch an owner', async () => {
      const { people, useCase } = setup();

      await expect(
        useCase.execute(memberSession('admin'), OTHER_OWNER, { active: false }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(stored(people, OTHER_OWNER)?.active).toBe(true);
    });

    it('lets an administrator not rename themselves either: managing an administrator is for the owner', async () => {
      const { useCase } = setup();

      await expect(
        useCase.execute(memberSession('admin'), ADMIN, { fullName: 'Otro' }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('names a second owner', async () => {
      const { people, useCase } = setup();

      await useCase.execute(memberSession('owner'), ADMIN, { role: 'owner' });

      expect(stored(people, ADMIN)?.role).toBe('owner');
    });
  });

  describe('the last owner (ADR 0017)', () => {
    it('can step down when another owner remains', async () => {
      const { people, useCase } = setup();

      await useCase.execute(memberSession('owner'), ACTOR_ID, { role: 'admin' });

      expect(stored(people, ACTOR_ID)?.role).toBe('admin');
    });

    it('can be deactivated when another owner remains', async () => {
      const { useCase } = setup();

      await expect(
        useCase.execute(memberSession('owner'), ACTOR_ID, { active: false }),
      ).resolves.toBeDefined();
    });

    it('can not be demoted when it is the only one', async () => {
      const { people, useCase } = setup({ secondOwner: false });

      await expect(
        useCase.execute(memberSession('owner'), ACTOR_ID, { role: 'admin' }),
      ).rejects.toBeInstanceOf(LastOwnerError);
      expect(stored(people, ACTOR_ID)?.role).toBe('owner');
    });

    it('can not be deactivated when it is the only one', async () => {
      const { people, useCase } = setup({ secondOwner: false });

      await expect(
        useCase.execute(memberSession('owner'), ACTOR_ID, { active: false }),
      ).rejects.toBeInstanceOf(LastOwnerError);
      expect(stored(people, ACTOR_ID)?.active).toBe(true);
    });

    it('can still be renamed when it is the only one', async () => {
      const { useCase } = setup({ secondOwner: false });

      const view = await useCase.execute(memberSession('owner'), ACTOR_ID, {
        fullName: 'Ana María',
      });

      expect(view.fullName).toBe('Ana María');
    });

    it('counts the owners under lock, so two changes at once can not leave none', async () => {
      const { people, useCase } = setup();

      await useCase.execute(memberSession('owner'), CASHIER, { fullName: 'Carlos Ruiz' });

      expect(people.ownerLocks).toBe(1);
    });
  });

  describe('who can ask', () => {
    it('refuses a cashier before looking at what they sent', async () => {
      const { people, useCase } = setup();

      await expect(
        useCase.execute(memberSession('cashier'), CASHIER, { basura: 1 }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(people.ownerLocks).toBe(0);
    });

    it('refuses a person with no business, and one who was deactivated', async () => {
      const { useCase } = setup();

      await expect(
        useCase.execute(loneSession(), CASHIER, { active: false }),
      ).rejects.toBeInstanceOf(NoMembershipError);
      await expect(
        useCase.execute(memberSession('owner', { active: false }), CASHIER, { active: false }),
      ).rejects.toBeInstanceOf(UserInactiveError);
    });

    it('works inside the business of the person who asks', async () => {
      const { work, useCase } = setup();

      await useCase.execute(memberSession('owner'), CASHIER, { active: false });

      expect(work.openedFor).toEqual([BUSINESS_ID]);
    });
  });

  describe('what was sent', () => {
    it('asks for at least one change', async () => {
      const { people, useCase } = setup();

      const failure = await useCase
        .execute(memberSession('owner'), CASHIER, {})
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ValidationFailedError);
      expect((failure as ValidationFailedError).errors).toEqual([
        { pointer: '', code: 'empty-change', detail: 'Indica al menos un dato para cambiar.' },
      ]);
      expect(people.ownerLocks).toBe(0);
    });

    it('reports every problem together', async () => {
      const { useCase } = setup();

      const failure = await useCase
        .execute(memberSession('owner'), CASHIER, {
          fullName: '',
          role: 'rey',
          active: 'si',
          extra: 1,
        })
        .catch((error: unknown) => error);

      expect(
        (failure as ValidationFailedError).errors.map((e) => `${e.pointer}:${e.code}`),
      ).toEqual([
        '/extra:unknown-field',
        '/fullName:blank',
        '/role:invalid-value',
        '/active:invalid-type',
      ]);
    });

    it('does not take the email or the invitation as something to change', async () => {
      const { useCase } = setup();

      const failure = await useCase
        .execute(memberSession('owner'), CASHIER, { email: 'otro@ejemplo.co', invitationHash: 'x' })
        .catch((error: unknown) => error);

      expect((failure as ValidationFailedError).errors.map((e) => e.code)).toEqual([
        'unknown-field',
        'unknown-field',
        'empty-change',
      ]);
    });

    it('says there is no such person when the id is not in this business', async () => {
      const { useCase } = setup();

      await expect(
        useCase.execute(memberSession('owner'), '99999999-9999-4999-8999-999999999999', {
          active: false,
        }),
      ).rejects.toBeInstanceOf(PersonNotFoundError);
    });

    it.each(['no-es-un-uuid', '', "x'; DROP TABLE app_user;--"])(
      'says there is no such person for %j, without asking the database',
      async (id) => {
        const { work, useCase } = setup();

        await expect(
          useCase.execute(memberSession('owner'), id, { active: false }),
        ).rejects.toBeInstanceOf(PersonNotFoundError);
        expect(work.openedFor).toEqual([]);
      },
    );
  });
});
