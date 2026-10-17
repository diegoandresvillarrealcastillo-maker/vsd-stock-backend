import { defineConfig } from 'vitest/config';

// Mediciones contra un PostgreSQL real (ADR 0013). No son pruebas: imprimen
// una tabla y nunca fallan por lentas. Estan fuera del CI a proposito, porque
// los tiempos dependen del equipo y un umbral aqui seria una prueba inestable.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/benchmark/**/*.benchmark.spec.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    hookTimeout: 60_000,
    env: {
      TEST_DATABASE_URL:
        process.env['TEST_DATABASE_URL'] ?? 'postgresql://stock@127.0.0.1:5433/stock_test',
    },
  },
});
