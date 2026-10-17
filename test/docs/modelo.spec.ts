import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// El Ciclo 1 congela el modelo del dominio (ADR 0020). Congelar solo sirve si algo avisa cuando el glosario, el
// mapa de contextos, el modelo de datos y las especificaciones ejecutables dejan de decir lo mismo.

const ROOT = resolve(import.meta.dirname, '../..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

const CONTEXTS = [
  'Identidad y acceso',
  'Catálogo',
  'Inventario',
  'Ventas',
  'Caja',
  'Reportes',
  'Sincronización',
];

const adrNumbers = (): string[] =>
  readdirSync(join(ROOT, 'docs/adr'))
    .map((name) => /^(\d{4})-/.exec(name)?.[1])
    .filter((number): number is string => number !== undefined);

describe('glossary after the freeze (ADR 0020)', () => {
  const glossary = read('docs/dominio/glosario.md');
  const terms = glossary
    .split(/^### /m)
    .slice(1)
    .map((block) => ({ name: (block.split('\n')[0] ?? '').trim(), body: block }));

  it('has terms', () => {
    expect(terms.length).toBeGreaterThanOrEqual(30);
  });

  it('says in its introduction that the model is frozen for what is in the delivery, and by which ADR', () => {
    const introduction = glossary.split(/^## /m)[0] ?? '';

    expect(introduction).toContain('ADR 0020');
    expect(introduction).toMatch(/congel/i);
    expect(introduction).toMatch(/fuera de la entrega/i);
  });

  it('leaves no term as a hypothesis unless it is outside the delivery', () => {
    const open = terms
      .filter((term) => /^\*\*Estado:\*\* Hipótesis\b/m.test(term.body))
      .filter((term) => !/fuera de la entrega/i.test(term.body))
      .map((term) => term.name);

    expect(open).toEqual([]);
  });

  it('only calls a term a hypothesis when the delivery leaves it out', () => {
    const hypotheses = terms.filter((term) => /^\*\*Estado:\*\* Hipótesis\b/m.test(term.body));

    expect(hypotheses.map((term) => term.name).sort()).toEqual(
      [
        'Cliente',
        'Conteo físico',
        'Cuenta por cobrar y por pagar',
        'Devolución',
        'Fiado',
        'Flujo de caja',
        'Gasto',
      ].sort(),
    );
  });

  it('makes every "Decidido" term cite an ADR that exists', () => {
    const known = new Set(adrNumbers());
    const problems: string[] = [];
    for (const term of terms) {
      const line = /^\*\*Estado:\*\* Decidido(.*)$/m.exec(term.body)?.[1];
      if (line === undefined) continue;
      const cited = [...line.matchAll(/\b(\d{4})\b/g)].map((match) => match[1] ?? '');
      if (cited.length === 0) problems.push(`${term.name}: no cita ningún ADR`);
      for (const number of cited) {
        if (!known.has(number)) problems.push(`${term.name}: el ADR ${number} no existe`);
      }
    }

    expect(problems).toEqual([]);
  });
});

describe('context map after the freeze (ADR 0020)', () => {
  const map = read('docs/dominio/mapa-de-contextos.md');

  it('no longer presents itself as a hypothesis', () => {
    expect(map).not.toMatch(/es una hipótesis/i);
    expect(map).toContain('ADR 0020');
  });

  it('has no open questions left', () => {
    expect(map).not.toMatch(/^## Preguntas abiertas/m);
    expect(map).toMatch(/^## Preguntas resueltas/m);
  });

  it('answers each of the eight questions with a link to the ADR that decided it', () => {
    const section = map.split(/^## Preguntas resueltas/m)[1] ?? '';
    const rows = section.split('\n').filter((line) => /^\| *[1-8] *\|/.test(line));

    expect(rows).toHaveLength(8);
    for (const row of rows) {
      const links = [...row.matchAll(/\]\((?:\.\.\/)?adr\/(\d{4})-[^)]+\.md\)/g)];
      expect(links.length, row).toBeGreaterThan(0);
      for (const link of links) {
        expect(Number(link[1])).toBeGreaterThanOrEqual(13);
        expect(Number(link[1])).toBeLessThanOrEqual(19);
      }
    }
  });

  it('marks no relation between contexts as a hypothesis', () => {
    expect(map).not.toMatch(/_Hipótesis\._/);
  });

  it('names the same seven contexts as the data model', () => {
    for (const context of CONTEXTS) {
      expect(map, context).toContain(`**${context}**`);
    }
  });
});

describe('docs/dominio/modelo-de-datos.md (ADR 0020)', () => {
  const model = read('docs/dominio/modelo-de-datos.md');

  /** Las filas de la tabla del catalogo: `| \`tabla\` | Contexto | ... |`. */
  const tables = [...model.matchAll(/^\| *`([a-z][a-z_]*)` *\| *([^|]+?) *\|/gm)].map((match) => ({
    name: match[1] ?? '',
    context: (match[2] ?? '').trim(),
  }));

  const entities = (): string[] => {
    const diagram = /```mermaid\s+erDiagram([\s\S]*?)```/.exec(model)?.[1] ?? '';
    const names = new Set<string>();
    // Una relacion: `BUSINESS ||--o{ BRANCH : tiene` (entidad, conector, entidad, dos puntos).
    for (const match of diagram.matchAll(/^\s*([A-Z][A-Z_]*)\s+\S+\s+([A-Z][A-Z_]*)\s*:/gm)) {
      names.add((match[1] ?? '').toLowerCase());
      names.add((match[2] ?? '').toLowerCase());
    }
    // Una entidad sin relaciones: `OPERATION {`.
    for (const match of diagram.matchAll(/^\s*([A-Z][A-Z_]*)\s*\{/gm)) {
      names.add((match[1] ?? '').toLowerCase());
    }
    return [...names].sort();
  };

  it('lists the tables of the delivery, each in one of the seven contexts', () => {
    expect(tables.length).toBeGreaterThanOrEqual(20);
    for (const table of tables) {
      expect(CONTEXTS, `${table.name}: ${table.context}`).toContain(table.context);
    }
  });

  it('does not list a table twice', () => {
    const names = tables.map((table) => table.name);

    expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
  });

  it('draws in the diagram exactly the tables it lists', () => {
    expect(entities()).toEqual(tables.map((table) => table.name).sort());
  });

  it('contains the tables that the executable specifications of the cycle build', () => {
    const built = new Set<string>();
    const support = join(ROOT, 'test/integration/support');
    for (const file of readdirSync(support)) {
      const path = join(support, file);
      if (!existsSync(path) || !file.endsWith('-design.ts')) continue;
      for (const match of readFileSync(path, 'utf8').matchAll(
        /CREATE TABLE \$\{[A-Z_]+\}\.([a-z_]+)/g,
      )) {
        built.add(match[1] ?? '');
      }
    }

    expect(built.size).toBeGreaterThanOrEqual(9);
    expect([...built].filter((name) => !tables.some((table) => table.name === name))).toEqual([]);
  });

  it('keeps the table of names, which is the rule the tests rely on, in the document', () => {
    expect(model).toContain('id_negocio');
    expect(model).toMatch(/snake_case/);
    expect(model).toContain('ADR 0020');
  });

  it('says what stays out of the delivery', () => {
    for (const out of ['customer', 'receivable', 'expense', 'physical_count']) {
      expect(model, out).toContain(out);
      expect(
        tables.some((table) => table.name === out),
        out,
      ).toBe(false);
    }
  });
});
