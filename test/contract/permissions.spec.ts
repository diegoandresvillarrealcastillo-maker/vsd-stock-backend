import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERMISSIONS_PATH, renderPermissions } from '../../scripts/permissions.ts';
import { ACTIONS, ROLES, can, isAvailableOffline } from '../../src/domain/model/role.js';

// La tabla de permisos (ADR 0017) la usan los dos lados: la API la aplica y el cliente decide que ofrecer y que sigue
// funcionando sin red. Si el cliente trae una copia distinta, ofrece lo que el servidor va a negar. Este archivo es esa
// copia: sale del dominio y el frontend la compara byte a byte.

interface Permissions {
  version: number;
  roles: string[];
  actions: Record<string, { roles: string[]; offline: boolean }>;
}

const FILE = resolve(import.meta.dirname, '../..', PERMISSIONS_PATH);
const text = readFileSync(FILE, 'utf8');
const permissions = JSON.parse(text) as Permissions;

describe('contract/permissions.json', () => {
  it('is exactly what the generator produces from the domain (after changing the table run `npm run permissions`)', () => {
    expect(text).toBe(renderPermissions());
  });

  it('lists the three roles in order of responsibility', () => {
    expect(permissions.roles).toEqual([...ROLES]);
  });

  it('lists every action of the domain, in the same order, and no other', () => {
    expect(Object.keys(permissions.actions)).toEqual(Object.keys(ACTIONS));
  });

  it.each(Object.keys(ACTIONS))('agrees with the domain about %s', (action) => {
    const entry = permissions.actions[action]!;
    const domain = ACTIONS[action as keyof typeof ACTIONS];

    expect(entry.roles).toEqual([...domain.roles]);
    expect(entry.offline).toBe(domain.offline);
  });

  it('says for every role and action the same as the domain function that the server applies', () => {
    for (const role of ROLES) {
      for (const action of Object.keys(ACTIONS) as (keyof typeof ACTIONS)[]) {
        expect(permissions.actions[action]!.roles.includes(role), `${role} ${action}`).toBe(
          can(role, action),
        );
        expect(permissions.actions[action]!.offline, action).toBe(isAvailableOffline(action));
      }
    }
  });

  it('opens everything that works without a network to the three roles, as the ADR 0017 demands', () => {
    for (const [action, entry] of Object.entries(permissions.actions)) {
      if (entry.offline) expect(entry.roles, action).toEqual([...ROLES]);
    }
  });

  it('is versioned, so a client can refuse a file it does not understand', () => {
    expect(permissions.version).toBe(1);
  });
});
