import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  describeDatabaseTarget,
  formatDatabaseTarget,
  isConfirmed,
  requiresConfirmation,
} from './database-target.ts';
import { migrateDeploy } from './prepare-database.ts';

// npm run db:migrate: aplica las migraciones de prisma/migrations a la base de DATABASE_MIGRATION_URL.
//
// Lo corre UNA PERSONA (ADR 0010). Antes de tocar nada dice a donde va, sin la contrasena, y si esa base no esta en
// esta maquina pide escribir el host: una migracion aplicada al ambiente equivocado no se deshace.
try {
  process.loadEnvFile();
} catch {
  // Sin .env: la variable puede venir del entorno.
}

const url = process.env['DATABASE_MIGRATION_URL'];
if (url === undefined || url === '') {
  console.error(
    'Falta DATABASE_MIGRATION_URL: la cadena de conexion del rol dueno de las tablas. Ver docs/ambientes.md.',
  );
  process.exit(1);
}

const target = describeDatabaseTarget(url);
console.log(`Las migraciones se aplicaran a: ${formatDatabaseTarget(target)}`);

if (requiresConfirmation(target)) {
  if (!stdin.isTTY) {
    console.error(
      'Esa base no esta en esta maquina y no hay una terminal donde confirmar: no se aplica nada.',
    );
    process.exit(1);
  }
  const terminal = createInterface({ input: stdin, output: stdout });
  const typed = await terminal.question(
    `Para confirmar, escribe el host (${target.host}). Enter vacio cancela: `,
  );
  terminal.close();
  if (!isConfirmed(typed, target)) {
    console.error('No coincide: no se aplica nada.');
    process.exit(1);
  }
}

migrateDeploy(url);
console.log('Migraciones aplicadas.');
