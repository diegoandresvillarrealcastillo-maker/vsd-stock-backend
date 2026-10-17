import { describe, expect, it } from 'vitest';
import { AuthenticationError } from '../../domain/ports/in/authenticate.js';
import type { IdentityDirectory, Membership } from '../../domain/ports/out/identity-directory.js';
import {
  InvalidTokenError,
  type TokenFailure,
  type TokenVerifier,
  type VerifiedIdentity,
} from '../../domain/ports/out/token-verifier.js';
import { AuthenticateUseCase } from './authenticate.usecase.js';

const SUBJECT = '9b2f6c1e-0d5a-4c1b-8f3e-2a7d6e5c4b3a';
const identity: VerifiedIdentity = {
  subject: SUBJECT,
  email: 'ana@example.com',
  expiresAt: new Date('2026-10-17T16:00:00.000Z'),
};
const membership: Membership = {
  userId: '11111111-1111-4111-8111-111111111111',
  businessId: '22222222-2222-4222-8222-222222222222',
  role: 'cashier',
  active: true,
  fullName: 'Ana',
};

/** Un verificador que acepta un solo texto y rechaza el resto con el motivo dado. */
const verifierFor = (accepted: string, otherwise: TokenFailure = 'signature'): TokenVerifier => ({
  verify: (token) =>
    token === accepted
      ? Promise.resolve(identity)
      : Promise.reject(new InvalidTokenError(otherwise)),
});

const directoryWith = (found: Membership | null): IdentityDirectory & { asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    findMembership: (authUserId) => {
      asked.push(authUserId);
      return Promise.resolve(found);
    },
  };
};

const failureOf = async (attempt: Promise<unknown>): Promise<string> => {
  try {
    await attempt;
    return 'accepted';
  } catch (error) {
    if (error instanceof AuthenticationError) return error.reason;
    throw error;
  }
};

describe('AuthenticateUseCase', () => {
  it('gives the verified person and the membership the database knows', async () => {
    const directory = directoryWith(membership);
    const useCase = new AuthenticateUseCase(verifierFor('token-bueno'), directory);

    const session = await useCase.execute('Bearer token-bueno');

    expect(session).toEqual({ identity, membership });
    expect(directory.asked).toEqual([SUBJECT]);
  });

  it('gives a null membership to a person who signed in but belongs to no business yet', async () => {
    const session = await new AuthenticateUseCase(verifierFor('t'), directoryWith(null)).execute(
      'Bearer t',
    );

    expect(session.membership).toBeNull();
    expect(session.identity).toEqual(identity);
  });

  it('keeps a deactivated membership and says so, so each endpoint decides what that means', async () => {
    const baja = { ...membership, active: false };

    const session = await new AuthenticateUseCase(verifierFor('t'), directoryWith(baja)).execute(
      'Bearer t',
    );

    expect(session.membership?.active).toBe(false);
  });

  it.each(['Bearer t', 'bearer t', 'BEARER t', 'Bearer    t'])(
    'reads the scheme without caring about case or extra spaces (%j)',
    async (header) => {
      const useCase = new AuthenticateUseCase(verifierFor('t'), directoryWith(null));

      expect(await failureOf(useCase.execute(header))).toBe('accepted');
    },
  );

  it.each([undefined, '', '   '])('refuses a request with no credentials (%j)', async (header) => {
    const directory = directoryWith(membership);
    const useCase = new AuthenticateUseCase(verifierFor('t'), directory);

    expect(await failureOf(useCase.execute(header))).toBe('missing');
    expect(directory.asked).toEqual([]);
  });

  it.each(['Basic dXNlcjpwYXNz', 'Token t', 'Bearer', 'Bearer ', 't', 'Bearer a b'])(
    'refuses a header that is not a bearer token (%j)',
    async (header) => {
      const useCase = new AuthenticateUseCase(verifierFor('t'), directoryWith(membership));

      expect(await failureOf(useCase.execute(header))).toBe('scheme');
    },
  );

  it.each<TokenFailure>(['signature', 'expired', 'issuer', 'unavailable', 'malformed'])(
    'passes on why the token was refused (%s) and never looks the person up',
    async (reason) => {
      const directory = directoryWith(membership);
      const useCase = new AuthenticateUseCase(verifierFor('otro', reason), directory);

      expect(await failureOf(useCase.execute('Bearer t'))).toBe(reason);
      expect(directory.asked).toEqual([]);
    },
  );

  it('does not hide a failure that is not about the token (a broken database is an error, not a bad token)', async () => {
    const broken: IdentityDirectory = {
      findMembership: () => Promise.reject(new Error('base caida')),
    };
    const useCase = new AuthenticateUseCase(verifierFor('t'), broken);

    await expect(useCase.execute('Bearer t')).rejects.toThrow('base caida');
  });

  it('does not turn a failure of the verifier that is not about the token into a refused token', async () => {
    const broken: TokenVerifier = { verify: () => Promise.reject(new Error('fallo inesperado')) };
    const useCase = new AuthenticateUseCase(broken, directoryWith(membership));

    await expect(useCase.execute('Bearer t')).rejects.toThrow('fallo inesperado');
  });
});
