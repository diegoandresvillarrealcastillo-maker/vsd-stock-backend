import { describe, expect, it } from 'vitest';
import {
  ForbiddenError,
  InvitationNotPendingError,
  NoMembershipError,
  PersonNotFoundError,
} from '../../domain/model/people-errors.js';
import { UserInactiveError } from '../../domain/ports/in/authenticate.js';
import { FakeCodes, NOW, fixedClock } from '../../../test/support/fake-codes.js';
import { FakePeople, fakeUnitOfWork, person } from '../../../test/support/fake-people.js';
import { BUSINESS_ID, loneSession, memberSession } from '../../../test/support/sessions.js';
import { RegenerateInvitationUseCase } from './regenerate-invitation.usecase.js';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const PENDING_CASHIER = '66666666-6666-4666-8666-666666666666';
const PENDING_ADMIN = '77777777-7777-4777-8777-777777777777';
const BOUND_CASHIER = '88888888-8888-4888-8888-888888888888';
const REVOKED_CASHIER = '99999999-9999-4999-8999-999999999999';

const setup = () => {
  const people = new FakePeople([
    person({
      id: PENDING_CASHIER,
      bound: false,
      invitationExpiresAt: new Date('2026-10-01T00:00:00Z'),
    }),
    person({
      id: PENDING_ADMIN,
      role: 'admin',
      bound: false,
      invitationExpiresAt: new Date('2026-10-01T00:00:00Z'),
    }),
    person({ id: BOUND_CASHIER }),
    person({ id: REVOKED_CASHIER, bound: false, active: false }),
  ]);
  people.hashes.set(PENDING_CASHIER, 'hash:viejo');
  const work = fakeUnitOfWork(people);
  return {
    people,
    work,
    useCase: new RegenerateInvitationUseCase(work, new FakeCodes(), fixedClock()),
  };
};

describe('RegenerateInvitationUseCase', () => {
  it('gives a pending invitation a new code and a new week, and the old code stops working', async () => {
    const { people, useCase } = setup();

    const view = await useCase.execute(memberSession('admin'), PENDING_CASHIER);

    expect(view.invitation.code).toBe('0123-4567-89AB-CD01');
    expect(view.invitation.expiresAt).toEqual(new Date(NOW.getTime() + SEVEN_DAYS_MS));
    expect(view.person).toMatchObject({ id: PENDING_CASHIER, status: 'pending' });
    expect(people.hashes.get(PENDING_CASHIER)).toBe('hash:0123456789ABCD01');
  });

  it('works inside the business of the person who asks', async () => {
    const { work, useCase } = setup();

    await useCase.execute(memberSession('owner'), PENDING_CASHIER);

    expect(work.openedFor).toEqual([BUSINESS_ID]);
  });

  it('lets only the owner renew the invitation of an administrator (ADR 0017)', async () => {
    const { useCase } = setup();

    await expect(useCase.execute(memberSession('admin'), PENDING_ADMIN)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(useCase.execute(memberSession('owner'), PENDING_ADMIN)).resolves.toBeDefined();
  });

  it('refuses a cashier', async () => {
    const { useCase } = setup();

    await expect(useCase.execute(memberSession('cashier'), PENDING_CASHIER)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('says there is nothing to renew when the person already redeemed theirs', async () => {
    const { useCase } = setup();

    await expect(useCase.execute(memberSession('owner'), BOUND_CASHIER)).rejects.toBeInstanceOf(
      InvitationNotPendingError,
    );
  });

  it('says there is nothing to renew when the invitation was revoked', async () => {
    const { people, useCase } = setup();

    await expect(useCase.execute(memberSession('owner'), REVOKED_CASHIER)).rejects.toBeInstanceOf(
      InvitationNotPendingError,
    );
    expect(people.hashes.has(REVOKED_CASHIER)).toBe(false);
  });

  it('says there is nothing to renew when someone redeemed it between reading and renewing', async () => {
    const { people } = setup();
    people.rotateInvitation = () => Promise.resolve(null);
    const useCase = new RegenerateInvitationUseCase(
      fakeUnitOfWork(people),
      new FakeCodes(),
      fixedClock(),
    );

    await expect(useCase.execute(memberSession('owner'), PENDING_CASHIER)).rejects.toBeInstanceOf(
      InvitationNotPendingError,
    );
  });

  it('says there is no such person when the id is not in this business', async () => {
    const { useCase } = setup();

    await expect(
      useCase.execute(memberSession('owner'), '44444444-4444-4444-8444-444444444444'),
    ).rejects.toBeInstanceOf(PersonNotFoundError);
  });

  it.each(['no-es-un-uuid', '', "x'; DROP TABLE app_user;--"])(
    'says there is no such person for %j, without asking the database about a malformed id',
    async (id) => {
      const { work, useCase } = setup();

      await expect(useCase.execute(memberSession('owner'), id)).rejects.toBeInstanceOf(
        PersonNotFoundError,
      );
      expect(work.openedFor).toEqual([]);
    },
  );

  it('refuses a person with no business, and one who was deactivated', async () => {
    const { useCase } = setup();

    await expect(useCase.execute(loneSession(), PENDING_CASHIER)).rejects.toBeInstanceOf(
      NoMembershipError,
    );
    await expect(
      useCase.execute(memberSession('owner', { active: false }), PENDING_CASHIER),
    ).rejects.toBeInstanceOf(UserInactiveError);
  });
});
