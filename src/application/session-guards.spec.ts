import { describe, expect, it } from 'vitest';
import { ForbiddenError, NoMembershipError } from '../domain/model/people-errors.js';
import { UserInactiveError, type Session } from '../domain/ports/in/authenticate.js';
import { ensureAllowed, ensureCan, normalizedEmail, requireMember } from './session-guards.js';

const identity = {
  subject: '9b2f6c1e-0d5a-4c1b-8f3e-2a7d6e5c4b3a',
  email: 'ana@example.com',
  expiresAt: new Date('2026-10-17T16:00:00.000Z'),
};

const session = (membership: Session['membership']): Session => ({ identity, membership });

describe('requireMember', () => {
  it('turns the membership into who is acting', () => {
    const principal = requireMember(
      session({
        userId: '11111111-1111-4111-8111-111111111111',
        businessId: '22222222-2222-4222-8222-222222222222',
        role: 'admin',
        active: true,
        fullName: 'Ana Gómez',
      }),
    );

    expect(principal).toEqual({
      userId: '11111111-1111-4111-8111-111111111111',
      businessId: '22222222-2222-4222-8222-222222222222',
      role: 'admin',
      active: true,
    });
  });

  it('asks a person with no business to create or join one first', () => {
    expect(() => requireMember(session(null))).toThrow(NoMembershipError);
  });

  it('refuses a person who was deactivated', () => {
    expect(() =>
      requireMember(
        session({
          userId: '11111111-1111-4111-8111-111111111111',
          businessId: '22222222-2222-4222-8222-222222222222',
          role: 'owner',
          active: false,
          fullName: 'Ana Gómez',
        }),
      ),
    ).toThrow(UserInactiveError);
  });
});

describe('ensureAllowed', () => {
  it('lets an allowed decision pass', () => {
    expect(() => ensureAllowed({ allowed: true })).not.toThrow();
  });

  it('refuses a denial and keeps the reason for the log', () => {
    expect.assertions(2);
    try {
      ensureAllowed({ allowed: false, reason: 'role' });
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenError);
      expect((error as ForbiddenError).reason).toBe('role');
    }
  });
});

describe('ensureCan', () => {
  const principal = (role: 'owner' | 'admin' | 'cashier') => ({
    userId: '11111111-1111-4111-8111-111111111111',
    businessId: '22222222-2222-4222-8222-222222222222',
    role,
    active: true,
  });

  it('lets a role do what the permission table gives it (ADR 0017)', () => {
    expect(() => ensureCan(principal('cashier'), 'product:view')).not.toThrow();
    expect(() => ensureCan(principal('admin'), 'product:manage')).not.toThrow();
    expect(() => ensureCan(principal('owner'), 'business:settings')).not.toThrow();
  });

  it('refuses a role the table does not give it, with the reason for the log', () => {
    expect.assertions(2);
    try {
      ensureCan(principal('cashier'), 'product:manage');
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenError);
      expect((error as ForbiddenError).reason).toBe('role');
    }
  });

  it('refuses a person who was deactivated, whatever the role', () => {
    expect(() => ensureCan({ ...principal('owner'), active: false }, 'product:view')).toThrow(
      ForbiddenError,
    );
  });
});

describe('normalizedEmail', () => {
  it.each([
    ['ana@example.com', 'ana@example.com'],
    ['  Ana@Example.COM ', 'ana@example.com'],
    [null, null],
    ['', null],
    ['  ', null],
    ['a@', null],
    ['ab', null],
    ['x'.repeat(250) + '@a.co', null],
  ])('reads %j as %j', (given, expected) => {
    expect(normalizedEmail(given)).toBe(expected);
  });

  it('keeps the longest address the database allows', () => {
    const longest = `${'x'.repeat(249)}@a.co`;

    expect(longest).toHaveLength(254);
    expect(normalizedEmail(longest)).toBe(longest);
  });
});
