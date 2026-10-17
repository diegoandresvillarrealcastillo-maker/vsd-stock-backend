// Genera los vectores de calculo que comparten el backend y el frontend (ADR 0014).
//
//   node scripts/calculation-vectors.ts           escribe contract/calculation-vectors.json
//   node scripts/calculation-vectors.ts --check   falla si el archivo ya no coincide con este generador
//
// Corre directamente en Node 24, que ejecuta TypeScript quitando los tipos: por eso este
// archivo no usa sintaxis que necesite compilarse y solo importa modulos de Node.
//
// Los resultados esperados NO salen del dominio. Se calculan aqui con aritmetica entera
// exacta (BigInt) y la regla escrita aparte, para que un error de redondeo del dominio no
// pueda esconderse detras de un vector que el propio dominio produjo. Las entradas son una
// lista escogida a mano: incluyen los bordes (cero, uno, el maximo, negativos y empates).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const VECTORS_PATH = 'contract/calculation-vectors.json';
const MAX_PESOS = 1_000_000_000_000;

/** Cociente redondeado al entero mas cercano; la mitad se aleja de cero. El denominador es positivo. */
function roundHalfAwayFromZero(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  const quotient = magnitude / denominator;
  const remainder = magnitude % denominator;
  const rounded = 2n * remainder >= denominator ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

const big = (value: number): bigint => BigInt(value);

function expectedBreakdown(total: number, rateBp: number): { base: number; tax: number } {
  const base = roundHalfAwayFromZero(big(total) * 10_000n, 10_000n + big(rateBp));
  return { base: Number(base), tax: total - Number(base) };
}

function expectedGross(unitPrice: number, quantityMilli: number): number {
  return Number(roundHalfAwayFromZero(big(unitPrice) * big(quantityMilli), 1000n));
}

function expectedPercent(amount: number, percentBp: number): number {
  return Number(roundHalfAwayFromZero(big(amount) * big(percentBp), 10_000n));
}

interface SaleLineSpec {
  name: string;
  unitPrice: number;
  quantityMilli: number;
  discount: number;
  rateBp: number;
}

function expectedSale(lines: SaleLineSpec[]) {
  const totals = new Map<number, number>();
  for (const line of lines) {
    const total = expectedGross(line.unitPrice, line.quantityMilli) - line.discount;
    totals.set(line.rateBp, (totals.get(line.rateBp) ?? 0) + total);
  }
  const byRate = [...totals.entries()]
    .sort(([a], [b]) => a - b)
    .map(([rateBp, total]) => ({ rateBp, total, ...expectedBreakdown(total, rateBp) }));
  const sum = (pick: (row: (typeof byRate)[number]) => number) =>
    byRate.reduce((accumulated, row) => accumulated + pick(row), 0);
  return {
    total: sum((row) => row.total),
    base: sum((row) => row.base),
    tax: sum((row) => row.tax),
    byRate,
  };
}

const RATES = [0, 500, 1900];

const BREAKDOWN_TOTALS = [
  0,
  1,
  2,
  3,
  4,
  5,
  10,
  21,
  99,
  100,
  101,
  105,
  118,
  119,
  120,
  500,
  999,
  1000,
  1190,
  1500,
  2380,
  9999,
  10_000,
  11_900,
  12_345,
  100_000,
  119_000,
  1_234_567,
  99_999_999,
  MAX_PESOS,
];
const BREAKDOWN_NEGATIVE_TOTALS = [-1, -3, -119, -1000, -MAX_PESOS];

const GROSS_CASES: [number, number][] = [
  [1000, 1000], // una unidad
  [2500, 1500], // kilo y medio
  [1, 1], // una milesima de unidad a un peso: 0,001 -> 0
  [1, 499], // 0,499 -> 0
  [1, 500], // empate: 0,5 -> 1
  [1, 501], // 0,501 -> 1
  [3, 500], // empate: 1,5 -> 2
  [5, 500], // empate: 2,5 -> 3
  [999, 3333], // 3.329,667 -> 3.330
  [1200, 2500], // 3.000
  [12_500, 250], // 3.125
  [7, 1000], // 7
  [MAX_PESOS, 1000], // el maximo, una unidad
  [999_999, 1_000_000], // mil unidades
  [0, 5000], // gratis
];

const PERCENT_CASES: [number, number][] = [
  [10_000, 500], // 5 % de 10.000 = 500
  [10_000, 1900], // 19 %
  [1, 5000], // empate: 0,5 -> 1
  [3, 5000], // empate: 1,5 -> 2
  [-3, 5000], // empate negativo: -1,5 -> -2
  [999, 1000], // 10 % de 999 = 99,9 -> 100
  [12_345, 1250], // 12,5 %
  [0, 1900],
  [MAX_PESOS, 10_000],
];

function sale(name: string, lines: SaleLineSpec[]) {
  return { name, lines, expected: expectedSale(lines) };
}

const line = (
  name: string,
  unitPrice: number,
  quantityMilli: number,
  rateBp: number,
  discount = 0,
): SaleLineSpec => ({ name, unitPrice, quantityMilli, discount, rateBp });

const SALES = [
  sale('an empty sale', []),
  sale('one exempt item', [line('arroz', 4500, 1000, 0)]),
  sale('one item with 19 % VAT included', [line('gaseosa', 3500, 1000, 1900)]),
  sale('three rates in one sale', [
    line('arroz', 4500, 1000, 0),
    line('chocolate', 2300, 2000, 500),
    line('detergente', 8900, 1000, 1900),
  ]),
  sale('the same rate on several lines is broken down once', [
    line('gaseosa', 3500, 1000, 1900),
    line('jugo', 2750, 3000, 1900),
    line('galletas', 1990, 1000, 1900),
  ]),
  sale('goods sold by weight', [
    line('queso', 24_000, 1500, 0),
    line('arroz', 3600, 2750, 0),
    line('carne', 31_900, 833, 1900),
  ]),
  sale('a discount in pesos before extracting the VAT', [
    line('detergente', 8900, 2000, 1900, 1800),
    line('gaseosa', 3500, 1000, 1900),
  ]),
  sale('a discount that cancels the line', [line('promocion', 5000, 1000, 1900, 5000)]),
  sale('many small lines at 5 %', [
    line('dulce', 100, 1000, 500),
    line('dulce', 100, 1000, 500),
    line('dulce', 100, 1000, 500),
    line('chicle', 50, 3000, 500),
    line('mani', 700, 500, 500),
  ]),
  sale('a sale at the limit of the amount', [line('lote', MAX_PESOS, 1000, 1900)]),
];

/** Entradas que el dominio debe rechazar con un RangeError. */
const INVALID = [
  {
    fn: 'breakdown',
    note: 'the total must be a whole number of pesos',
    input: { total: 1.5, rateBp: 1900 },
  },
  { fn: 'breakdown', note: 'the total is not a number', input: { total: 'mil', rateBp: 1900 } },
  { fn: 'breakdown', note: 'the rate cannot be negative', input: { total: 1000, rateBp: -1 } },
  { fn: 'breakdown', note: 'the rate cannot pass 100 %', input: { total: 1000, rateBp: 10_001 } },
  {
    fn: 'breakdown',
    note: 'the rate must be whole basis points',
    input: { total: 1000, rateBp: 19.5 },
  },
  {
    fn: 'breakdown',
    note: 'the amount passes the maximum',
    input: { total: MAX_PESOS + 1, rateBp: 1900 },
  },
  {
    fn: 'gross',
    note: 'the quantity cannot be zero',
    input: { unitPrice: 1000, quantityMilli: 0 },
  },
  {
    fn: 'gross',
    note: 'the quantity cannot be negative',
    input: { unitPrice: 1000, quantityMilli: -1000 },
  },
  {
    fn: 'gross',
    note: 'the quantity must be whole thousandths',
    input: { unitPrice: 1000, quantityMilli: 1.5 },
  },
  {
    fn: 'gross',
    note: 'the quantity passes the maximum',
    input: { unitPrice: 1000, quantityMilli: 1_000_000_001 },
  },
  {
    fn: 'gross',
    note: 'the price cannot be negative',
    input: { unitPrice: -1, quantityMilli: 1000 },
  },
  {
    fn: 'gross',
    note: 'the line passes the maximum amount',
    input: { unitPrice: MAX_PESOS, quantityMilli: 2000 },
  },
  {
    fn: 'percent',
    note: 'the percentage cannot be negative',
    input: { amount: 1000, percentBp: -1 },
  },
  {
    fn: 'percent',
    note: 'the percentage cannot pass 100 %',
    input: { amount: 1000, percentBp: 10_001 },
  },
  {
    fn: 'sale',
    note: 'the discount cannot exceed the line',
    input: { lines: [{ unitPrice: 1000, quantityMilli: 1000, discount: 1001, rateBp: 0 }] },
  },
  {
    fn: 'sale',
    note: 'the discount cannot be negative',
    input: { lines: [{ unitPrice: 1000, quantityMilli: 1000, discount: -1, rateBp: 0 }] },
  },
  {
    fn: 'sale',
    note: 'the sale passes the maximum amount',
    input: {
      lines: [
        { unitPrice: MAX_PESOS, quantityMilli: 1000, discount: 0, rateBp: 0 },
        { unitPrice: 1, quantityMilli: 1000, discount: 0, rateBp: 0 },
      ],
    },
  },
];

export function buildVectors() {
  return {
    description:
      'Casos de calculo que ejecutan el backend y el frontend (ADR 0014). Los resultados esperados los calcula ' +
      'scripts/calculation-vectors.ts con aritmetica entera exacta, no el dominio. No se edita a mano: se ' +
      'regenera con `node scripts/calculation-vectors.ts`.',
    version: 1,
    currency: 'COP',
    rounding: 'half-away-from-zero',
    maxPesos: MAX_PESOS,
    breakdown: [...BREAKDOWN_TOTALS, ...BREAKDOWN_NEGATIVE_TOTALS].flatMap((total) =>
      RATES.map((rateBp) => ({ total, rateBp, ...expectedBreakdown(total, rateBp) })),
    ),
    gross: GROSS_CASES.map(([unitPrice, quantityMilli]) => ({
      unitPrice,
      quantityMilli,
      total: expectedGross(unitPrice, quantityMilli),
    })),
    percent: PERCENT_CASES.map(([amount, percentBp]) => ({
      amount,
      percentBp,
      result: expectedPercent(amount, percentBp),
    })),
    sale: SALES,
    invalid: INVALID,
  };
}

export function renderVectors(): string {
  return `${JSON.stringify(buildVectors(), null, 2)}\n`;
}

function main(argv: string[]): number {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const path = resolve(root, VECTORS_PATH);
  const expected = renderVectors();
  if (argv.includes('--check')) {
    let current = '';
    try {
      current = readFileSync(path, 'utf8');
    } catch {
      // Si no existe, es lo mismo que estar desactualizado.
    }
    if (current !== expected) {
      console.error(
        `${VECTORS_PATH} esta desactualizado. Regeneralo con: node scripts/calculation-vectors.ts`,
      );
      return 1;
    }
    console.log(`${VECTORS_PATH} esta al dia`);
    return 0;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, expected);
  console.log(`Escribi ${VECTORS_PATH}`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
