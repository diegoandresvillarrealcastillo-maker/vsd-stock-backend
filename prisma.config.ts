import { defineConfig } from 'prisma/config';

// Prisma 7 ya no lee el .env por si solo: se carga aqui, y sin .env las variables salen del entorno (CI, host).
try {
  process.loadEnvFile();
} catch {
  // Sin .env: no pasa nada.
}

// La URL de la migracion es la del rol que es DUENO de las tablas (ADR 0005 y 0021), nunca la de la aplicacion.
// Sin ella, `prisma generate` y `prisma validate` siguen funcionando; solo los comandos que tocan la base la exigen.
const url = process.env['DATABASE_MIGRATION_URL'];

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: url === undefined || url === '' ? {} : { url },
});
