import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TAX_KINDS } from '../../src/domain/model/tax.js';

// El tipo tributario (ADR 0034) toca el modelo congelado (ADR 0020): una columna en `product` y otra en `sale_line`, una regla contra la
// tarifa y un campo nuevo en el contrato. Estas pruebas vigilan que el ADR diga lo que el codigo y la migracion hacen, que el glosario y
// el modelo de datos lo recojan y que ningun documento siga diciendo que lo exento y lo excluido no se distinguen.

const ROOT = resolve(import.meta.dirname, '../..');
const read = (path: string): string =>
  readFileSync(join(ROOT, path), 'utf8').replaceAll('\r\n', '\n');
/** Una frase como se lee: partida entre dos lineas (Prettier ajusta la prosa) sigue siendo la misma frase. */
const prose = (path: string): string => read(path).replaceAll(/\s+/g, ' ');

const ADR = 'docs/adr/0034-el-tipo-tributario-vive-en-el-producto-y-se-copia-a-la-linea.md';
const MIGRATION = 'prisma/migrations/20261023120000_tipo_tributario/migration.sql';

describe('ADR 0034: what it decides', () => {
  const adr = prose(ADR);

  it('is accepted, dated and belongs to Ciclo 4', () => {
    expect(adr).toContain('- **Estado:** Aceptada');
    expect(adr).toContain('- **Fecha:** 2026-10-23');
    expect(adr).toContain('- **Ciclo:** 4');
  });

  it('is in the index of decisions with its own number and title', () => {
    const index = read('docs/adr/README.md');

    expect(index).toMatch(
      /\| \[0034\]\(0034-el-tipo-tributario-vive-en-el-producto-y-se-copia-a-la-linea\.md\)\s+\|/,
    );
  });

  it('names the three kinds with the identifiers the code uses', () => {
    for (const kind of TAX_KINDS) expect(adr, kind).toContain(`\`${kind}\``);
  });

  it('writes down the rule between the kind and the rate', () => {
    expect(adr).toMatch(/\| `taxed` +\| 5 % \(500\) o 19 % \(1900\) +\|/);
    expect(adr).toMatch(/\| `exempt` +\| 0 % +\|/);
    expect(adr).toMatch(/\| `excluded` +\| 0 % +\|/);
    expect(adr).toContain('tax-kind-rate-mismatch');
    expect(adr).toContain('product_tax_kind_fits_rate');
    expect(adr).toContain('sale_line_tax_kind_fits_rate');
  });

  it('says why the kind is copied to the line, and that it has no default value', () => {
    expect(adr).toMatch(/se guarda en el producto y se copia a la línea/i);
    expect(adr).toMatch(/los reportes de ayer cambiarían solos/);
    expect(adr).toMatch(/`NOT NULL` sin `DEFAULT`/);
  });

  it('says the calculation does not change and how to see it', () => {
    expect(adr).toContain('ADR 0014');
    expect(adr).toContain('npm run vectors:check');
  });

  it('says the mark price-differs also covers the kind', () => {
    expect(adr).toContain('`price-differs`');
    expect(adr).toMatch(/cubre precio, tarifa y tipo/);
  });

  it('is honest about the 0 % that already exists: a starting value, not a classification', () => {
    expect(adr).toContain('migración `20261023120000_tipo_tributario`');
    expect(adr).toMatch(/valor de arranque, no una clasificación/);
    expect(adr).toMatch(/datos ficticios/);
    expect(adr).toMatch(/la aplica \*\*una persona\*\* \(Samuel en PRE\), nunca Claude/);
  });

  it('says how the migration fills the column without touching the immutable history', () => {
    expect(adr).toMatch(/llena la columna sin `UPDATE`/);
    expect(adr).toMatch(/`sale_line` es historia inmutable/);
    expect(adr).toMatch(/las copias de lectura de los dispositivos \(ADR 0028\)/);
  });

  it('says what the contract breaks for and who completes the queued sales', () => {
    expect(adr).toMatch(/cambio \*\*incompatible\*\*/);
    expect(adr).toMatch(/el servidor no lo inventa/);
    expect(adr).toContain('openapi.json');
  });

  it('keeps the alternatives it discarded, including the fourth value for what already exists', () => {
    expect(adr).toMatch(/### Deducir el tipo de la tarifa/);
    expect(adr).toMatch(/### Un valor por defecto en la columna/);
    expect(adr).toMatch(/### Un cuarto valor «sin clasificar»/);
  });

  it('says that the system does not know which product is exempt and which excluded', () => {
    expect(adr).toMatch(/no sabe qué producto es exento y cuál excluido/);
  });
});

describe('the migration of the tax kind', () => {
  it('exists with the name the ADR gives it', () => {
    expect(existsSync(join(ROOT, MIGRATION))).toBe(true);
  });

  const sql = existsSync(join(ROOT, MIGRATION)) ? read(MIGRATION) : '';

  it.each(['product', 'sale_line'])(
    'adds the column to %s, fills it without an UPDATE and then makes it required',
    (table) => {
      expect(sql).toContain(
        `ALTER TABLE "${table}" ADD COLUMN "tax_kind" TEXT GENERATED ALWAYS AS (`,
      );
      expect(sql).toContain(`ALTER TABLE "${table}" ALTER COLUMN "tax_kind" DROP EXPRESSION`);
      expect(sql).toContain(`ALTER TABLE "${table}" ALTER COLUMN "tax_kind" SET NOT NULL`);
      expect(sql).toContain(`"${table}_tax_kind_fits_rate"`);
    },
  );

  it('never updates the sale lines: they are immutable history (ADR 0009 and 0013)', () => {
    expect(sql).not.toMatch(/UPDATE "sale_line"/);
  });

  it('moves the change time of the products, so the read copies of the devices download them again (ADR 0028)', () => {
    expect(sql).toContain('UPDATE "product" SET "updated_at" = now()');
  });

  it('lets go of the forced row security only around that update, and forces it again', () => {
    const release = sql.indexOf('ALTER TABLE "product" NO FORCE ROW LEVEL SECURITY');
    const update = sql.indexOf('UPDATE "product" SET "updated_at"');
    const force = sql.indexOf('ALTER TABLE "product" FORCE ROW LEVEL SECURITY');

    expect(release).toBeGreaterThan(-1);
    expect(release).toBeLessThan(update);
    expect(update).toBeLessThan(force);
  });

  it('gives no default to the column', () => {
    expect(sql).not.toMatch(/"tax_kind"[^;]*DEFAULT/);
  });

  it('fills the 5 % and 19 % as taxed and the 0 % as exempt, which the ADR calls a starting value', () => {
    expect(sql).toMatch(/"tax_rate_bp" > 0 THEN 'taxed' ELSE 'exempt'/);
  });
});

describe('the documents that used to say that exempt and excluded are not told apart', () => {
  it('the glossary has the term «Tipo tributario», decided by ADR 0034', () => {
    const glossary = prose('docs/dominio/glosario.md');
    const entry = glossary.slice(
      glossary.indexOf('### Tipo tributario'),
      glossary.indexOf('### Código de barras'),
    );

    expect(glossary).toContain('### Tipo tributario');
    expect(entry).toContain('**Código:** `TaxKind`');
    expect(entry).toContain('**Estado:** Decidido (ADR 0034)');
    expect(entry).toMatch(/gravado, exento o excluido/);
  });

  it('the glossary entry for the tax no longer lists the distinction as pending', () => {
    const glossary = prose('docs/dominio/glosario.md');
    const entry = glossary.slice(
      glossary.indexOf('### Impuesto'),
      glossary.indexOf('### Tipo tributario'),
    );

    expect(entry).toContain('ADR 0034');
    expect(entry).not.toMatch(/cuatro precisiones pendientes: distinguir lo exento de lo excluido/);
  });

  it('the data model says that product and sale_line keep the tax kind', () => {
    const model = prose('docs/dominio/modelo-de-datos.md');

    expect(model).toMatch(/\| `product` +\|[^|]*\|[^|]*tipo tributario/);
    expect(model).toMatch(/\| `sale_line` +\|[^|]*\|[^|]*tipo tributario/);
  });

  it('the comment of the tax rates no longer says that it does not tell exempt from excluded', () => {
    const source = read('src/domain/model/tax.ts');

    expect(source).toContain('ADR 0034');
    expect(source).not.toMatch(/Hoy no distingue exento de excluido/);
  });
});
