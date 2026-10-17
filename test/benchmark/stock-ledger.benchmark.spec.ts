import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { asApplication, createAdminPool } from '../integration/support/database.js';
import {
  BUSINESS_A,
  LEDGER_SCHEMA,
  createLedgerDesign,
  dropLedgerDesign,
} from '../integration/support/ledger-design.js';

/**
 * Medicion del ADR 0013: cuanto cuesta leer la existencia sumando los
 * movimientos y cuanto cuesta mantener el saldo. NO es una prueba: no afirma
 * nada, imprime una tabla. Se corre con `npm run bench:stock` (necesita la base
 * de `npm run db:up`) y los numeros dependen del equipo: sirve el orden de
 * magnitud y la proporcion entre las dos formas, no el valor absoluto.
 *
 * `BENCH_SIZES` cambia los tamanos (por omision 10000,100000,1000000).
 */
const SIZES = (process.env['BENCH_SIZES'] ?? '10000,100000,1000000')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0);

/** Productos de la tienda: 1 de cada 500 movimientos, con un minimo de 100. */
const productsFor = (movements: number): number => Math.max(100, Math.floor(movements / 500));

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

async function timeEach(times: number, run: () => Promise<unknown>): Promise<number> {
  const samples: number[] = [];
  for (let index = 0; index < times; index += 1) {
    const start = performance.now();
    await run();
    samples.push(performance.now() - start);
  }
  return median(samples);
}

const format = (milliseconds: number): string =>
  milliseconds < 1 ? `${(milliseconds * 1000).toFixed(0)} us` : `${milliseconds.toFixed(2)} ms`;

describe('stock ledger: read and write cost (ADR 0013)', () => {
  let admin: pg.Pool;

  beforeAll(() => {
    admin = createAdminPool(32);
  });

  afterAll(async () => {
    await dropLedgerDesign(admin);
    await admin.end();
  });

  it('prints the measurements', { timeout: 900_000 }, async () => {
    const rows: string[][] = [];

    for (const movements of SIZES) {
      const products = productsFor(movements);
      await createLedgerDesign(admin);

      // Carga masiva sin el disparador (un millon de disparos tardaria mas que lo que se mide);
      // despues se construye el saldo de una vez y se reactiva.
      await admin.query(
        `ALTER TABLE ${LEDGER_SCHEMA}.stock_movement DISABLE TRIGGER apply_stock_movement`,
      );
      await admin.query(
        `INSERT INTO ${LEDGER_SCHEMA}.stock_movement (id_negocio, operation_id, product_id, delta, reason)
         SELECT $1::uuid, gen_random_uuid(),
                ('00000000-0000-4000-8000-' || lpad((n % $3::int)::text, 12, '0'))::uuid,
                CASE WHEN n % 5 = 0 THEN 12 ELSE -1 END,
                CASE WHEN n % 5 = 0 THEN 'purchase' ELSE 'sale' END
           FROM generate_series(1, $2::int) AS n`,
        [BUSINESS_A, movements, products],
      );
      await admin.query(
        `INSERT INTO ${LEDGER_SCHEMA}.stock_balance (id_negocio, product_id, quantity)
         SELECT id_negocio, product_id, sum(delta) FROM ${LEDGER_SCHEMA}.stock_movement GROUP BY 1, 2`,
      );
      await admin.query(
        `ALTER TABLE ${LEDGER_SCHEMA}.stock_movement ENABLE TRIGGER apply_stock_movement`,
      );
      await admin.query(`ANALYZE ${LEDGER_SCHEMA}.stock_movement`);
      await admin.query(`ANALYZE ${LEDGER_SCHEMA}.stock_balance`);

      const product = '00000000-0000-4000-8000-000000000007';
      const reads = await asApplication(admin, BUSINESS_A, async (client) => {
        const sumOne = await timeEach(300, () =>
          client.query(
            `SELECT COALESCE(sum(delta), 0) FROM ${LEDGER_SCHEMA}.stock_movement
              WHERE id_negocio = $1 AND product_id = $2`,
            [BUSINESS_A, product],
          ),
        );
        const balanceOne = await timeEach(300, () =>
          client.query(
            `SELECT quantity FROM ${LEDGER_SCHEMA}.stock_balance WHERE id_negocio = $1 AND product_id = $2`,
            [BUSINESS_A, product],
          ),
        );
        const sumAll = await timeEach(5, () =>
          client.query(
            `SELECT product_id, sum(delta) FROM ${LEDGER_SCHEMA}.stock_movement
              WHERE id_negocio = $1 GROUP BY product_id`,
            [BUSINESS_A],
          ),
        );
        const balanceAll = await timeEach(5, () =>
          client.query(
            `SELECT product_id, quantity FROM ${LEDGER_SCHEMA}.stock_balance WHERE id_negocio = $1`,
            [BUSINESS_A],
          ),
        );
        return { sumOne, balanceOne, sumAll, balanceAll };
      });

      // Costo de escribir un movimiento (una sola fila, con RLS), con y sin saldo.
      const writeOne = (client: pg.PoolClient) => () =>
        client.query(
          `INSERT INTO ${LEDGER_SCHEMA}.stock_movement (id_negocio, operation_id, product_id, delta, reason)
           VALUES ($1, $2, $3, -1, 'sale')`,
          [BUSINESS_A, randomUUID(), product],
        );
      const withBalance = await asApplication(admin, BUSINESS_A, (client) =>
        timeEach(500, writeOne(client)),
      );
      await admin.query(
        `ALTER TABLE ${LEDGER_SCHEMA}.stock_movement DISABLE TRIGGER apply_stock_movement`,
      );
      const withoutBalance = await asApplication(admin, BUSINESS_A, (client) =>
        timeEach(500, writeOne(client)),
      );
      await admin.query(
        `ALTER TABLE ${LEDGER_SCHEMA}.stock_movement ENABLE TRIGGER apply_stock_movement`,
      );

      // La fila caliente: 20 cajas vendiendo el MISMO producto sin parar, 100 ventas cada una,
      // cada venta en su propia transaccion. Muy por encima de lo que vende una tienda de barrio.
      const start = performance.now();
      await Promise.all(
        Array.from({ length: 20 }, async () => {
          for (let index = 0; index < 100; index += 1) {
            await asApplication(admin, BUSINESS_A, (client) => writeOne(client)());
          }
        }),
      );
      const hotRate = 2000 / ((performance.now() - start) / 1000);

      rows.push([
        movements.toLocaleString('en-US'),
        String(products),
        format(reads.sumOne),
        format(reads.balanceOne),
        format(reads.sumAll),
        format(reads.balanceAll),
        format(withBalance),
        format(withoutBalance),
        `${Math.round(hotRate)} ventas/s`,
      ]);
    }

    const header = [
      'movimientos',
      'productos',
      'leer 1: suma',
      'leer 1: saldo',
      'leer todos: suma',
      'leer todos: saldo',
      'escribir con saldo',
      'escribir sin saldo',
      'mismo producto, 20 cajas',
    ];
    const lines = [header, ...rows].map((row) => `| ${row.join(' | ')} |`);
    lines.splice(1, 0, `| ${header.map(() => '---').join(' | ')} |`);
    console.log(`\n${lines.join('\n')}\n`);
  });
});
