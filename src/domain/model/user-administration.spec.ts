import { describe, expect, it } from 'vitest';
import type { Principal } from './authorization.js';
import { ROLES, type Role } from './role.js';
import {
  INVITABLE_ROLES,
  actionToManage,
  canChangePerson,
  canInvite,
  personStatus,
  wouldLeaveNoOwner,
} from './user-administration.js';

const BUSINESS = '11111111-1111-4111-8111-111111111111';

const actor = (role: Role, active = true): Principal => ({
  userId: '33333333-3333-4333-8333-333333333333',
  businessId: BUSINESS,
  role,
  active,
});

describe('which roles can be invited', () => {
  it('lists administrator and cashier: nobody invites an owner, the owner is who creates the business', () => {
    expect(INVITABLE_ROLES).toEqual(['admin', 'cashier']);
  });
});

describe('the action that manages each role (ADR 0017)', () => {
  it.each([
    ['cashier', 'user:manage-cashiers'],
    ['admin', 'user:manage-admins'],
    ['owner', 'user:manage-admins'],
  ] as const)('managing a %s takes %s', (role, action) => {
    expect(actionToManage(role)).toBe(action);
  });
});

describe('who can invite', () => {
  it.each([
    ['owner', 'admin', true],
    ['owner', 'cashier', true],
    ['admin', 'cashier', true],
    ['admin', 'admin', false],
    ['cashier', 'cashier', false],
    ['cashier', 'admin', false],
  ] as const)('a %s inviting a %s: %s', (actorRole, invitedRole, allowed) => {
    expect(canInvite(actor(actorRole), invitedRole).allowed).toBe(allowed);
  });

  it('says the role is what stops an administrator from inviting an administrator', () => {
    expect(canInvite(actor('admin'), 'admin')).toEqual({ allowed: false, reason: 'role' });
  });

  it('refuses a person who was deactivated, whatever the role', () => {
    for (const role of ROLES) {
      expect(canInvite(actor(role, false), 'cashier')).toEqual({
        allowed: false,
        reason: 'inactive',
      });
    }
  });
});

describe('who can change a person', () => {
  it.each([
    // cambiar a un cajero
    ['owner', 'cashier', { active: false }, true],
    ['admin', 'cashier', { active: false }, true],
    ['admin', 'cashier', { fullName: 'Ana' }, true],
    ['cashier', 'cashier', { active: false }, false],
    // cambiar a un administrador: solo el dueno
    ['owner', 'admin', { active: false }, true],
    ['admin', 'admin', { active: false }, false],
    ['admin', 'admin', { fullName: 'Ana' }, false],
    // cambiar a un dueno: solo el dueno
    ['owner', 'owner', { active: false }, true],
    ['admin', 'owner', { active: false }, false],
    // cambiar el rol: hace falta poder con el rol de antes Y con el de despues
    ['owner', 'cashier', { role: 'admin' }, true],
    ['admin', 'cashier', { role: 'admin' }, false],
    ['admin', 'cashier', { role: 'owner' }, false],
    ['admin', 'admin', { role: 'cashier' }, false],
    ['owner', 'admin', { role: 'cashier' }, true],
    // quedarse en el mismo rol no cuenta como cambiarlo
    ['admin', 'cashier', { role: 'cashier' }, true],
  ] as const)('a %s changing a %s with %j: %s', (actorRole, targetRole, change, allowed) => {
    expect(canChangePerson(actor(actorRole), { role: targetRole }, change).allowed).toBe(allowed);
  });

  it('refuses a deactivated person even if the role would allow it', () => {
    expect(canChangePerson(actor('owner', false), { role: 'cashier' }, { active: false })).toEqual({
      allowed: false,
      reason: 'inactive',
    });
  });
});

describe('the last owner (ADR 0017)', () => {
  const owner = { role: 'owner', active: true } as const;

  it('is protected when it is demoted', () => {
    expect(wouldLeaveNoOwner(owner, { role: 'admin' }, 1)).toBe(true);
  });

  it('is protected when it is deactivated', () => {
    expect(wouldLeaveNoOwner(owner, { active: false }, 1)).toBe(true);
  });

  it('is not protected when another active owner remains', () => {
    expect(wouldLeaveNoOwner(owner, { role: 'admin' }, 2)).toBe(false);
    expect(wouldLeaveNoOwner(owner, { active: false }, 2)).toBe(false);
  });

  it('is not at risk when the change keeps it an active owner', () => {
    expect(wouldLeaveNoOwner(owner, { fullName: 'Ana' }, 1)).toBe(false);
    expect(wouldLeaveNoOwner(owner, { role: 'owner' }, 1)).toBe(false);
    expect(wouldLeaveNoOwner(owner, { active: true }, 1)).toBe(false);
  });

  it('does not concern a person who is not an owner', () => {
    expect(wouldLeaveNoOwner({ role: 'admin', active: true }, { active: false }, 1)).toBe(false);
    expect(wouldLeaveNoOwner({ role: 'cashier', active: true }, { role: 'admin' }, 1)).toBe(false);
  });

  it('does not concern an owner who was already deactivated: it is not one of the active owners', () => {
    expect(wouldLeaveNoOwner({ role: 'owner', active: false }, { role: 'admin' }, 1)).toBe(false);
  });

  it('is at risk when the count is zero, which should not happen but must not allow anything worse', () => {
    expect(wouldLeaveNoOwner(owner, { active: false }, 0)).toBe(true);
  });
});

describe('the state of a person', () => {
  it.each([
    [{ bound: true, active: true }, 'active'],
    [{ bound: false, active: true }, 'pending'],
    [{ bound: true, active: false }, 'inactive'],
    [{ bound: false, active: false }, 'inactive'],
  ] as const)('%j is %s', (person, status) => {
    expect(personStatus(person)).toBe(status);
  });
});
