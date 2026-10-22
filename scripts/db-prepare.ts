import { DEFAULT_TEST_DATABASE_URL, prepareDatabase } from './prepare-database.ts';
import { describeDatabaseTarget, formatDatabaseTarget } from './database-target.ts';

// npm run db:prepare: deja la base local de pruebas (npm run db:up) con el esquema real.
const url = process.env['TEST_DATABASE_URL'] ?? DEFAULT_TEST_DATABASE_URL;
console.log(`Preparando ${formatDatabaseTarget(describeDatabaseTarget(url))} ...`);
await prepareDatabase(url);
console.log('Lista: roles creados, esquema recreado y migraciones aplicadas.');
