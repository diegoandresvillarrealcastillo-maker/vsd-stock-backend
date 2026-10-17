import { describe, expect, it } from 'vitest';
import { UserInactiveError, type Session } from '../../domain/ports/in/authenticate.js';
import type { Membership } from '../../domain/ports/out/identity-directory.js';
import type { UnitOfWork } from '../../domain/ports/out/unit-of-work.js';
import { GetMeUseCase } from './get-me.usecase.js';

const identity = {
  subject: '9b2f6c1e-0d5a-4c1b-8f3e-2a7d6e5c4b3a',
  email: 'ana@example.com',
  expiresAt: new Date('2026-10-17T16:00:00.000Z'),
};
const membership: Membership = {
  userId: '11111111-1111-4111-8111-111111111111',
  businessId: '22222222-2222-4222-8222-222222222222',
  role: 'admin',
  active: true,
  fullName: 'Ana Gómez',
};

/** Una unidad de trabajo de mentira que dice cual es el negocio y anota para quien se abrio. */
const unitOfWork = (name: string | null): UnitOfWork & { openedFor: string[] } => {
  const openedFor: string[] = [];
  return {
    openedFor,
    inBusiness: (businessId, work) => {
      openedFor.push(businessId);
      return work({
        businessId,
        business: {
          current: () => Promise.resolve(name === null ? null : { id: businessId, name }),
        },
      });
    },
  };
};

describe('GetMeUseCase', () => {
  it('tells a member who they are and which business they work for', async () => {
    const work = unitOfWork('Tienda La Esquina');
    const session: Session = { identity, membership };

    const me = await new GetMeUseCase(work).execute(session);

    expect(me).toEqual({
      identity: { id: identity.subject, email: 'ana@example.com' },
      membership: {
        userId: membership.userId,
        businessId: membership.businessId,
        businessName: 'Tienda La Esquina',
        role: 'admin',
        fullName: 'Ana Gómez',
      },
    });
    expect(work.openedFor).toEqual([membership.businessId]);
  });

  it('tells someone with no business yet that they have none, without opening any business', async () => {
    const work = unitOfWork('no se usa');

    const me = await new GetMeUseCase(work).execute({ identity, membership: null });

    expect(me).toEqual({
      identity: { id: identity.subject, email: 'ana@example.com' },
      membership: null,
    });
    expect(work.openedFor).toEqual([]);
  });

  it('refuses a person who was deactivated, and does not open their business', async () => {
    const work = unitOfWork('Tienda');

    await expect(
      new GetMeUseCase(work).execute({ identity, membership: { ...membership, active: false } }),
    ).rejects.toBeInstanceOf(UserInactiveError);
    expect(work.openedFor).toEqual([]);
  });

  it('keeps a missing e-mail as null', async () => {
    const me = await new GetMeUseCase(unitOfWork('T')).execute({
      identity: { ...identity, email: null },
      membership,
    });

    expect(me.identity.email).toBeNull();
  });

  it('fails loudly if the business of a member cannot be read: that would be a broken database, not a person without a business', async () => {
    await expect(
      new GetMeUseCase(unitOfWork(null)).execute({ identity, membership }),
    ).rejects.toThrow('business');
  });
});
