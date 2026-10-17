import { describe, expect, it } from 'vitest';
import { ForbiddenError, NoMembershipError } from '../../domain/model/people-errors.js';
import { encodeCursor } from '../../domain/model/pagination.js';
import { ValidationFailedError } from '../../domain/model/validation.js';
import { UserInactiveError } from '../../domain/ports/in/authenticate.js';
import { FakePeople, fakeUnitOfWork, person } from '../../../test/support/fake-people.js';
import { BUSINESS_ID, loneSession, memberSession } from '../../../test/support/sessions.js';
import { ListUsersUseCase } from './list-users.usecase.js';

const ids = ['1', '2', '3', '4', '5'].map((n) => `0000000${n}-0000-4000-8000-000000000000`);

const setup = () => {
  const people = new FakePeople([
    person({ id: ids[3] as string, fullName: 'Diana' }),
    person({ id: ids[0] as string, fullName: 'Ana', role: 'owner' }),
    person({
      id: ids[4] as string,
      fullName: 'Eva',
      bound: false,
      invitationExpiresAt: new Date('2026-10-20T00:00:00Z'),
    }),
    person({ id: ids[2] as string, fullName: 'Carla', active: false }),
    person({ id: ids[1] as string, fullName: 'Beto', role: 'admin', email: 'beto@ejemplo.co' }),
  ]);
  const work = fakeUnitOfWork(people);
  return { work, useCase: new ListUsersUseCase(work) };
};

describe('ListUsersUseCase', () => {
  it('lists the people of the business by name, with their state', async () => {
    const { useCase } = setup();

    const page = await useCase.execute(memberSession('admin'), {});

    expect(page.nextCursor).toBeNull();
    expect(page.items.map((p) => [p.fullName, p.role, p.status])).toEqual([
      ['Ana', 'owner', 'active'],
      ['Beto', 'admin', 'active'],
      ['Carla', 'cashier', 'inactive'],
      ['Diana', 'cashier', 'active'],
      ['Eva', 'cashier', 'pending'],
    ]);
    expect(page.items[1]).toMatchObject({ email: 'beto@ejemplo.co' });
    expect(page.items[4]).toMatchObject({ invitationExpiresAt: new Date('2026-10-20T00:00:00Z') });
  });

  it('works inside the business of the person who asks', async () => {
    const { work, useCase } = setup();

    await useCase.execute(memberSession('owner'), {});

    expect(work.openedFor).toEqual([BUSINESS_ID]);
  });

  it('walks the whole list page by page without repeating or skipping anyone', async () => {
    const { useCase } = setup();
    const seen: string[] = [];
    let cursor: string | undefined;

    for (let pages = 0; pages < 10; pages += 1) {
      const page = await useCase.execute(
        memberSession('owner'),
        cursor === undefined ? { limit: '2' } : { limit: '2', cursor },
      );
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((p) => p.fullName));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }

    expect(seen).toEqual(['Ana', 'Beto', 'Carla', 'Diana', 'Eva']);
  });

  it('says there is no next page when the list ends exactly at the limit', async () => {
    const { useCase } = setup();

    const page = await useCase.execute(memberSession('owner'), { limit: '5' });

    expect(page.items).toHaveLength(5);
    expect(page.nextCursor).toBeNull();
  });

  it('points the next page at the last person it handed over', async () => {
    const { useCase } = setup();

    const page = await useCase.execute(memberSession('owner'), { limit: '2' });

    expect(page.items.map((p) => p.fullName)).toEqual(['Ana', 'Beto']);
    expect(page.nextCursor).toBe(encodeCursor(['Beto', ids[1] as string]));
  });

  it('lets an administrator list, and refuses a cashier', async () => {
    const { useCase } = setup();

    await expect(useCase.execute(memberSession('admin'), {})).resolves.toBeDefined();
    await expect(useCase.execute(memberSession('cashier'), {})).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('refuses a person with no business, and one who was deactivated', async () => {
    const { useCase } = setup();

    await expect(useCase.execute(loneSession(), {})).rejects.toBeInstanceOf(NoMembershipError);
    await expect(
      useCase.execute(memberSession('owner', { active: false }), {}),
    ).rejects.toBeInstanceOf(UserInactiveError);
  });

  it('reports a bad limit and a bad cursor together', async () => {
    const { useCase } = setup();

    const failure = await useCase
      .execute(memberSession('owner'), { limit: '0', cursor: 'basura' })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ValidationFailedError);
    expect((failure as ValidationFailedError).errors.map((e) => e.pointer)).toEqual([
      '/limit',
      '/cursor',
    ]);
  });
});
