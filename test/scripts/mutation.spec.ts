import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  BROKEN_FILTER,
  FIXED_FILTER,
  RUNNER_FILE,
  fixRunner,
  prepareRunner,
  type Io,
} from '../../scripts/mutation.ts';

// `npm run mutation` repara una incompatibilidad conocida entre el runner de Vitest de Stryker 10.0.0 y Vitest 5 antes de correr:
// el runner busca la prueba de cada rotura por su nombre con los nombres unidos por espacios, y Vitest 5 los une con « > », asi que
// no encuentra ninguna, no corre ninguna prueba y todas las roturas «sobreviven» (puntaje 0 con un codigo bien probado).
// Estas pruebas vigilan la reparacion: que cambie lo que debe, que se pueda repetir y que avise cuando el runner ya no es el que se conoce.

const original = `const regex = parsedTests
  ${BROKEN_FILTER}
  .join('|');
`;

function io(contenido: string | null): { io: Io; escrituras: string[]; lineas: string[] } {
  const escrituras: string[] = [];
  const lineas: string[] = [];
  return {
    escrituras,
    lineas,
    io: {
      readFile: () => {
        if (contenido === null) throw new Error('ENOENT');
        return contenido;
      },
      writeFile: (_ruta, nuevo) => {
        escrituras.push(nuevo);
      },
      log: (linea) => lineas.push(linea),
    },
  };
}

describe('fixRunner', () => {
  it('makes each space of a test name also match the separator Vitest 5 puts between the names', () => {
    const { source, status } = fixRunner(original);

    expect(status).toBe('fixed');
    expect(source).toContain(FIXED_FILTER);
    expect(source).not.toContain(BROKEN_FILTER);
  });

  it('only adds the change of the spaces to the line of the runner: the repaired line is the original plus that', () => {
    expect(FIXED_FILTER.replace(".replace(/ /g, '(?: > | )')", '')).toBe(BROKEN_FILTER);
  });

  it('leaves everything else of the runner as it was', () => {
    const { source } = fixRunner(`antes\n${original}despues\n`);

    expect(source.startsWith('antes\n')).toBe(true);
    expect(source.endsWith(".join('|');\ndespues\n")).toBe(true);
  });

  it('can be repeated: what is already fixed is not fixed again', () => {
    const una = fixRunner(original);
    const dos = fixRunner(una.source);

    expect(dos.status).toBe('already-fixed');
    expect(dos.source).toBe(una.source);
  });

  it('says that the runner changed when it has neither the broken line nor the fixed one', () => {
    expect(fixRunner('otra cosa').status).toBe('unknown');
  });

  describe('the line it writes, run as the runner runs it', () => {
    /** Lo que el runner arma con el nombre de una prueba, ejecutando la linea reparada tal como queda en su codigo. */
    function patronDe(nombre: string): RegExp {
      const escapeRegExp = (texto: string) => texto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const [patron] = runInNewContext(`[{ test: ${JSON.stringify(nombre)} }]${FIXED_FILTER}`, {
        escapeRegExp,
      }) as string[];
      return new RegExp(patron ?? '');
    }

    it('finds a test whichever way its names are joined', () => {
      const patron = patronDe('splitTaxIncluded takes the VAT out');

      expect(patron.test('splitTaxIncluded > takes the VAT out')).toBe(true);
      expect(patron.test('splitTaxIncluded takes the VAT out')).toBe(true);
    });

    it('finds a test that is inside several describes with names of several words', () => {
      const patron = patronDe('outer words inner words test words');

      expect(patron.test('outer words > inner words > test words')).toBe(true);
    });

    it('does not find another test', () => {
      const patron = patronDe('splitTaxIncluded takes the VAT out');

      expect(patron.test('splitTaxIncluded > takes the tax out')).toBe(false);
    });

    it('keeps the special characters of a name as plain text', () => {
      const patron = patronDe('adds (a + b) * 2');

      expect(patron.test('math > adds (a + b) * 2')).toBe(true);
      expect(patron.test('math > adds a + b * 2')).toBe(false);
    });
  });
});

describe('prepareRunner', () => {
  it('writes the fixed runner and says so', () => {
    const { io: puerto, escrituras, lineas } = io(original);

    prepareRunner(puerto);

    expect(escrituras).toHaveLength(1);
    expect(escrituras[0]).toContain(FIXED_FILTER);
    expect(lineas.join('\n')).toContain('reparado');
  });

  it('does not write again what is already fixed', () => {
    const { io: puerto, escrituras, lineas } = io(fixRunner(original).source);

    prepareRunner(puerto);

    expect(escrituras).toEqual([]);
    expect(lineas.join('\n')).toContain('ya estaba reparado');
  });

  it('stops with a message that says what to do when the runner is not the one it knows', () => {
    const { io: puerto, escrituras } = io('otra cosa');

    expect(() => {
      prepareRunner(puerto);
    }).toThrow(/@stryker-mutator\/vitest-runner salio con soporte para Vitest 5/);
    expect(() => {
      prepareRunner(puerto);
    }).toThrow(/scripts\/mutation\.ts/);
    expect(escrituras).toEqual([]);
  });

  it('stops saying that the runner is not installed when it can not read it', () => {
    expect(() => {
      prepareRunner(io(null).io);
    }).toThrow(/npm ci/);
  });

  it('works on the file of the runner inside node_modules', () => {
    expect(RUNNER_FILE).toBe(
      'node_modules/@stryker-mutator/vitest-runner/dist/src/vitest-test-runner.js',
    );
  });

  it('knows the runner that is installed, repaired or not: its line is the one the script looks for', () => {
    // Si la linea que busca el script no es la del runner de verdad, `npm run mutation` se detendria sin razon.
    const instalado = readFileSync(RUNNER_FILE, 'utf8');

    expect(fixRunner(instalado).status).not.toBe('unknown');
  });
});
