import { describe, expect, it } from 'vitest';
import { AlreadyMemberError } from '../../domain/model/people-errors.js';
import { ValidationFailedError } from '../../domain/model/validation.js';
import type { BusinessSetup, NewBusiness } from '../../domain/ports/out/business-setup.js';
import { loneSession, memberSession } from '../../../test/support/sessions.js';
import { CreateBusinessUseCase } from './create-business.usecase.js';

const NEW_USER_ID = '44444444-4444-4444-8444-444444444444';
const NEW_BUSINESS_ID = '55555555-5555-4555-8555-555555555555';

/** Un registro de negocios de mentira que anota lo que se le pidio. */
const setup = (): BusinessSetup & { requests: NewBusiness[] } => {
  const requests: NewBusiness[] = [];
  return {
    requests,
    createBusiness: (business) => {
      requests.push(business);
      return Promise.resolve({ businessId: NEW_BUSINESS_ID, userId: NEW_USER_ID });
    },
  };
};

const body = { businessName: 'Tienda La Esquina', ownerName: 'Ana Gómez' };

describe('CreateBusinessUseCase', () => {
  it('opens the business for the person and leaves them as its owner', async () => {
    const work = setup();

    const created = await new CreateBusinessUseCase(work).execute(loneSession(), body);

    expect(created).toEqual({
      userId: NEW_USER_ID,
      businessId: NEW_BUSINESS_ID,
      businessName: 'Tienda La Esquina',
      role: 'owner',
      fullName: 'Ana Gómez',
    });
  });

  it('binds the new business to the identity that proved who the person is, with a tidy email', async () => {
    const work = setup();

    await new CreateBusinessUseCase(work).execute(loneSession('Ana@Example.com'), body);

    expect(work.requests).toEqual([
      {
        businessName: 'Tienda La Esquina',
        owner: {
          authUserId: '9b2f6c1e-0d5a-4c1b-8f3e-2a7d6e5c4b3a',
          email: 'ana@example.com',
          fullName: 'Ana Gómez',
        },
      },
    ]);
  });

  it('opens it even if the identity has no usable email', async () => {
    const work = setup();

    await new CreateBusinessUseCase(work).execute(loneSession(null), body);

    expect(work.requests[0]?.owner.email).toBeNull();
  });

  it('trims the names it was given', async () => {
    const work = setup();

    await new CreateBusinessUseCase(work).execute(loneSession(), {
      businessName: '  Tienda  ',
      ownerName: ' Ana ',
    });

    expect(work.requests[0]).toMatchObject({ businessName: 'Tienda', owner: { fullName: 'Ana' } });
  });

  it('refuses someone who already belongs to a business, before looking at what they sent', async () => {
    const work = setup();

    await expect(
      new CreateBusinessUseCase(work).execute(memberSession('owner'), { basura: true }),
    ).rejects.toBeInstanceOf(AlreadyMemberError);
    expect(work.requests).toEqual([]);
  });

  it('refuses a deactivated member too: they belong to a business, even if they cannot work in it', async () => {
    const work = setup();

    await expect(
      new CreateBusinessUseCase(work).execute(memberSession('owner', { active: false }), body),
    ).rejects.toBeInstanceOf(AlreadyMemberError);
  });

  it('reports every problem in what was sent and creates nothing', async () => {
    const work = setup();

    const failure = await new CreateBusinessUseCase(work)
      .execute(loneSession(), { businessName: '', ownerName: 5, extra: 1 })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ValidationFailedError);
    expect((failure as ValidationFailedError).errors.map((e) => `${e.pointer}:${e.code}`)).toEqual([
      '/extra:unknown-field',
      '/businessName:blank',
      '/ownerName:invalid-type',
    ]);
    expect(work.requests).toEqual([]);
  });

  it('lets the business name be as long as the database allows, 120, and no more', async () => {
    const work = setup();

    await new CreateBusinessUseCase(work).execute(loneSession(), {
      ...body,
      businessName: 'n'.repeat(120),
    });
    await expect(
      new CreateBusinessUseCase(work).execute(loneSession(), {
        ...body,
        businessName: 'n'.repeat(121),
      }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });
});
