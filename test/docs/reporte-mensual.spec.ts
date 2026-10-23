import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// El reporte mensual (C4-R1, ADR 0035) es lo que el contador pidio en el ADR 0032: ventas por tarifa y tipo, anulaciones aparte y un resumen por
// medio de pago. Estas pruebas vigilan que el ADR diga lo que el codigo hace, que el glosario lo recoja y que ningun documento siga diciendo
// que el reporte esta fuera de la entrega.

const ROOT = resolve(import.meta.dirname, '../..');
const read = (path: string): string =>
  readFileSync(join(ROOT, path), 'utf8').replaceAll('\r\n', '\n');
/** Una frase como se lee: partida entre dos lineas (Prettier ajusta la prosa) sigue siendo la misma frase. */
const prose = (path: string): string => read(path).replaceAll(/\s+/g, ' ');

const ADR =
  'docs/adr/0035-el-reporte-mensual-suma-lo-que-dijo-cada-recibo-y-corta-a-hora-de-bogota.md';

describe('ADR 0035: what it decides', () => {
  const adr = prose(ADR);

  it('is accepted, dated and belongs to Ciclo 4', () => {
    expect(adr).toContain('- **Estado:** Aceptada');
    expect(adr).toContain('- **Fecha:** 2026-10-23');
    expect(adr).toContain('- **Ciclo:** 4');
  });

  it('is in the index of decisions with its own number and title', () => {
    expect(read('docs/adr/README.md')).toMatch(
      /\| \[0035\]\(0035-el-reporte-mensual-suma-lo-que-dijo-cada-recibo-y-corta-a-hora-de-bogota\.md\)\s+\|/,
    );
  });

  it('names the endpoint, the permission and who has it', () => {
    expect(adr).toContain('`GET /v1/reports/monthly?month=AAAA-MM`');
    expect(adr).toContain('`report:sales`');
    expect(adr).toMatch(/dueño y la administración/);
    expect(adr).toMatch(/necesita conexión/);
  });

  it('writes down the four rows in the order of the declaration, which are always there', () => {
    expect(adr).toMatch(/gravado al 19 %, gravado al 5 %, exento y excluido/);
    expect(adr).toMatch(/aunque el mes no tenga ventas/);
  });

  it('says the tax is taken out sale by sale, with the example that shows the difference', () => {
    expect(adr).toMatch(/venta por venta/);
    expect(adr).toMatch(/\$ 320/);
    expect(adr).toMatch(/\$ 319/);
    expect(adr).toContain('ADR 0014');
  });

  it('says which moment dates a sale and which one dates a void', () => {
    expect(adr).toContain('`occurred_at`');
    expect(adr).toContain('ADR 0016');
    expect(adr).toContain('`sale_void.created_at`');
    expect(adr).toMatch(/una anulación va en el mes en que se hizo/);
  });

  it('says the months are cut at midnight in Bogotá, which has no daylight saving time', () => {
    expect(adr).toMatch(/medianoche de Bogotá/);
    expect(adr).toMatch(/UTC−5/);
    expect(adr).toMatch(/no cambia de hora en el año/);
    expect(adr).toMatch(/la última venta del 31 de octubre a las 23:59 es de octubre/);
  });

  it('keeps the voids apart and does not net them, as the accountant asked', () => {
    expect(adr).toContain('ADR 0032');
    expect(adr).toMatch(/en renglón aparte, no netas/);
    expect(adr).toMatch(/no resta nada por su cuenta/);
  });

  it('summarises how the month was paid by method', () => {
    expect(adr).toMatch(/`cash`, `card` y `transfer`/);
  });

  it('is honest about what it is not: not a declaration, not an invoice, no other taxes, no accountant yet', () => {
    expect(adr).toMatch(/no es la declaración/);
    expect(adr).toMatch(/factura electrónica/);
    expect(adr).toMatch(/bolsas plásticas/);
    expect(adr).toMatch(/lo valida quien lleva las declaraciones de la tienda/);
  });

  it('keeps the alternatives it discarded', () => {
    expect(adr).toMatch(/### Sacar el IVA del total del mes/);
    expect(adr).toMatch(/### Sumar en SQL/);
    expect(adr).toMatch(/### Mostrar solo el neto/);
    expect(adr).toMatch(/### Guardar el reporte cerrado/);
  });

  it('says what the month costs: it reads the lines of the month and where it would change', () => {
    expect(adr).toMatch(/lee las líneas y los cobros del mes/);
    expect(adr).toMatch(/decenas de miles de ventas/);
  });
});

describe('the documents that used to say the monthly report is out of the delivery', () => {
  it('the glossary has the term «Reporte mensual», decided by ADR 0035', () => {
    const glossary = prose('docs/dominio/glosario.md');
    const entry = glossary.slice(
      glossary.indexOf('### Reporte mensual'),
      glossary.indexOf('### Código de barras'),
    );

    expect(glossary).toContain('### Reporte mensual');
    expect(entry).toContain('**Estado:** Decidido (ADR 0035)');
    expect(entry).toMatch(/venta por venta/);
  });

  it('the glossary entry for the tax points to the report instead of listing it as pending', () => {
    const glossary = prose('docs/dominio/glosario.md');
    const entry = glossary.slice(
      glossary.indexOf('### Impuesto'),
      glossary.indexOf('### Tipo tributario'),
    );

    expect(entry).toContain('ADR 0035');
    expect(entry).not.toMatch(/quedan dar folio propio a las anulaciones, un reporte mensual/);
  });
});
