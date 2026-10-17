import { describe, expect, it } from 'vitest';
import { authorize, type Principal } from './authorization.js';
import { ACTIONS, ROLES, type Action } from './role.js';

const BUSINESS = '11111111-1111-4111-8111-111111111111';
const OTHER_BUSINESS = '22222222-2222-4222-8222-222222222222';
const ONLINE = { online: true };
const OFFLINE = { online: false };

const principal = (overrides: Partial<Principal> = {}): Principal => ({
  userId: '33333333-3333-4333-8333-333333333333',
  businessId: BUSINESS,
  role: 'cashier',
  active: true,
  ...overrides,
});
const own = { businessId: BUSINESS };

describe('authorize', () => {
  it('allows what the role may do, in its own business', () => {
    expect(authorize(principal(), 'sale:create', own, ONLINE)).toEqual({ allowed: true });
    expect(authorize(principal({ role: 'admin' }), 'sale:void', own, ONLINE)).toEqual({
      allowed: true,
    });
    expect(authorize(principal({ role: 'owner' }), 'business:settings', own, ONLINE)).toEqual({
      allowed: true,
    });
  });

  it('denies what the role may not do, and says it is the role', () => {
    expect(authorize(principal(), 'sale:void', own, ONLINE)).toEqual({
      allowed: false,
      reason: 'role',
    });
    expect(authorize(principal({ role: 'admin' }), 'user:manage-admins', own, ONLINE)).toEqual({
      allowed: false,
      reason: 'role',
    });
  });

  it('denies EVERYTHING in another business, even to its owner', () => {
    for (const role of ROLES) {
      for (const action of Object.keys(ACTIONS)) {
        expect(
          authorize(principal({ role }), action, { businessId: OTHER_BUSINESS }, ONLINE),
          `${role} ${action}`,
        ).toEqual({ allowed: false, reason: 'other-business' });
      }
    }
  });

  it('denies everything to a user who was deactivated', () => {
    for (const action of Object.keys(ACTIONS)) {
      expect(authorize(principal({ role: 'owner', active: false }), action, own, ONLINE)).toEqual({
        allowed: false,
        reason: 'inactive',
      });
    }
  });

  it('denies an action that does not exist, even to the owner', () => {
    expect(authorize(principal({ role: 'owner' }), 'sale:delete', own, ONLINE)).toEqual({
      allowed: false,
      reason: 'unknown-action',
    });
    expect(authorize(principal(), '', own, ONLINE)).toEqual({
      allowed: false,
      reason: 'unknown-action',
    });
    expect(authorize(principal(), 'toString', own, ONLINE)).toEqual({
      allowed: false,
      reason: 'unknown-action',
    });
  });

  it('denies a principal whose role is not one of ours', () => {
    expect(
      authorize(principal({ role: 'superuser' as never }), 'sale:create', own, ONLINE),
    ).toEqual({
      allowed: false,
      reason: 'role',
    });
  });

  it('lets the counter keep working without a connection', () => {
    for (const action of [
      'sale:create',
      'payment:collect-cash',
      'shift:open',
      'shift:close',
      'stock:view',
    ]) {
      expect(authorize(principal(), action, own, OFFLINE), action).toEqual({ allowed: true });
    }
  });

  it('asks for a connection when the role may do it but it cannot be done offline', () => {
    expect(authorize(principal({ role: 'admin' }), 'stock:adjust', own, OFFLINE)).toEqual({
      allowed: false,
      reason: 'needs-connection',
    });
    expect(authorize(principal({ role: 'owner' }), 'report:sales', own, OFFLINE)).toEqual({
      allowed: false,
      reason: 'needs-connection',
    });
  });

  it('says it is the role, not the connection, when the role may not do it either way', () => {
    expect(authorize(principal(), 'stock:adjust', own, OFFLINE)).toEqual({
      allowed: false,
      reason: 'role',
    });
  });

  it('puts other-business before the role and the connection, so that nothing about another business leaks', () => {
    expect(authorize(principal(), 'stock:adjust', { businessId: OTHER_BUSINESS }, OFFLINE)).toEqual(
      { allowed: false, reason: 'other-business' },
    );
  });

  it('puts inactive before everything but unknown-action', () => {
    expect(
      authorize(
        principal({ active: false }),
        'sale:create',
        { businessId: OTHER_BUSINESS },
        ONLINE,
      ),
    ).toEqual({ allowed: false, reason: 'inactive' });
  });

  it('has the same answer online as the table of roles says', () => {
    for (const role of ROLES) {
      for (const action of Object.keys(ACTIONS) as Action[]) {
        const decision = authorize(principal({ role }), action, own, ONLINE);

        expect(decision.allowed, `${role} ${action}`).toBe(
          (ACTIONS[action].roles as readonly string[]).includes(role),
        );
      }
    }
  });
});
