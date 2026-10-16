import { defineConfig } from 'vitest/config';

// Pruebas de integracion contra un PostgreSQL real (ADR 0005 y 0007).
//
// Se ejecutan en serie: en VSD Health, las suites de integracion en paralelo
// fallaban cerca de una de cada cuatro veces porque se pisaban entre si.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/integration/**/*.integration.spec.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 20_000,
    hookTimeout: 30_000,
    env: {
      // Base local de docker-compose.yml. El CI define su propia variable.
      TEST_DATABASE_URL:
        process.env['TEST_DATABASE_URL'] ?? 'postgresql://stock@127.0.0.1:5433/stock_test',
    },
  },
});
