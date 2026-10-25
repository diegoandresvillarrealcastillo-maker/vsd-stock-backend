// Herramienta de linea de comandos que corre las roturas a proposito (Stryker, C3-17). Corre directamente en Node 24, que ejecuta
// TypeScript quitando los tipos: por eso este archivo no usa sintaxis que necesite compilarse ni importa otros archivos del proyecto.
//
//   node scripts/mutation.ts [argumentos de stryker]    (o: npm run mutation)
//
// Antes de correr Stryker repara una incompatibilidad conocida entre el runner de Vitest de Stryker 10.0.0 (14 de agosto) y Vitest 5
// (3 de septiembre): para correr solo las pruebas que tocan lo que rompe, el runner busca cada prueba por su nombre con los nombres
// unidos por espacios, y Vitest 5 compara contra los nombres unidos por « > ». No encuentra ninguna, no corre ninguna prueba y todas
// las roturas «sobreviven»: puntaje 0 con codigo bien probado, sin un solo error. La reparacion deja que cada espacio del nombre
// coincida tambien con « > ».
//
// Es temporal. Cuando salga un runner que soporte Vitest 5, este archivo y su prueba se borran. Mientras tanto, si el runner cambia y
// ya no trae ni la linea rota ni la reparada, el script se detiene y lo dice en vez de correr con un puntaje que miente.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const RUNNER_FILE =
  'node_modules/@stryker-mutator/vitest-runner/dist/src/vitest-test-runner.js';
const STRYKER_BIN = 'node_modules/@stryker-mutator/core/bin/stryker.js';

/** La linea del runner que arma la expresion con el nombre de cada prueba, tal como viene. */
export const BROKEN_FILTER = '.map(({ test: name }) => escapeRegExp(name))';
/** La misma linea con cada espacio del nombre aceptando tambien el separador de Vitest 5. */
export const FIXED_FILTER =
  ".map(({ test: name }) => escapeRegExp(name).replace(/ /g, '(?: > | )'))";

export interface Io {
  readFile: (path: string) => string;
  writeFile: (path: string, content: string) => void;
  log: (line: string) => void;
}

export interface Fix {
  source: string;
  /** `fixed`: se cambio la linea; `already-fixed`: ya estaba cambiada; `unknown`: el runner no es el que se conoce. */
  status: 'fixed' | 'already-fixed' | 'unknown';
}

/** Cambia la linea rota por la reparada en el codigo del runner. No toca nada mas, y se puede repetir. */
export function fixRunner(source: string): Fix {
  if (source.includes(FIXED_FILTER)) return { source, status: 'already-fixed' };
  if (!source.includes(BROKEN_FILTER)) return { source, status: 'unknown' };
  return { source: source.replace(BROKEN_FILTER, FIXED_FILTER), status: 'fixed' };
}

/** Deja el runner instalado reparado, o se detiene si no es el que se conoce o no esta instalado. */
export function prepareRunner(io: Io): void {
  let source: string;
  try {
    source = io.readFile(RUNNER_FILE);
  } catch {
    throw new Error(
      `No se pudo leer ${RUNNER_FILE}: el runner de Vitest de Stryker no esta instalado. Ejecuta \`npm ci\`.`,
    );
  }
  const fix = fixRunner(source);
  if (fix.status === 'unknown') {
    throw new Error(
      `El archivo ${RUNNER_FILE} ya no tiene la linea que se reparaba. Si @stryker-mutator/vitest-runner salio con soporte para ` +
        'Vitest 5, borra scripts/mutation.ts y su prueba y deja `"mutation": "stryker run"`; si no, revisa que cambio en el runner.',
    );
  }
  if (fix.status === 'already-fixed') {
    io.log('Runner de Vitest de Stryker: ya estaba reparado.');
    return;
  }
  io.writeFile(RUNNER_FILE, fix.source);
  io.log(
    'Runner de Vitest de Stryker: reparado para Vitest 5 (los nombres de las pruebas se unen con « > »).',
  );
}

const realIo: Io = {
  readFile: (path) => readFileSync(path, 'utf8'),
  writeFile: (path, content) => {
    writeFileSync(path, content, 'utf8');
  },
  log: (line) => {
    console.log(line);
  },
};

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  try {
    prepareRunner(realIo);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  const result = spawnSync(process.execPath, [STRYKER_BIN, 'run', ...process.argv.slice(2)], {
    stdio: 'inherit',
  });
  process.exitCode = result.status ?? 1;
}
