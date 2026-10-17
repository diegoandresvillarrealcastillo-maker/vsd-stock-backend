import { describe, expect, it } from 'vitest';
import {
  ACTIONS,
  ROLES,
  actionsOf,
  can,
  isAction,
  isAvailableOffline,
  isRole,
  type Action,
  type Role,
} from './role.js';

const ACTION_IDS = Object.keys(ACTIONS) as Action[];

describe('roles', () => {
  it('are the owner, the administrator and the cashier', () => {
    expect(ROLES).toEqual(['owner', 'admin', 'cashier']);
  });

  it('recognize only their own names', () => {
    expect(isRole('owner')).toBe(true);
    expect(isRole('cashier')).toBe(true);
    expect(isRole('Owner')).toBe(false);
    expect(isRole('dueño')).toBe(false);
    expect(isRole('toString')).toBe(false);
    expect(isRole(undefined)).toBe(false);
  });
});

describe('actions', () => {
  it('recognize only their own names', () => {
    expect(isAction('sale:void')).toBe(true);
    expect(isAction('sale:delete')).toBe(false);
    expect(isAction('toString')).toBe(false);
    expect(isAction(7)).toBe(false);
  });

  it('are named "area:what" in lower case', () => {
    for (const action of ACTION_IDS) {
      expect(action, action).toMatch(/^[a-z]+(?:-[a-z]+)*:[a-z]+(?:-[a-z]+)*$/);
    }
  });

  it('are the ones of the delivery, no more and no fewer', () => {
    expect([...ACTION_IDS].sort()).toEqual(
      [
        'business:settings',
        'cash-movement:create',
        'device:enroll',
        'device:revoke',
        'payment:collect-cash',
        'price:update',
        'product:manage',
        'product:view',
        'purchase:create',
        'report:profit',
        'report:sales',
        'report:stock',
        'sale:create',
        'sale:view-all',
        'sale:view-own-shift',
        'sale:void',
        'shift:close',
        'shift:close-other',
        'shift:open',
        'stock:adjust',
        'stock:view',
        'user:manage-admins',
        'user:manage-cashiers',
      ].sort(),
    );
  });
});

describe('what each role may do', () => {
  // Una prueba en negativo por cada regla de negocio (ADR 0007): no basta con que el dueno pueda;
  // hay que probar que quien no debe, no puede.
  it.each<[string, Role, Action]>([
    ['a cashier cannot void a sale', 'cashier', 'sale:void'],
    ['a cashier cannot see the profits', 'cashier', 'report:profit'],
    ['a cashier cannot see every sale of the business', 'cashier', 'sale:view-all'],
    ['a cashier cannot adjust the stock', 'cashier', 'stock:adjust'],
    ['a cashier cannot register a purchase', 'cashier', 'purchase:create'],
    ['a cashier cannot create or archive a product', 'cashier', 'product:manage'],
    ['a cashier cannot change a price or a tax rate', 'cashier', 'price:update'],
    ['a cashier cannot move cash outside a sale', 'cashier', 'cash-movement:create'],
    ['a cashier cannot close the shift of someone else', 'cashier', 'shift:close-other'],
    ['a cashier cannot read the sales and stock reports', 'cashier', 'report:sales'],
    ['a cashier cannot read the stock report', 'cashier', 'report:stock'],
    ['a cashier cannot manage other cashiers', 'cashier', 'user:manage-cashiers'],
    ['a cashier cannot manage administrators', 'cashier', 'user:manage-admins'],
    ['a cashier cannot change the data of the business', 'cashier', 'business:settings'],
    ['a cashier cannot revoke a device', 'cashier', 'device:revoke'],
    [
      'an administrator cannot manage other administrators or change roles',
      'admin',
      'user:manage-admins',
    ],
    ['an administrator cannot change the data of the business', 'admin', 'business:settings'],
  ])('%s', (_rule, role, action) => {
    expect(can(role, action)).toBe(false);
  });

  it.each<[string, Role, Action]>([
    ['a cashier can sell', 'cashier', 'sale:create'],
    ['a cashier can collect cash', 'cashier', 'payment:collect-cash'],
    ['a cashier can open its own shift', 'cashier', 'shift:open'],
    ['a cashier can close its own shift', 'cashier', 'shift:close'],
    ['a cashier can see the sales of its own shift', 'cashier', 'sale:view-own-shift'],
    ['a cashier can look up stock', 'cashier', 'stock:view'],
    ['a cashier can look up the catalogue and its prices', 'cashier', 'product:view'],
    ['a cashier can enroll the device it works on', 'cashier', 'device:enroll'],
    ['an administrator can void a sale', 'admin', 'sale:void'],
    ['an administrator can adjust the stock', 'admin', 'stock:adjust'],
    ['an administrator can change a price', 'admin', 'price:update'],
    ['an administrator can see the profits', 'admin', 'report:profit'],
    ['an administrator can manage cashiers', 'admin', 'user:manage-cashiers'],
    ['an administrator can revoke a device', 'admin', 'device:revoke'],
    ['the owner can manage administrators', 'owner', 'user:manage-admins'],
    ['the owner can change the data of the business', 'owner', 'business:settings'],
  ])('%s', (_rule, role, action) => {
    expect(can(role, action)).toBe(true);
  });

  it('gives the owner every action', () => {
    expect(actionsOf('owner').sort()).toEqual([...ACTION_IDS].sort());
  });

  it('never takes anything away as responsibility grows: what a cashier does, an administrator does, and the owner too', () => {
    for (const action of ACTION_IDS) {
      if (can('cashier', action)) expect(can('admin', action), action).toBe(true);
      if (can('admin', action)) expect(can('owner', action), action).toBe(true);
    }
  });

  it('lists the actions of a role in a stable order', () => {
    expect(actionsOf('cashier')).toEqual(ACTION_IDS.filter((action) => can('cashier', action)));
  });

  it('denies by default: an unknown role or an unknown action can do nothing', () => {
    expect(can('hacker' as never, 'sale:create')).toBe(false);
    expect(can('owner', 'sale:delete' as never)).toBe(false);
    expect(can(undefined as never, undefined as never)).toBe(false);
    expect(can('toString' as never, 'toString' as never)).toBe(false);
  });
});

describe('what works without a connection (the owner of the project decided: the counter yes, the administration no)', () => {
  const offline = ACTION_IDS.filter((action) => isAvailableOffline(action)).sort();

  it('is the work at the counter: selling, collecting cash, the shift and looking things up', () => {
    expect(offline).toEqual(
      [
        'payment:collect-cash',
        'product:view',
        'sale:create',
        'sale:view-own-shift',
        'shift:close',
        'shift:open',
        'stock:view',
      ].sort(),
    );
  });

  it.each([
    'product:manage',
    'price:update',
    'stock:adjust',
    'purchase:create',
    'sale:void',
    'sale:view-all',
    'cash-movement:create',
    'shift:close-other',
    'report:sales',
    'report:stock',
    'report:profit',
    'user:manage-cashiers',
    'user:manage-admins',
    'business:settings',
    'device:enroll',
    'device:revoke',
  ] as Action[])('needs a connection: %s', (action) => {
    expect(isAvailableOffline(action)).toBe(false);
  });

  it('is open to every role, so that a role changed while a device was offline cannot block a sale already made', () => {
    for (const action of offline) {
      for (const role of ROLES) {
        expect(can(role, action), `${role} ${action}`).toBe(true);
      }
    }
  });

  it('treats an unknown action as unavailable', () => {
    expect(isAvailableOffline('sale:delete' as never)).toBe(false);
  });
});
