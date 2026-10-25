import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_VOID_NUMBER, VOID_FOLIO_PREFIX } from '../../src/domain/model/void-folio.js';

// El folio propio de las anulaciones (ADR 0036) toca el modelo congelado (ADR 0020): una columna en `sale_void`, una tabla nueva, y un
// campo nuevo en el contrato. Estas pruebas vigilan que el ADR diga lo que el codigo y la migracion hacen, que el glosario y el modelo de
// datos lo recojan y que ningun documento siga diciendo que la anulacion no tiene folio propio.

const ROOT = resolve(import.meta.dirname, '../..');
const read = (path: string): string =>
  readFileSync(join(ROOT, path), 'utf8').replaceAll('\r\n', '\n');
/** Una frase como se lee: partida entre dos lineas (Prettier ajusta la prosa) sigue siendo la misma frase. */
const prose = (path: string): string => read(path).replaceAll(/\s+/g, ' ');

const ADR = 'docs/adr/0036-las-anulaciones-tienen-su-propio-folio-consecutivo.md';
const MIGRATION = 'prisma/migrations/20261023130000_folio_de_anulaciones/migration.sql';

describe('ADR 0036: what it decides', () => {
  const adr = prose(ADR);

  it('is accepted, dated and belongs to Ciclo 4', () => {
    expect(adr).toContain('- **Estado:** Aceptada');
    expect(adr).toContain('- **Fecha:** 2026-10-23');
    expect(adr).toContain('- **Ciclo:** 4');
  });

  it('is in the index of decisions with its own number and title', () => {
    const index = read('docs/adr/README.md');

    expect(index).toMatch(
      /\| \[0036\]\(0036-las-anulaciones-tienen-su-propio-folio-consecutivo\.md\)\s+\|/,
    );
  });

  it('writes the shape of the folio with the prefix the code uses', () => {
    expect(adr).toContain(`\`${VOID_FOLIO_PREFIX}-000001\``);
    expect(adr).toMatch(/con seis cifras como mínimo/);
    expect(adr).toMatch(/sin saltos/);
  });

  it('says why the prefix can never be mistaken for the folio of a sale', () => {
    expect(adr).toMatch(/ningún código de dispositivo lleva la `U`/i);
    expect(adr).toContain('ADR 0016');
  });

  it('says the server gives the number, from a counter per business, inside the transaction of the void', () => {
    expect(adr).toContain('`void_counter`');
    expect(adr).toMatch(/la misma transacción/);
    expect(adr).toMatch(/una anulación rechazada no gasta ningún número/);
    expect(adr).toMatch(/repetir la petición responde con el mismo folio/);
  });

  it('says the last number it can give, which the code exports', () => {
    expect(adr).toContain('2 147 483 646');
    expect(MAX_VOID_NUMBER).toBe(2_147_483_646);
  });

  it('names the constraints the database enforces', () => {
    expect(adr).toContain('`sale_void_number_unique`');
    expect(adr).toContain('`sale_void_number_positive`');
    expect(adr).toContain('`void_counter_positive`');
    expect(adr).toMatch(/`NOT NULL` sin `DEFAULT`/);
  });

  it('says the contract grows by a field that is only read, so it is compatible', () => {
    expect(adr).toContain('`voided.folio`');
    expect(adr).toMatch(/cambio \*\*compatible\*\*/);
    expect(adr).toContain('openapi.json');
  });

  it('is honest about the migration: the order of the old voids and the window that lifts the guards', () => {
    expect(adr).toContain('migración `20261023130000_folio_de_anulaciones`');
    expect(adr).toMatch(/la hora en que se anotaron y, si empatan, por su identificador/);
    expect(adr).toContain('`refuse_history_change`');
    expect(adr).toMatch(/la única migración que apaga ese disparador/);
    expect(adr).toMatch(/la aplica \*\*una persona\*\* \(Samuel en PRE\), nunca Claude/);
  });

  it('keeps the alternatives it discarded', () => {
    expect(adr).toMatch(/### Una secuencia de PostgreSQL/);
    expect(adr).toMatch(/### El máximo más uno/);
    expect(adr).toMatch(/### Numerarlas al leer/);
    expect(adr).toMatch(/### Que el dispositivo ponga el número/);
    expect(adr).toMatch(/### Colgarle un sufijo al folio de la venta/);
  });

  it('says the series never starts over and that the number is only unique inside a business', () => {
    expect(adr).toMatch(/la serie no vuelve a empezar/i);
    expect(adr).toMatch(/único dentro de un negocio/);
  });
});

describe('the migration of the void folio', () => {
  it('exists with the name the ADR gives it', () => {
    expect(existsSync(join(ROOT, MIGRATION))).toBe(true);
  });

  const sql = existsSync(join(ROOT, MIGRATION)) ? read(MIGRATION) : '';
  const at = (text: string): number => sql.indexOf(text);

  it('writes only the number in the voids that already exist', () => {
    const updates = sql.match(/UPDATE "sale_void"[^;]*;/g) ?? [];

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatch(/SET "number" = numbered\."number"/);
    expect(updates[0]).not.toMatch(/"reason"|"created_at" =|"operation_id" =|"sale_id" =/);
  });

  it('turns off the guard of the history and the forced row security only around that update, and puts them back', () => {
    const guardOff = at('ALTER TABLE "sale_void" DISABLE TRIGGER "refuse_history_change"');
    const securityOff = at('ALTER TABLE "sale_void" NO FORCE ROW LEVEL SECURITY');
    const update = at('UPDATE "sale_void"');
    const securityOn = at('ALTER TABLE "sale_void" FORCE ROW LEVEL SECURITY');
    const guardOn = at('ALTER TABLE "sale_void" ENABLE TRIGGER "refuse_history_change"');

    for (const position of [guardOff, securityOff, update, securityOn, guardOn]) {
      expect(position).toBeGreaterThan(-1);
    }
    expect(Math.max(guardOff, securityOff)).toBeLessThan(update);
    expect(update).toBeLessThan(Math.min(securityOn, guardOn));
  });

  it('fills the counter while the voids can still be seen, before forcing the row security again', () => {
    const fill = at('INSERT INTO "void_counter"');
    const securityOn = at('ALTER TABLE "sale_void" FORCE ROW LEVEL SECURITY');

    expect(fill).toBeGreaterThan(-1);
    expect(fill).toBeLessThan(securityOn);
  });

  it('numbers by business, in the order they were made and then by identifier', () => {
    expect(sql).toMatch(
      /row_number\(\) OVER \(PARTITION BY "id_negocio" ORDER BY "created_at", "id"\)/,
    );
  });

  it('makes the column required, positive and unique inside a business, with no default', () => {
    expect(sql).toContain('ALTER TABLE "sale_void" ALTER COLUMN "number" SET NOT NULL');
    expect(sql).toContain('"sale_void_number_positive"');
    expect(sql).toContain('CREATE UNIQUE INDEX "sale_void_number_unique"');
    expect(sql).not.toMatch(/"number"[^;]*DEFAULT/);
  });

  it('gives the counter forced row security and the same permissions as the device counter', () => {
    expect(sql).toContain('ALTER TABLE "void_counter" FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE ON "void_counter" TO stock_app');
    expect(sql).toContain('"void_counter_positive"');
  });
});

describe('the documents that used to say that a void has no folio of its own', () => {
  it('the glossary has the term «Folio de anulación», decided by ADR 0036', () => {
    const glossary = prose('docs/dominio/glosario.md');
    const entry = glossary.slice(
      glossary.indexOf('### Folio de anulación'),
      glossary.indexOf('## Finanzas y reportes'),
    );

    expect(glossary).toContain('### Folio de anulación');
    expect(entry).toContain('**Código:** `voidFolio`');
    expect(entry).toContain('**Estado:** Decidido (ADR 0036)');
    expect(entry).toMatch(/`ANU-000001`/);
  });

  it('the entry of the tax no longer lists the folio of the voids as pending', () => {
    const glossary = prose('docs/dominio/glosario.md');
    const entry = glossary.slice(
      glossary.indexOf('### Impuesto'),
      glossary.indexOf('### Tipo tributario'),
    );

    expect(entry).toContain('ADR 0036');
    expect(entry).not.toMatch(/quedan dar folio propio a las anulaciones/);
  });

  it('the entry of the void says it has its own folio', () => {
    const glossary = prose('docs/dominio/glosario.md');
    const entry = glossary.slice(
      glossary.indexOf('### Anulación'),
      glossary.indexOf('### Devolución'),
    );

    expect(entry).toContain('ADR 0036');
    expect(entry).toMatch(/folio propio/);
  });

  it('the data model lists the counter and says that sale_void keeps the number', () => {
    const model = prose('docs/dominio/modelo-de-datos.md');

    expect(model).toMatch(/\| `void_counter` +\|[^|]*\|[^|]*ADR 0036/);
    expect(model).toMatch(/\| `sale_void` +\|[^|]*\|[^|]*número[^|]*ADR 0036/);
  });
});
