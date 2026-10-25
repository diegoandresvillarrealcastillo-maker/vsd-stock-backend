import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// La documentacion se actualiza en el mismo PR que el codigo (ADR 0010), y lo que
// un PR no actualiza se descubre tarde. Estas pruebas vigilan lo que se puede
// comprobar sin leer: que los enlaces lleguen, que los indices esten completos,
// que cada variable de entorno este explicada y que el glosario no pase una
// hipotesis por una decision.

const ROOT = resolve(import.meta.dirname, '../..');
const IGNORED = new Set(['node_modules', 'dist', 'coverage', '.git']);

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

function markdownFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (IGNORED.has(entry.name)) continue;
    const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) found.push(...markdownFiles(path));
    else if (entry.name.endsWith('.md')) found.push(path);
  }
  return found;
}

/** Los enlaces que apuntan a otro archivo del repositorio, sin los que estan dentro de bloques de codigo. */
function relativeLinks(source: string): string[] {
  const withoutCode = source.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  const targets: string[] = [];
  for (const match of withoutCode.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = match[1] ?? '';
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    targets.push(target.replace(/^<|>$/g, '').split('#')[0] ?? '');
  }
  return targets.filter((target) => target !== '');
}

const documents = [
  'README.md',
  'CONTRIBUTING.md',
  ...markdownFiles('docs'),
  ...markdownFiles('.github'),
];

describe('documentation: links', () => {
  it('every relative link points to a file that exists', () => {
    const broken: string[] = [];
    for (const document of documents) {
      for (const target of relativeLinks(read(document))) {
        if (!existsSync(resolve(ROOT, dirname(document), target))) {
          broken.push(`${document} -> ${target}`);
        }
      }
    }

    expect(broken).toEqual([]);
  });
});

describe('documentation: indexes', () => {
  it('the ADR index lists every ADR file, and only those', () => {
    const files = readdirSync(join(ROOT, 'docs/adr'))
      .filter((name) => /^\d{4}-.+\.md$/.test(name))
      .sort();
    const indexed = [...read('docs/adr/README.md').matchAll(/\]\((\d{4}-[^)]+\.md)\)/g)]
      .map((match) => match[1] ?? '')
      .sort();

    expect(indexed).toEqual(files);
  });

  it('docs/README.md is the index of the documentation: it links every document under docs/', () => {
    const linked = new Set(
      relativeLinks(read('docs/README.md')).map((target) =>
        relative(ROOT, resolve(ROOT, 'docs', target)).replaceAll('\\', '/'),
      ),
    );
    const documented = markdownFiles('docs').filter(
      (path) => path !== 'docs/README.md' && !path.startsWith('docs/adr/'),
    );

    expect(documented.filter((path) => !linked.has(path))).toEqual([]);
  });

  it('docs/README.md also points to the ADR index', () => {
    expect(relativeLinks(read('docs/README.md'))).toContain('adr/README.md');
  });
});

describe('documentation: ADR format', () => {
  const adrs = readdirSync(join(ROOT, 'docs/adr'))
    .filter((name) => /^\d{4}-.+\.md$/.test(name))
    .sort()
    .map((name) => ({ name, text: read(`docs/adr/${name}`) }));

  it('finds the ADRs (so the checks below mean something)', () => {
    expect(adrs.length).toBeGreaterThanOrEqual(13);
  });

  it('numbers the ADRs without gaps or repetitions', () => {
    expect(adrs.map((adr) => Number(adr.name.slice(0, 4)))).toEqual(
      adrs.map((_, index) => index + 1),
    );
  });

  it('titles every ADR with its own number', () => {
    const wrong = adrs
      .filter((adr) => !adr.text.startsWith(`# ADR ${adr.name.slice(0, 4)} — `))
      .map((adr) => adr.name);

    expect(wrong).toEqual([]);
  });

  it('states status, date and cycle in the header', () => {
    const incomplete = adrs
      .filter(
        (adr) =>
          !/^- \*\*Estado:\*\* (Propuesta|Aceptada|Reemplazada|Rechazada)$/m.test(adr.text) ||
          !/^- \*\*Fecha:\*\* \d{4}-\d{2}-\d{2}$/m.test(adr.text) ||
          !/^- \*\*Ciclo:\*\* \d+$/m.test(adr.text),
      )
      .map((adr) => adr.name);

    expect(incomplete).toEqual([]);
  });

  it.each(['Contexto', 'Decisión', 'Alternativas consideradas', 'Consecuencias'])(
    'has the section "%s" in every ADR',
    (section) => {
      const without = adrs
        .filter((adr) => !new RegExp(`^## ${section}$`, 'm').test(adr.text))
        .map((adr) => adr.name);

      expect(without).toEqual([]);
    },
  );

  it('says what we lose: every ADR from 0013 on has an "En contra" section', () => {
    // Los anteriores no se editan (un ADR no se edita) y se escribieron antes de este control.
    const without = adrs
      .filter((adr) => Number(adr.name.slice(0, 4)) >= 13 && !/^### En contra$/m.test(adr.text))
      .map((adr) => adr.name);

    expect(without).toEqual([]);
  });
});

describe('documentation: environment variables', () => {
  // Tambien cuentan las que van comentadas: son las que solo lee quien las necesita (migraciones, pruebas).
  const variables = [...read('.env.example').matchAll(/^#? ?([A-Z][A-Z0-9_]*)=/gm)].map(
    (match) => match[1] ?? '',
  );

  it('.env.example declares at least one variable (so the checks below mean something)', () => {
    expect(variables.length).toBeGreaterThan(0);
  });

  it.each(['README.md', 'docs/ambientes.md'])(
    'every variable of .env.example is explained in %s',
    (document) => {
      const text = read(document);

      expect(variables.filter((name) => !text.includes(`\`${name}\``))).toEqual([]);
    },
  );
});

describe('documentation: GitHub guide', () => {
  const guide = (): string => read('docs/guia-github.md');
  // La seccion de PR apilados: de la pila del Ciclo 1 salieron tres trampas y las tres se evitan con una regla.
  const stacked = (): string =>
    (
      guide()
        .split(/^## /m)
        .find((block) => /^Cuando un cambio depende de otro/.test(block)) ?? ''
    ).replace(/\s+/g, ' ');

  it('has a section on stacked pull requests', () => {
    expect(stacked()).not.toBe('');
  });

  it('says to check that the next PR points at desarrollo before merging it', () => {
    expect(stacked()).toContain('su base ya dice `desarrollo`');
  });

  it('explains the approval that is dismissed after the merge-base changes, and how to fix it', () => {
    expect(stacked()).toContain('The merge-base changed after approval');
    expect(stacked()).toMatch(/cerrando y reabriendo el PR/);
  });

  it('explains why "Contrato con el backend" is red until the backend is merged', () => {
    expect(stacked()).toContain('Contrato con el backend');
    expect(stacked()).toMatch(/rama base del PR/);
  });

  // Un `overrides` fuerza una version que el paquete de origen no pide: si nadie anota por que esta ni cuando se quita, se queda para
  // siempre y esconde una dependencia vieja el dia que el origen ya trae el arreglo.
  const audit = (): string =>
    (
      guide()
        .split(/^## /m)
        .find((block) => /^Cuando «Vulnerabilidades en las dependencias»/.test(block)) ?? ''
    ).replace(/\s+/g, ' ');
  const overrides = (): Record<string, unknown> =>
    (JSON.parse(read('package.json')) as { overrides?: Record<string, unknown> }).overrides ?? {};

  it('has a section on what to do when the dependencies check turns red', () => {
    expect(audit()).not.toBe('');
    expect(audit()).toContain('`npm audit fix`');
    expect(audit()).toMatch(/Un aviso sin arreglo solo se acepta con una lista escrita/);
  });

  it('writes down every override of package.json, and when it goes away', () => {
    expect(Object.keys(overrides()).length).toBeGreaterThan(0);
    for (const name of Object.keys(overrides())) expect(audit(), name).toContain(`\`${name}\``);
    expect(audit()).toContain('Se quita cuando');
  });

  it('keeps multer on a version with the fix (2.5.0 or later), which the lockfile really resolves', () => {
    const lock = JSON.parse(read('package-lock.json')) as {
      packages: Record<string, { version?: string }>;
    };
    const [major = 0, minor = 0] = (lock.packages['node_modules/multer']?.version ?? '0.0.0')
      .split('.')
      .map(Number);

    expect(overrides()['multer']).toBe('^2.5.0');
    expect(major === 2 && minor >= 5).toBe(true);
  });
});

describe('documentation: glossary', () => {
  const glossary = () => read('docs/dominio/glosario.md');
  // Cada termino es un encabezado de tercer nivel y todo lo que sigue hasta el proximo encabezado.
  const terms = () =>
    glossary()
      .split(/^### /m)
      .slice(1)
      .map((block) => ({ name: (block.split('\n')[0] ?? '').trim(), body: block }));

  it('has terms', () => {
    expect(terms().length).toBeGreaterThanOrEqual(30);
  });

  it('marks every term as decided, required or hypothesis, so nobody takes a hypothesis for the model', () => {
    const unmarked = terms()
      .filter((term) => !/^\*\*Estado:\*\* (Decidido|Requisito|Hipótesis)\b/m.test(term.body))
      .map((term) => term.name);

    expect(unmarked).toEqual([]);
  });

  it('gives every term its identifier in code, or a dash when it has none', () => {
    const without = terms()
      .filter((term) => !/^\*\*Código:\*\* (`[^`]+`|—)/m.test(term.body))
      .map((term) => term.name);

    expect(without).toEqual([]);
  });

  it('does not repeat a term', () => {
    const names = terms().map((term) => term.name.toLowerCase());

    expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
  });

  it('says in its introduction how firm the model is, so nobody takes a hypothesis for a decision', () => {
    // Hasta el Ciclo 1 decia que no congelaba el modelo; el ADR 0020 lo congelo y test/docs/modelo.spec.ts vigila
    // lo que quedo congelado y lo que no.
    expect(glossary()).toMatch(/ADR 0020/);
    expect(glossary()).toMatch(/fuera de la entrega/i);
  });
});
