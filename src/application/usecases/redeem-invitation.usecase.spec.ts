import { describe, expect, it } from 'vitest';
import {
  AlreadyMemberError,
  InvitationExpiredError,
  InvitationNotFoundError,
} from '../../domain/model/people-errors.js';
import { ValidationFailedError } from '../../domain/model/validation.js';
import type {
  InvitationRedeemer,
  InvitationRedemption,
} from '../../domain/ports/out/invitation-redeemer.js';
import { FakeCodes, NOW, fixedClock } from '../../../test/support/fake-codes.js';
import { loneSession, memberSession } from '../../../test/support/sessions.js';
import { RedeemInvitationUseCase } from './redeem-invitation.usecase.js';

const redeemer = (
  outcome: 'ok' | Error = 'ok',
): InvitationRedeemer & { requests: InvitationRedemption[] } => {
  const requests: InvitationRedemption[] = [];
  return {
    requests,
    redeem: (redemption) => {
      requests.push(redemption);
      if (outcome !== 'ok') return Promise.reject(outcome);
      return Promise.resolve({
        businessId: '22222222-2222-4222-8222-222222222222',
        businessName: 'Tienda La Esquina',
        userId: '66666666-6666-4666-8666-666666666666',
        role: 'cashier',
        fullName: 'Luis Pérez',
      });
    },
  };
};

const useCase = (work: InvitationRedeemer) =>
  new RedeemInvitationUseCase(work, new FakeCodes(), fixedClock());

describe('RedeemInvitationUseCase', () => {
  it('joins the person to the business the code belongs to, as the role they were invited with', async () => {
    const work = redeemer();

    const membership = await useCase(work).execute(loneSession(), {
      code: '0123-4567-89AB-CDEF',
    });

    expect(membership).toEqual({
      userId: '66666666-6666-4666-8666-666666666666',
      businessId: '22222222-2222-4222-8222-222222222222',
      businessName: 'Tienda La Esquina',
      role: 'cashier',
      fullName: 'Luis Pérez',
    });
  });

  it('looks the code up by its hash, binds the identity that proved who the person is, and says when', async () => {
    const work = redeemer();

    await useCase(work).execute(loneSession('Luis@Ejemplo.CO'), { code: '0123-4567-89AB-CDEF' });

    expect(work.requests).toEqual([
      {
        invitationHash: 'hash:0123456789ABCDEF',
        authUserId: '9b2f6c1e-0d5a-4c1b-8f3e-2a7d6e5c4b3a',
        email: 'luis@ejemplo.co',
        now: NOW,
      },
    ]);
  });

  it.each(['0123456789abcdef', '  0123 4567 89ab cdef  ', 'oi23-4567-89AB-CDEF'])(
    'reads the code as typed: %j',
    async (code) => {
      const work = redeemer();

      await useCase(work).execute(loneSession(), { code });

      expect(work.requests[0]?.invitationHash).toBe('hash:0123456789ABCDEF');
    },
  );

  it('refuses someone who already belongs to a business, before looking at what they sent', async () => {
    const work = redeemer();

    await expect(
      useCase(work).execute(memberSession('cashier'), { basura: 1 }),
    ).rejects.toBeInstanceOf(AlreadyMemberError);
    expect(work.requests).toEqual([]);
  });

  it.each([
    ['too short', '0123-4567'],
    ['a letter the alphabet leaves out', '0123-4567-89AB-CDEU'],
    ['a symbol', '0123-4567-89AB-CDE!'],
  ])('says the code has the wrong shape when it is %s, and asks nobody', async (_label, code) => {
    const work = redeemer();

    const failure = await useCase(work)
      .execute(loneSession(), { code })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ValidationFailedError);
    expect((failure as ValidationFailedError).errors).toEqual([
      {
        pointer: '/code',
        code: 'invalid-code',
        detail: 'El código no tiene la forma de un código de invitación.',
      },
    ]);
    expect(work.requests).toEqual([]);
  });

  it.each([
    [{}, 'required'],
    [{ code: 7 }, 'invalid-type'],
    [{ code: '   ' }, 'blank'],
  ])('reports %j as %s', async (body, code) => {
    const failure = await useCase(redeemer())
      .execute(loneSession(), body)
      .catch((error: unknown) => error);

    expect((failure as ValidationFailedError).errors[0]?.code).toBe(code);
  });

  it('passes on a code that does not exist, was used or was revoked, all the same', async () => {
    await expect(
      useCase(redeemer(new InvitationNotFoundError())).execute(loneSession(), {
        code: '0123-4567-89AB-CDEF',
      }),
    ).rejects.toBeInstanceOf(InvitationNotFoundError);
  });

  it('passes on an expired code', async () => {
    await expect(
      useCase(redeemer(new InvitationExpiredError())).execute(loneSession(), {
        code: '0123-4567-89AB-CDEF',
      }),
    ).rejects.toBeInstanceOf(InvitationExpiredError);
  });
});
