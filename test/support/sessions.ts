import type { Role } from '../../src/domain/model/role.js';
import type { Session } from '../../src/domain/ports/in/authenticate.js';

export const IDENTITY = {
  subject: '9b2f6c1e-0d5a-4c1b-8f3e-2a7d6e5c4b3a',
  email: 'Ana@Example.com' as string | null,
  expiresAt: new Date('2026-10-17T16:00:00.000Z'),
};

export const BUSINESS_ID = '22222222-2222-4222-8222-222222222222';
export const ACTOR_ID = '11111111-1111-4111-8111-111111111111';

/** Una persona que ya trabaja en un negocio con ese rol. */
export function memberSession(role: Role, overrides: { active?: boolean } = {}): Session {
  return {
    identity: IDENTITY,
    membership: {
      userId: ACTOR_ID,
      businessId: BUSINESS_ID,
      role,
      active: overrides.active ?? true,
      fullName: 'Ana Gómez',
    },
  };
}

/** Una persona que se registro en el servicio de identidad pero aun no tiene negocio. */
export function loneSession(email: string | null = IDENTITY.email): Session {
  return { identity: { ...IDENTITY, email }, membership: null };
}
