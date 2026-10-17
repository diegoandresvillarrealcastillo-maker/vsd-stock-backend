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

describe('documentation: environment variables', () => {
  const variables = [...read('.env.example').matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map(
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

  it('says in its introduction that it does not freeze the model', () => {
    expect(glossary()).toMatch(/no congela el modelo/i);
  });
});
