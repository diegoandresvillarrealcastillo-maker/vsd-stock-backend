import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import mutationConfig from '../../vitest.mutation.config.mts';

// Las roturas a proposito (Stryker, C3-17) son una barrera que nadie ve hasta que falla: si el archivo de configuracion pierde un
// patron, si el trabajo del CI cambia de nombre o si alguien lo vuelve obligatorio sin querer, no avisa. Estas pruebas vigilan la
// configuracion, el script, el trabajo del CI y lo que CONTRIBUTING.md le dice a la persona que contribuye.
const raiz = resolve(import.meta.dirname, '../..');

function leer(ruta: string): string {
  expect(existsSync(resolve(raiz, ruta)), `falta ${ruta}`).toBe(true);
  return readFileSync(resolve(raiz, ruta), 'utf8').replaceAll('\r\n', '\n');
}

/** Una frase de un documento como se lee: partida entre dos lineas (Prettier ajusta la prosa) sigue siendo la misma frase. */
function prosa(ruta: string): string {
  return leer(ruta).replaceAll(/\s+/g, ' ');
}

interface Configuracion {
  testRunner: string;
  mutate: string[];
  coverageAnalysis: string;
  reporters: string[];
  htmlReporter: { fileName: string };
  jsonReporter: { fileName: string };
  thresholds: { high: number; low: number; break: number };
  incremental: boolean;
  incrementalFile: string;
  vitest?: { configFile?: string };
}

const configuracion = JSON.parse(leer('stryker.config.json')) as Configuracion;
const paquete = JSON.parse(leer('package.json')) as {
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
  overrides?: Record<string, Record<string, string>>;
};
const flujo = leer('.github/workflows/ci.yml');

/** El bloque de un trabajo del CI: desde su clave hasta el siguiente trabajo (dos espacios de sangria y dos puntos). */
function trabajo(clave: string): string {
  const inicio = flujo.search(new RegExp(`^  ${clave}:$`, 'm'));
  expect(inicio, `falta el trabajo ${clave} en ci.yml`).toBeGreaterThanOrEqual(0);
  const resto = flujo.slice(inicio + 1);
  const siguiente = resto.search(/^ {2}[a-z][a-z0-9_-]*:$/m);
  return siguiente === -1 ? resto : resto.slice(0, siguiente);
}

describe('stryker.config.json', () => {
  it('uses the Vitest runner, with a configuration of its own for the tests it repeats', () => {
    expect(configuracion.testRunner).toBe('vitest');
    expect(configuracion.vitest?.configFile).toBe('vitest.mutation.config.mts');
  });

  it.each(['src/domain/**/*.ts', 'src/application/**/*.ts'])('mutates %s', (patron) => {
    expect(configuracion.mutate).toContain(patron);
  });

  it.each(['!src/**/*.spec.ts', '!src/**/*.d.ts'])('leaves out %s', (patron) => {
    expect(configuracion.mutate).toContain(patron);
  });

  it('does not mutate the adapters, the infrastructure or the generated client: only the layers with logic', () => {
    for (const patron of configuracion.mutate) {
      expect(patron).not.toMatch(/adapters|infrastructure|generated/);
    }
  });

  it('only runs the tests that touch what it breaks, so a run takes minutes and not hours', () => {
    expect(configuracion.coverageAnalysis).toBe('perTest');
  });

  it('has a score threshold with a floor that breaks the run, ordered and above zero', () => {
    const { high, low, break: floor } = configuracion.thresholds;

    expect(floor).toBeGreaterThan(0);
    expect(low).toBeGreaterThan(floor);
    expect(high).toBeGreaterThan(low);
    expect(high).toBeLessThanOrEqual(100);
  });

  it('has a floor that notices a real drop: the base measured 87,50 % and a floor far below it would never fail', () => {
    expect(configuracion.thresholds.break).toBeGreaterThanOrEqual(80);
    expect(configuracion.thresholds.break).toBeLessThanOrEqual(87);
  });

  it('only repeats what changed since the last run, and keeps that memory under reports/', () => {
    expect(configuracion.incremental).toBe(true);
    expect(configuracion.incrementalFile).toBe('reports/stryker-incremental.json');
  });

  it.each([
    ['htmlReporter', 'html'],
    ['jsonReporter', 'json'],
  ] as const)(
    'writes the %s report under reports/mutation, which is not versioned',
    (clave, tipo) => {
      expect(configuracion.reporters).toContain(tipo);
      expect(configuracion[clave].fileName).toMatch(/^reports\/mutation\//);
      expect(leer('.gitignore')).toMatch(/^\/?reports\/$/m);
    },
  );

  it('keeps its temporary copy out of version control, of the formatter and of the linter', () => {
    expect(leer('.gitignore')).toMatch(/^\.stryker-tmp\/$/m);
    expect(leer('.prettierignore')).toMatch(/^reports\/$/m);
    expect(leer('.prettierignore')).toMatch(/^\.stryker-tmp\/$/m);
    expect(leer('eslint.config.mjs')).toContain("'reports/**'");
    expect(leer('eslint.config.mjs')).toContain("'.stryker-tmp/**'");
  });
});

describe('vitest.mutation.config.mts', () => {
  const pruebas = mutationConfig.test;

  it('only repeats the specs of the layers it breaks and the calculation vectors of the contract', () => {
    expect(pruebas?.include).toEqual([
      'src/domain/**/*.spec.ts',
      'src/application/**/*.spec.ts',
      'test/contract/calculation-vectors.spec.ts',
    ]);
  });

  it('gives each test room to run broken and instrumented: the default 5 s is not enough', () => {
    expect(pruebas?.testTimeout).toBeGreaterThanOrEqual(30_000);
  });

  it('keeps what the specs of those layers need from the project configuration', () => {
    expect(pruebas?.environment).toBe('node');
    expect(pruebas?.setupFiles).toBeUndefined();
  });

  it('does not measure coverage: it only repeats tests', () => {
    expect(pruebas?.coverage?.enabled).toBe(false);
  });

  it('is part of what the type checker and the linter read', () => {
    expect(leer('tsconfig.test.json')).toContain('"vitest.mutation.config.mts"');
    expect(leer('tsconfig.eslint.json')).toContain('"vitest.mutation.config.mts"');
  });
});

describe('package.json', () => {
  it('runs it with npm run mutation, through the script that fixes the Vitest runner first', () => {
    expect(paquete.scripts['mutation']).toBe('node scripts/mutation.ts');
    expect(existsSync(resolve(raiz, 'scripts/mutation.ts'))).toBe(true);
  });

  it('knows the version of the Vitest runner it repairs: another one is looked at before it runs', () => {
    const instalado = JSON.parse(
      leer('node_modules/@stryker-mutator/vitest-runner/package.json'),
    ) as {
      version: string;
    };

    expect(instalado.version).toBe('10.0.0');
  });

  it('pins the core and the Vitest runner to the same major version', () => {
    const nucleo = paquete.devDependencies['@stryker-mutator/core'];
    const runner = paquete.devDependencies['@stryker-mutator/vitest-runner'];

    expect(nucleo).toMatch(/^\^\d+\.\d+\.\d+$/);
    expect(runner).toBe(nucleo);
  });

  it('keeps the HTTP client that Stryker brings on a version of qs without known advisories', () => {
    // typed-rest-client 2.3.1 fija qs en 6.15.1 y npm audit lo marca; el override lo sube sin tocar el codigo de nadie.
    expect(paquete.overrides?.['typed-rest-client']?.['qs']).toBe('^6.16.1');

    const instalado = JSON.parse(leer('node_modules/qs/package.json')) as { version: string };
    const [mayor, menor] = instalado.version.split('.').map(Number);

    expect(mayor).toBe(6);
    expect(menor).toBeGreaterThanOrEqual(16);
  });
});

describe('the job of the CI', () => {
  it('is called «Roturas a proposito (Stryker)», a name nobody renames by accident', () => {
    expect(trabajo('roturas')).toContain('name: Roturas a proposito (Stryker)');
  });

  it('runs npm run mutation on an installed copy of the project', () => {
    const bloque = trabajo('roturas');

    expect(bloque).toContain('run: npm ci');
    expect(bloque).toContain('run: npm run mutation');
  });

  it('saves the report as an artifact even when the run falls under the threshold', () => {
    const bloque = trabajo('roturas');

    expect(bloque).toMatch(/if: always\(\)\n\s+uses: actions\/upload-artifact@/);
    expect(bloque).toContain('name: informes-roturas');
    expect(bloque).toContain('path: reports/mutation/');
  });

  it('has a time limit that fits a first run without memory, and not more: a run that hangs does not hold the CI for hours', () => {
    const minutos = Number(/timeout-minutes: (\d+)/.exec(trabajo('roturas'))?.[1]);

    // La primera corrida, sin nada guardado, puede tardar mas de una hora en un ejecutor de pocos nucleos.
    expect(minutos).toBeGreaterThanOrEqual(90);
    expect(minutos).toBeLessThanOrEqual(150);
  });

  it('keeps what a run learned and uses it in the next one: restores the memory before and saves it after, even if the score is low', () => {
    const bloque = trabajo('roturas');
    const restaurar = bloque.indexOf('actions/cache/restore@');
    const correr = bloque.indexOf('run: npm run mutation');
    const guardar = bloque.indexOf('actions/cache/save@');

    expect(restaurar).toBeGreaterThan(-1);
    expect(restaurar).toBeLessThan(correr);
    expect(guardar).toBeGreaterThan(correr);
    expect(bloque).toMatch(/if: always\(\)\n\s+uses: actions\/cache\/save@/);
    expect(bloque.match(/path: reports\/stryker-incremental\.json/g)).toHaveLength(2);
  });

  it('asks for the memory of its own branch first and of the base branch after, and never shares it with another job', () => {
    const bloque = trabajo('roturas');

    expect(bloque).toContain('restore-keys: |');
    expect(bloque).toMatch(
      /restore-keys: \|\n\s+roturas-\$\{\{ github\.head_ref \|\| github\.ref_name \}\}-\n\s+roturas-\$\{\{ github\.base_ref \|\| github\.ref_name \}\}-/,
    );
    expect(bloque).toContain(
      'key: roturas-${{ github.head_ref || github.ref_name }}-${{ github.run_id }}',
    );
  });

  it('is red when it falls under the threshold: it does not hide it with continue-on-error', () => {
    const sinComentarios = trabajo('roturas')
      .split('\n')
      .filter((linea) => !linea.trimStart().startsWith('#'))
      .join('\n');

    expect(sinComentarios).not.toContain('continue-on-error');
  });

  it('blocks nothing: no other job waits for it', () => {
    expect(flujo.match(/needs:.*roturas/g)).toBeNull();
  });

  it.each(['secretos', 'commits', 'calidad', 'integracion', 'imagen'])(
    'leaves the required job %s as it was, with its name',
    (clave) => {
      expect(trabajo(clave)).toMatch(/^ {4}name: .+$/m);
    },
  );
});

describe('CONTRIBUTING.md', () => {
  const guia = prosa('CONTRIBUTING.md');

  it('explains how to run it and where the report is left', () => {
    expect(guia).toContain('npm run mutation');
    expect(guia).toContain('reports/mutation/mutation.html');
  });

  it('says what it breaks and that it is not a required check yet', () => {
    expect(guia).toContain('Stryker');
    expect(guia).toContain('domain/');
    expect(guia).toContain('application/');
    expect(guia).toContain('Roturas a proposito (Stryker)');
    expect(guia).toMatch(/no es obligatori[oa]/);
  });

  it('says the threshold that is in the configuration, not another one', () => {
    const { high, low, break: floor } = configuracion.thresholds;

    expect(guia).toContain(`${String(floor)} %`);
    expect(guia).toContain(`${String(low)} %`);
    expect(guia).toContain(`${String(high)} %`);
  });
});
