import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    // Las de integracion necesitan una base de datos: tienen su propia
    // configuracion (vitest.integration.config.mts) y su propio script. Las
    // mediciones (test/benchmark) tambien: imprimen una tabla y no afirman nada.
    exclude: ['**/node_modules/**', '**/dist/**', 'test/integration/**', 'test/benchmark/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.spec.ts',
        // Arranque del proceso: solo se puede ejercitar levantando un
        // servidor que escuche de verdad. El cableado lo cubre la prueba
        // de integracion sobre AppModule.
        'src/infrastructure/main.ts',
      ],
      // El umbral se exige donde la cobertura significa algo: domain/ y
      // application/ son las capas con logica. infrastructure/ y adapters/
      // son cableado, y pedirles el mismo porcentaje empuja a escribir
      // pruebas sin valor.
      thresholds: {
        'src/domain/**': { statements: 80, branches: 80, functions: 80, lines: 80 },
        'src/application/**': { statements: 80, branches: 80, functions: 80, lines: 80 },
      },
    },
  },
});
