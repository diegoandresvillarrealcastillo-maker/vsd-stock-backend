import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Money } from '../../src/domain/model/money.js';
import { splitTaxIncluded } from '../../src/domain/model/tax.js';

// Un contador reviso la mecanica del IVA (ADR 0032) y dejo cuatro precisiones que el modelo todavia no cubre. Estas pruebas vigilan que
// la constancia diga lo mismo que el codigo: que los ejemplos del ADR sean los que calcula el dominio, que las precisiones queden
// escritas y que ni el glosario ni el codigo sigan llamando «hipotesis» a lo que ya se reviso.

const ROOT = resolve(import.meta.dirname, '../..');
const read = (path: string): string =>
  readFileSync(join(ROOT, path), 'utf8').replaceAll('\r\n', '\n');
/** Una frase como se lee: partida entre dos lineas (Prettier ajusta la prosa) sigue siendo la misma frase. */
const prose = (path: string): string => read(path).replaceAll(/\s+/g, ' ');

const ADR = 'docs/adr/0032-un-contador-reviso-la-mecanica-del-iva.md';

/** «$ 10.000» → 10000. */
const pesos = (text: string): number => Number(text.replaceAll('.', ''));

describe('ADR 0032: the examples the accountant recomputed', () => {
  const rows = [
    ...read(ADR).matchAll(/^ *\| \$ ([\d.]+) +\| (\d+) % +\| \$ ([\d.]+) +\| \$ ([\d.]+) +\|/gm),
  ].map((match) => ({
    total: pesos(match[1] ?? ''),
    rate: Number(match[2]),
    base: pesos(match[3] ?? ''),
    tax: pesos(match[4] ?? ''),
  }));

  it('lists the five examples of the sheet that was sent to him', () => {
    expect(rows).toHaveLength(5);
  });

  it.each(rows)(
    'splits $total at $rate % into base $base and VAT $tax, as the domain does',
    (row) => {
      const split = splitTaxIncluded(Money.of(row.total), row.rate * 100);

      expect(split.base.amount).toBe(row.base);
      expect(split.tax.amount).toBe(row.tax);
      expect(row.base + row.tax).toBe(row.total);
    },
  );
});

describe('ADR 0032: what it leaves written', () => {
  const adr = prose(ADR);

  it('says it complements ADR 0014 and closes the risk that ADR 0020 listed, without replacing either', () => {
    expect(adr).toContain('ADR 0014');
    expect(adr).toContain('ADR 0020');
    expect(adr).toMatch(/no lo reemplaza/i);
  });

  it.each([
    ['the exempt / excluded distinction', /distinguir lo exento de lo excluido/i],
    ['the exempt and excluded sales in the monthly report', /exentas y excluidas/i],
    ['the voids with a folio of their own', /anulaciones con folio propio/i],
    ['the monthly report', /el reporte mensual\*{0,2} \(fuera de la entrega\)/i],
    ['the payment method summary', /medio de pago/i],
    ['the electronic invoice', /factura electrónica/i],
    ['the taxes that are not VAT', /bolsas plásticas/i],
  ])('writes down %s', (_name, pattern) => {
    expect(adr).toMatch(pattern);
  });

  it('warns that the voucher of VSD Stock is not the fiscal document', () => {
    expect(adr).toContain('Comprobante de venta — no es factura');
  });

  it('says that the laws and rates the accountant cited were not checked by the team', () => {
    expect(adr).toContain('el equipo no las contrastó con la fuente oficial');
    expect(adr).toContain('citas de la norma no se contrastaron');
  });

  it('records the review as an external technical accounting review, with no name, as the project owner decided', () => {
    expect(adr).toContain('revisión técnica contable externa');
    expect(adr).toContain('sin nombre propio');
  });

  it('keeps the validation with whoever files the store declarations for before real sales', () => {
    expect(adr).toContain('quien lleva las declaraciones de la tienda');
    expect(adr).toMatch(/antes de operar en vivo con ventas reales/);
  });

  it('says the store handles its invoicing with the DIAN outside the system, so VSD Stock stays internal control', () => {
    expect(adr).toContain('facturador gratuito de la DIAN');
    expect(adr).toMatch(/por fuera del sistema/);
    expect(adr).toMatch(/control interno de inventario y cuadre de caja/);
  });

  it('plans the exempt / excluded type for the start of Ciclo 4, before the monthly reports and the real sales', () => {
    expect(adr).toMatch(
      /decidió hacerlo al inicio del Ciclo 4, antes de los reportes mensuales y de las ventas reales/,
    );
  });

  it('says what is still true of the sale line today, so nobody assumes the type is stored', () => {
    expect(adr).toContain('tax_rate_bp');
    expect(adr).toContain('sale_void');
  });
});

describe('the documents that used to call the VAT mechanics a hypothesis', () => {
  it('the glossary entry for the tax points to ADR 0032 and no longer calls the mechanics unverified', () => {
    const glossary = prose('docs/dominio/glosario.md');
    const entry = glossary.slice(
      glossary.indexOf('### Impuesto'),
      glossary.indexOf('### Código de barras'),
    );

    expect(entry).toContain('ADR 0032');
    expect(entry).not.toMatch(/es una hipótesis que debe verificar/);
  });

  it('the comment of the tax rates points to ADR 0032 and no longer says it is pending', () => {
    const source = read('src/domain/model/tax.ts');

    expect(source).toContain('ADR 0032');
    expect(source).not.toMatch(/HIPOTESIS pendiente/);
  });
});
