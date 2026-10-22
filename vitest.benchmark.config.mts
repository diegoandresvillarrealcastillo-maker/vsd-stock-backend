import { defineConfig } from 'vitest/config';

// Mediciones contra un PostgreSQL real (ADR 0013) sobre las tablas reales (ADR 0021). No son pruebas: imprimen
// una tabla y nunca fallan por lentas. Estan fuera del CI a proposito, porque los tiempos dependen del equipo y
// un umbral aqui seria una prueba inestable.
process.env['TEST_DATABASE_URL'] ??= 'postgresql://stock@127.0.0.1:5433/stock_test';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/benchmark/**/*.benchmark.spec.ts'],
    // Deja la base con el esquema real antes de medir (ver test/integration/support/global-setup.ts).
    globalSetup: ['test/integration/support/global-setup.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    hookTimeout: 60_000,
  },
});
