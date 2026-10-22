import { defineConfig } from 'vitest/config';

// Pruebas de integracion contra un PostgreSQL real (ADR 0005, 0007 y 0021).
//
// Se ejecutan en serie: en VSD Health, las suites de integracion en paralelo
// fallaban cerca de una de cada cuatro veces porque se pisaban entre si.

// Base local de docker-compose.yml. El CI define su propia variable. Se fija aqui, en el proceso principal, para
// que tambien la vea el arranque global (que no recibe `test.env`) y los trabajadores de las pruebas.
process.env['TEST_DATABASE_URL'] ??= 'postgresql://stock@127.0.0.1:5433/stock_test';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/integration/**/*.integration.spec.ts'],
    // Antes de todo: roles, esquema real y migraciones (ver support/global-setup.ts).
    globalSetup: ['test/integration/support/global-setup.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
