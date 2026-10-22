import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import { boundaries } from './eslint/boundaries.mjs';

/**
 * Configuracion de ESLint para vsd-stock-backend.
 *
 * Las fronteras de la arquitectura hexagonal (ADR 0002) se imponen en
 * eslint/boundaries.mjs. Aqui van las reglas generales.
 */
export default tseslint.config(
  {
    // Los archivos de configuracion en .mjs quedan fuera del analisis con
    // tipos: no forman parte del codigo del proyecto y no estan en tsconfig.
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      '*.config.mjs',
      'eslint/**',
      // Codigo que genera Prisma a partir de prisma/schema.prisma: no se revisa ni se edita.
      'src/generated/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.eslint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // ---------- Fronteras de la arquitectura hexagonal (ADR 0002) ----------
  ...boundaries,

  // ---------- Convencion del guion bajo ----------
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          // Un nombre que empieza por guion bajo se descarta a proposito.
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
    },
  },

  // ---------- Eval ----------
  {
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.spec.ts'],
    rules: {
      'no-eval': 'error',
      'no-new-func': 'error',
    },
  },

  // ---------- Pruebas ----------
  {
    files: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    rules: {
      // En las pruebas se construyen dobles y datos a proposito imperfectos.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  prettier,
);
