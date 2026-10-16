import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { boundaries } from '../../eslint/boundaries.mjs';

/**
 * Prueba de las fronteras de la arquitectura (ADR 0002).
 *
 * Cada caso lleva un archivo virtual en una capa y un trozo de codigo con un
 * import. Se ejecuta ESLint de verdad: si una frontera deja de imponerse, el
 * caso prohibido deja de fallar y esta prueba se rompe. Los casos permitidos
 * evitan el error contrario: una regla tan ancha que bloquee lo legitimo.
 */

const eslint = new ESLint({
  cwd: process.cwd(),
  overrideConfigFile: true,
  overrideConfig: [
    { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } },
    ...boundaries,
  ],
});

async function lint(filePath: string, code: string) {
  const [result] = await eslint.lintText(code, { filePath });
  return result?.messages ?? [];
}

interface Violation {
  readonly name: string;
  readonly file: string;
  readonly code: string;
  readonly rule: 'no-restricted-imports' | 'no-restricted-syntax';
  /** Palabra que el mensaje debe contener para que explique que hacer. */
  readonly hint: string;
}

const DOMAIN = 'src/domain/model/example.ts';
const DOMAIN_SPEC = 'src/domain/model/example.spec.ts';
const APPLICATION = 'src/application/usecases/example.ts';
const APPLICATION_SPEC = 'src/application/usecases/example.spec.ts';
const ADAPTER_IN = 'src/adapters/in/http/example.ts';
const ADAPTER_OUT = 'src/adapters/out/clock/example.ts';

const forbidden: readonly Violation[] = [
  {
    name: 'domain imports application',
    file: DOMAIN,
    code: "import { x } from '../../application/usecases/get-health.usecase.js';",
    rule: 'no-restricted-imports',
    hint: 'puerto',
  },
  {
    name: 'domain imports a type from adapters',
    file: DOMAIN,
    code: "import type { x } from '../../adapters/out/clock/system-clock.js';",
    rule: 'no-restricted-imports',
    hint: 'puerto',
  },
  {
    name: 'domain imports infrastructure',
    file: DOMAIN,
    code: "import { x } from '../../infrastructure/config/tokens.js';",
    rule: 'no-restricted-imports',
    hint: 'puerto',
  },
  {
    name: 'domain imports a framework',
    file: DOMAIN,
    code: "import { Injectable } from '@nestjs/common';",
    rule: 'no-restricted-imports',
    hint: 'puerto',
  },
  {
    name: 'domain imports a Node module',
    file: DOMAIN,
    code: "import { randomUUID } from 'node:crypto';",
    rule: 'no-restricted-imports',
    hint: 'puerto',
  },
  {
    name: 'domain re-exports from adapters',
    file: DOMAIN,
    code: "export { x } from '../../adapters/out/clock/system-clock.js';",
    rule: 'no-restricted-imports',
    hint: 'puerto',
  },
  {
    name: 'domain uses a dynamic import',
    file: DOMAIN,
    code: "const load = () => import('./other.js');",
    rule: 'no-restricted-syntax',
    hint: 'import estatico',
  },
  {
    name: 'domain uses require',
    file: DOMAIN,
    code: "const other = require('./other.js');",
    rule: 'no-restricted-syntax',
    hint: 'import estatico',
  },
  {
    name: 'a domain test imports application',
    file: DOMAIN_SPEC,
    code: "import { x } from '../../application/usecases/get-health.usecase.js';",
    rule: 'no-restricted-imports',
    hint: 'puerto',
  },
  {
    name: 'application imports adapters',
    file: APPLICATION,
    code: "import { x } from '../../adapters/out/clock/system-clock.js';",
    rule: 'no-restricted-imports',
    hint: 'puerto',
  },
  {
    name: 'application imports infrastructure',
    file: APPLICATION,
    code: "import { x } from '../../infrastructure/config/tokens.js';",
    rule: 'no-restricted-imports',
    hint: 'puerto',
  },
  {
    name: 'an application test imports adapters (not even tests may)',
    file: APPLICATION_SPEC,
    code: "import { x } from '../../adapters/out/clock/system-clock.js';",
    rule: 'no-restricted-imports',
    hint: 'puerto',
  },
  {
    name: 'application uses a dynamic import',
    file: APPLICATION,
    code: "const load = () => import('./other.js');",
    rule: 'no-restricted-syntax',
    hint: 'import estatico',
  },
  {
    name: 'an input adapter imports infrastructure',
    file: ADAPTER_IN,
    code: "import { CLOCK } from '../../../infrastructure/config/tokens.js';",
    rule: 'no-restricted-imports',
    hint: 'infrastructure',
  },
  {
    name: 'an output adapter imports infrastructure',
    file: ADAPTER_OUT,
    code: "import { CLOCK } from '../../../infrastructure/config/tokens.js';",
    rule: 'no-restricted-imports',
    hint: 'infrastructure',
  },
  {
    name: 'an input adapter imports an output adapter',
    file: ADAPTER_IN,
    code: "import { SystemClock } from '../../out/clock/system-clock.js';",
    rule: 'no-restricted-imports',
    hint: 'adapters/out',
  },
  {
    name: 'an output adapter imports an input adapter',
    file: ADAPTER_OUT,
    code: "import { HealthController } from '../../in/http/health.controller.js';",
    rule: 'no-restricted-imports',
    hint: 'adapters/in',
  },
];

const allowed: readonly { readonly name: string; readonly file: string; readonly code: string }[] =
  [
    {
      name: 'domain imports another file of the domain',
      file: DOMAIN,
      code: "import type { Clock } from '../ports/out/clock.js';",
    },
    {
      name: 'a domain test imports the test runner',
      file: DOMAIN_SPEC,
      code: "import { describe, it } from 'vitest';",
    },
    {
      name: 'application imports the domain',
      file: APPLICATION,
      code: "import type { Clock } from '../../domain/ports/out/clock.js';",
    },
    {
      name: 'an application test imports the test runner',
      file: APPLICATION_SPEC,
      code: "import { describe, it } from 'vitest';",
    },
    {
      name: 'an input adapter imports application, domain and a framework',
      file: ADAPTER_IN,
      code: [
        "import { Controller } from '@nestjs/common';",
        "import { GetHealthUseCase } from '../../../application/usecases/get-health.usecase.js';",
        "import type { Clock } from '../../../domain/ports/out/clock.js';",
      ].join('\n'),
    },
    {
      name: 'an output adapter implements a port of the domain',
      file: ADAPTER_OUT,
      code: "import type { Clock } from '../../../domain/ports/out/clock.js';",
    },
    {
      name: 'infrastructure wires adapters, application and domain',
      file: 'src/infrastructure/config/example.ts',
      code: [
        "import { HealthController } from '../../adapters/in/http/health.controller.js';",
        "import { SystemClock } from '../../adapters/out/clock/system-clock.js';",
        "import { GetHealthUseCase } from '../../application/usecases/get-health.usecase.js';",
        "import type { Clock } from '../../domain/ports/out/clock.js';",
      ].join('\n'),
    },
  ];

describe('architecture boundaries (ADR 0002)', () => {
  it.each(forbidden)('rejects: $name', async ({ file, code, rule, hint }) => {
    const messages = await lint(file, code);

    expect(messages.filter((m) => m.fatal === true)).toEqual([]);
    const violation = messages.find((m) => m.ruleId === rule);
    expect(violation, `${file} should be rejected by ${rule}`).toBeDefined();
    expect(violation?.severity).toBe(2);
    expect(violation?.message).toContain(hint);
  });

  it.each(allowed)('accepts: $name', async ({ file, code }) => {
    const messages = await lint(file, code);

    expect(messages).toEqual([]);
  });

  it('is applied by the real ESLint config of the project, not only by this test', async () => {
    const real = new ESLint({ cwd: process.cwd() });

    const config = (await real.calculateConfigForFile('src/domain/model/example.ts')) as {
      rules?: Record<string, unknown>;
    };

    const rule = config.rules?.['no-restricted-imports'];
    expect(Array.isArray(rule) ? rule[0] : rule).toBeOneOf([2, 'error']);
  });
});
