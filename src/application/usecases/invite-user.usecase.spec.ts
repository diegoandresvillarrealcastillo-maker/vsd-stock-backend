import { describe, expect, it } from 'vitest';
import { ForbiddenError, NoMembershipError } from '../../domain/model/people-errors.js';
import { ValidationFailedError } from '../../domain/model/validation.js';
import { UserInactiveError } from '../../domain/ports/in/authenticate.js';
import { FakeCodes, NOW, fixedClock } from '../../../test/support/fake-codes.js';
import { FakePeople, fakeUnitOfWork } from '../../../test/support/fake-people.js';
import { BUSINESS_ID, loneSession, memberSession } from '../../../test/support/sessions.js';
import { InviteUserUseCase } from './invite-user.usecase.js';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const setup = () => {
  const people = new FakePeople();
  const work = fakeUnitOfWork(people);
  return { people, work, useCase: new InviteUserUseCase(work, new FakeCodes(), fixedClock()) };
};

const body = { fullName: 'Luis Pérez', role: 'cashier' };

describe('InviteUserUseCase', () => {
  it('invites a cashier and hands over the code once, in groups of four', async () => {
    const { useCase } = setup();

    const view = await useCase.execute(memberSession('admin'), body);

    expect(view.invitation.code).toBe('0123-4567-89AB-CD01');
    expect(view.invitation.expiresAt).toEqual(new Date(NOW.getTime() + SEVEN_DAYS_MS));
    expect(view.person).toMatchObject({
      fullName: 'Luis Pérez',
      email: null,
      role: 'cashier',
      status: 'pending',
      invitationExpiresAt: new Date(NOW.getTime() + SEVEN_DAYS_MS),
    });
  });

  it('keeps only the hash of the code, never the code, and never shows the hash', async () => {
    const { people, useCase } = setup();

    const view = await useCase.execute(memberSession('admin'), body);

    expect(people.hashes.get(view.person.id)).toBe('hash:0123456789ABCD01');
    expect(JSON.stringify(view)).not.toContain('hash');
    expect(JSON.stringify(people.records)).not.toContain('0123456789ABCD01');
  });

  it('works inside the business of the person who invites, and nowhere else', async () => {
    const { work, useCase } = setup();

    await useCase.execute(memberSession('owner'), body);

    expect(work.openedFor).toEqual([BUSINESS_ID]);
  });

  it('keeps the email in lower case when one is given', async () => {
    const { useCase } = setup();

    const view = await useCase.execute(memberSession('owner'), {
      ...body,
      email: '  Luis@Ejemplo.CO ',
    });

    expect(view.person.email).toBe('luis@ejemplo.co');
  });

  it.each([
    ['owner', 'admin'],
    ['owner', 'cashier'],
    ['admin', 'cashier'],
  ] as const)('lets a %s invite a %s', async (actor, invited) => {
    const { useCase } = setup();

    const view = await useCase.execute(memberSession(actor), { ...body, role: invited });

    expect(view.person.role).toBe(invited);
  });

  it('does not let an administrator invite another administrator: that is for the owner (ADR 0017)', async () => {
    const { people, useCase } = setup();

    await expect(
      useCase.execute(memberSession('admin'), { ...body, role: 'admin' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(people.records).toEqual([]);
  });

  it('does not let anyone invite an owner: the owner is who opens the business', async () => {
    const { people, useCase } = setup();

    const failure = await useCase
      .execute(memberSession('owner'), { ...body, role: 'owner' })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ValidationFailedError);
    expect((failure as ValidationFailedError).errors).toEqual([
      {
        pointer: '/role',
        code: 'invalid-value',
        detail: 'El rol debe ser uno de: admin, cashier.',
      },
    ]);
    expect(people.records).toEqual([]);
  });

  it('refuses a cashier before looking at what they sent: a cashier invites nobody', async () => {
    const { people, useCase } = setup();

    await expect(useCase.execute(memberSession('cashier'), { basura: 1 })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(people.records).toEqual([]);
  });

  it('refuses a person with no business, and one who was deactivated', async () => {
    const { useCase } = setup();

    await expect(useCase.execute(loneSession(), body)).rejects.toBeInstanceOf(NoMembershipError);
    await expect(
      useCase.execute(memberSession('owner', { active: false }), body),
    ).rejects.toBeInstanceOf(UserInactiveError);
  });

  it('reports every problem in what was sent and invites nobody', async () => {
    const { people, useCase } = setup();

    const failure = await useCase
      .execute(memberSession('owner'), { fullName: '  ', role: 'rey', email: 'no-es-correo' })
      .catch((error: unknown) => error);

    expect((failure as ValidationFailedError).errors.map((e) => `${e.pointer}:${e.code}`)).toEqual([
      '/fullName:blank',
      '/role:invalid-value',
      '/email:invalid-email',
    ]);
    expect(people.records).toEqual([]);
  });

  it('gives each invitation its own code', async () => {
    const { useCase } = setup();

    const first = await useCase.execute(memberSession('owner'), body);
    const second = await useCase.execute(memberSession('owner'), body);

    expect(first.invitation.code).not.toBe(second.invitation.code);
  });
});
