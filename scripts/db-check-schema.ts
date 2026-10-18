import { diffSchema, ownerUrlOf, DEFAULT_TEST_DATABASE_URL } from './prepare-database.ts';
import { assertDisposableDatabase } from './database-target.ts';

// npm run db:check-schema: compara prisma/schema.prisma con la base de pruebas ya preparada (npm run db:prepare).
const url = process.env['TEST_DATABASE_URL'] ?? DEFAULT_TEST_DATABASE_URL;
assertDisposableDatabase(url);
const result = diffSchema(ownerUrlOf(url));
if (result.identical) {
  console.log('prisma/schema.prisma y la base migrada dicen lo mismo.');
} else {
  console.error(
    'prisma/schema.prisma y la base migrada NO coinciden. Lo que le falta a la base:\n',
  );
  console.error(result.output);
  process.exit(1);
}
