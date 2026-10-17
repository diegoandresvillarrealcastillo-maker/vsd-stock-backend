import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACTIONS, ROLES, type Action, type Role } from '../../src/domain/model/role.js';

// El documento de permisos (docs/dominio/permisos.md) es lo que lee una persona; ACTIONS es lo que ejecuta el
// sistema. Si dicen cosas distintas, alguien decide con la tabla equivocada. Esta prueba las compara fila por fila.

const DOCUMENT = resolve(import.meta.dirname, '../../docs/dominio/permisos.md');
const COLUMNS: Role[] = ['owner', 'admin', 'cashier'];

interface Row {
  action: string;
  roles: Role[];
  offline: boolean;
}

function readTable(): Row[] {
  const rows: Row[] = [];
  for (const line of readFileSync(DOCUMENT, 'utf8').split('\n')) {
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    const id = /^`([a-z-]+:[a-z-]+)`$/.exec(cells[0] ?? '')?.[1];
    if (id === undefined || cells.length !== 6) continue;
    const mark = (cell: string | undefined): boolean => {
      if (cell !== 'Sí' && cell !== '—')
        throw new Error(`Celda ilegible en la fila ${id}: «${cell}»`);
      return cell === 'Sí';
    };
    rows.push({
      action: id,
      roles: COLUMNS.filter((_, index) => mark(cells[2 + index])),
      offline: mark(cells[5]),
    });
  }
  return rows;
}

describe('docs/dominio/permisos.md', () => {
  const rows = readTable();

  it('has a row for every action, once, and no other', () => {
    expect(rows.map((row) => row.action).sort()).toEqual(Object.keys(ACTIONS).sort());
  });

  it.each(Object.keys(ACTIONS) as Action[])(
    'says the same as the code about who may do %s',
    (action) => {
      const row = rows.find((candidate) => candidate.action === action);

      expect(row?.roles).toEqual(
        ROLES.filter((role) => (ACTIONS[action].roles as readonly string[]).includes(role)),
      );
    },
  );

  it.each(Object.keys(ACTIONS) as Action[])(
    'says the same as the code about %s without a connection',
    (action) => {
      const row = rows.find((candidate) => candidate.action === action);

      expect(row?.offline).toBe(ACTIONS[action].offline);
    },
  );

  it('explains the three roles and the rule for working offline', () => {
    const text = readFileSync(DOCUMENT, 'utf8');

    for (const word of ['Dueño', 'Administrador', 'Cajero', 'sin conexión', 'ADR 0017']) {
      expect(text, word).toContain(word);
    }
  });
});
