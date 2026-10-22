// Genera la tabla de permisos que comparten el backend y el frontend (ADR 0017).
//
//   node scripts/permissions.ts           escribe contract/permissions.json
//   node scripts/permissions.ts --check   falla si el archivo ya no coincide con el dominio
//
// A diferencia de los vectores de calculo (que se calculan APARTE del dominio para no repetir sus errores), aqui el
// dominio ES la fuente: src/domain/model/role.ts. Este archivo solo la copia en una forma que el cliente puede leer.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ACTIONS, ROLES } from '../src/domain/model/role.ts';

export const PERMISSIONS_PATH = 'contract/permissions.json';

export function renderPermissions(): string {
  const actions: Record<string, { roles: string[]; offline: boolean }> = {};
  for (const [name, definition] of Object.entries(ACTIONS)) {
    actions[name] = { roles: [...definition.roles], offline: definition.offline };
  }
  const document = {
    description:
      'Que puede hacer cada rol y si se puede hacer sin conexion (ADR 0017). La fuente es src/domain/model/role.ts; no se edita a mano: se regenera con `node scripts/permissions.ts`.',
    version: 1,
    roles: [...ROLES],
    actions,
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

function main(argv: string[]): number {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const path = resolve(root, PERMISSIONS_PATH);
  const expected = renderPermissions();
  if (argv.includes('--check')) {
    let current = '';
    try {
      current = readFileSync(path, 'utf8');
    } catch {
      // Si no existe, es lo mismo que estar desactualizado.
    }
    if (current !== expected) {
      console.error(
        `${PERMISSIONS_PATH} esta desactualizado. Regeneralo con: node scripts/permissions.ts`,
      );
      return 1;
    }
    console.log(`${PERMISSIONS_PATH} esta al dia`);
    return 0;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, expected);
  console.log(`Escribi ${PERMISSIONS_PATH}`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
