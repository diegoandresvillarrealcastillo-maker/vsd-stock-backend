import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asApplication, createAdminPool } from './support/database.js';
import {
  BUSINESS_A,
  BUSINESS_B,
  openShift,
  recordStockEntry,
  registerSale,
  type SaleInput,
} from './support/ledger-design.js';
import { resetData, seedBusiness, type SeededBusiness } from './support/seed.js';

/**
 * Demuestra, contra un PostgreSQL real y sobre las tablas REALES (ADR 0021), el diseno del ADR 0013: la
 * existencia es una suma de movimientos inmutables que se mantiene sola en la misma transaccion, y una venta
 * con sus movimientos es una sola unidad de trabajo que se puede reenviar sin duplicar.
 */
describe('stock ledger and sale as one operation (ADR 0013)', () => {
  let admin: pg.Pool;
  let a: SeededBusiness;
  const PRODUCT_1 = '00000000-0000-4000-8000-000000000001';
  const PRODUCT_2 = '00000000-0000-4000-8000-000000000002';
  /** Un producto del negocio B: el identificador de un producto es unico en toda la base, no por negocio. */
  const PRODUCT_OF_B = '00000000-0000-4000-8000-000000001001';

  beforeAll(() => {
    admin = createAdminPool(16);
  });

  beforeEach(async () => {
    await resetData(admin);
    a = await seedBusiness(admin, BUSINESS_A);
    await seedBusiness(admin, BUSINESS_B);
    // Cincuenta productos del negocio A, del ...0000 al ...0049 (los usa la carga masiva), y uno del B.
    await admin.query(
      `INSERT INTO product (id, id_negocio, name, sku, unit, unit_price, tax_rate_bp, tax_kind)
       SELECT ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, $1, 'P' || n, 'SKU-' || n,
              'unit', 1000, 0, 'exempt'
         FROM generate_series(0, 49) AS n`,
      [BUSINESS_A],
    );
    await admin.query(
      `INSERT INTO product (id, id_negocio, name, sku, unit, unit_price, tax_rate_bp, tax_kind)
       VALUES ($1, $2, 'Producto de B', 'B-1', 'unit', 1000, 0, 'exempt')`,
      [PRODUCT_OF_B, BUSINESS_B],
    );
  });

  afterAll(async () => {
    await admin.end();
  });

  // ---------- Ayudas de lectura ----------

  const count = async (table: string, businessId = BUSINESS_A): Promise<number> => {
    const result = await admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM ${table} WHERE id_negocio = $1`,
      [businessId],
    );
    return Number(result.rows[0]?.n);
  };

  const balance = async (productId: string, businessId = BUSINESS_A): Promise<number> => {
    const result = await admin.query<{ quantity: string }>(
      `SELECT quantity FROM stock_balance WHERE id_negocio = $1 AND product_id = $2`,
      [businessId, productId],
    );
    return result.rows.length === 0 ? 0 : Number(result.rows[0]?.quantity);
  };

  const summed = async (productId: string, businessId = BUSINESS_A): Promise<number> => {
    const result = await admin.query<{ total: string }>(
      `SELECT COALESCE(sum(delta), 0) AS total FROM stock_movement
        WHERE id_negocio = $1 AND product_id = $2`,
      [businessId, productId],
    );
    return Number(result.rows[0]?.total);
  };

  /** Productos cuyo saldo no coincide con la suma de sus movimientos. Lo correcto es una lista vacia. */
  const driftedBalances = async (): Promise<string[]> => {
    const result = await admin.query<{ product_id: string }>(
      `SELECT product_id FROM (
         SELECT m.id_negocio, m.warehouse_id, m.product_id, sum(m.delta) AS total
           FROM stock_movement m GROUP BY 1, 2, 3
       ) s
       LEFT JOIN stock_balance b USING (id_negocio, warehouse_id, product_id)
       WHERE b.quantity IS DISTINCT FROM s.total`,
    );
    return result.rows.map((row) => row.product_id);
  };

  const stock = (productId: string, quantity: number, businessId = BUSINESS_A) =>
    recordStockEntry(admin, {
      businessId,
      operationId: randomUUID(),
      productId,
      delta: quantity,
      reason: 'purchase',
    });

  /** Un movimiento suelto en la transaccion de `client`: primero su operacion, para que las claves foraneas pasen. */
  const insertMovement = async (client: pg.PoolClient, productId: string, delta: number) => {
    const operationId = randomUUID();
    await client.query(
      `INSERT INTO operation (id_negocio, operation_id, kind, user_id) VALUES ($1, $2, 'sale', $3)`,
      [BUSINESS_A, operationId, a.ownerId],
    );
    await client.query(
      `INSERT INTO stock_movement (id_negocio, operation_id, warehouse_id, product_id, delta, reason)
       VALUES ($1, $2, $3, $4, $5, 'sale')`,
      [BUSINESS_A, operationId, a.warehouseId, productId, delta],
    );
  };

  const saleOf = (shiftId: string, overrides: Partial<SaleInput> = {}): SaleInput => ({
    businessId: BUSINESS_A,
    operationId: randomUUID(),
    shiftId,
    lines: [{ productId: PRODUCT_1, quantity: 1, unitPrice: 1000 }],
    ...overrides,
  });

  // ---------- El esquema respeta el aislamiento (ADR 0005) ----------

  describe('isolation', () => {
    it('does not show business B the movements, balances or sales of business A', async () => {
      const shift = await openShift(admin, BUSINESS_A);
      await stock(PRODUCT_1, 10);
      await registerSale(admin, saleOf(shift));

      const seenByB = await asApplication(admin, BUSINESS_B, async (client) => {
        const tables = ['stock_movement', 'stock_balance', 'sale', 'operation', 'cash_movement'];
        const counts: Record<string, number> = {};
        for (const table of tables) {
          const result = await client.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`);
          counts[table] = Number(result.rows[0]?.n);
        }
        return counts;
      });

      expect(seenByB).toEqual({
        stock_movement: 0,
        stock_balance: 0,
        sale: 0,
        operation: 0,
        cash_movement: 0,
      });
    });
  });

  // ---------- El libro de movimientos ----------

  describe('the ledger', () => {
    it('keeps the balance equal to the sum of the movements', async () => {
      await stock(PRODUCT_1, 10);
      const shift = await openShift(admin, BUSINESS_A);
      await registerSale(
        admin,
        saleOf(shift, { lines: [{ productId: PRODUCT_1, quantity: 3, unitPrice: 500 }] }),
      );
      await registerSale(
        admin,
        saleOf(shift, { lines: [{ productId: PRODUCT_1, quantity: 2, unitPrice: 500 }] }),
      );

      expect(await balance(PRODUCT_1)).toBe(5);
      expect(await summed(PRODUCT_1)).toBe(5);
      expect(await driftedBalances()).toEqual([]);
    });

    it('corrects with a compensating movement, never by editing', async () => {
      await stock(PRODUCT_1, 10);
      await recordStockEntry(admin, {
        businessId: BUSINESS_A,
        operationId: randomUUID(),
        productId: PRODUCT_1,
        delta: -2,
        reason: 'adjustment',
      });

      expect(await count('stock_movement')).toBe(2);
      expect(await balance(PRODUCT_1)).toBe(8);
    });

    it('refuses to update a movement, even for the owner of the table', async () => {
      await stock(PRODUCT_1, 10);

      await expect(admin.query(`UPDATE stock_movement SET delta = 999`)).rejects.toThrow(
        /append-only/,
      );
      expect(await balance(PRODUCT_1)).toBe(10);
    });

    it('refuses to delete a movement, even for the owner of the table', async () => {
      await stock(PRODUCT_1, 10);

      await expect(admin.query(`DELETE FROM stock_movement`)).rejects.toThrow(/append-only/);
      await expect(admin.query(`TRUNCATE stock_movement`)).rejects.toThrow(/append-only/);
      expect(await count('stock_movement')).toBe(1);
    });

    it('does not let the application role touch a movement or write a balance by hand', async () => {
      await stock(PRODUCT_1, 10);

      const attempts = [
        `UPDATE stock_movement SET delta = 999`,
        `DELETE FROM stock_movement`,
        `UPDATE stock_balance SET quantity = 999`,
        `INSERT INTO stock_balance (id_negocio, warehouse_id, product_id, quantity)
           VALUES ('${BUSINESS_A}', '${a.warehouseId}', '${PRODUCT_2}', 5)`,
      ];
      for (const sql of attempts) {
        await expect(
          asApplication(admin, BUSINESS_A, (client) => client.query(sql)),
          sql,
        ).rejects.toThrow(/permission denied/);
      }
      expect(await balance(PRODUCT_1)).toBe(10);
    });

    it('keeps the balance right when thousands of movements arrive in one statement', async () => {
      const operationId = randomUUID();
      await asApplication(admin, BUSINESS_A, async (client) => {
        await client.query(
          `INSERT INTO operation (id_negocio, operation_id, kind, user_id) VALUES ($1, $2, 'purchase', $3)`,
          [BUSINESS_A, operationId, a.ownerId],
        );
        await client.query(
          `INSERT INTO stock_movement (id_negocio, operation_id, warehouse_id, product_id, delta, reason)
           SELECT $1::uuid, $2::uuid, $3::uuid,
                  ('00000000-0000-4000-8000-' || lpad((n % 50)::text, 12, '0'))::uuid,
                  CASE WHEN n % 7 = 0 THEN -3 ELSE 2 END, 'purchase'
             FROM generate_series(1, 5000) AS n`,
          [BUSINESS_A, operationId, a.warehouseId],
        );
      });

      expect(await count('stock_movement')).toBe(5000);
      expect(await driftedBalances()).toEqual([]);
    });

    it('refuses a movement written without the business context, and leaves no trace of it', async () => {
      // Ni siquiera un superusuario puede escribir un movimiento sin decir de que negocio es:
      // el disparador escribe el saldo como un propietario sujeto a RLS, y sin contexto no puede.
      // La operacion existe de antemano para que las claves foraneas pasen y lo que falle sea el saldo.
      const operationId = randomUUID();
      await admin.query(
        `INSERT INTO operation (id_negocio, operation_id, kind, user_id) VALUES ($1, $2, 'purchase', $3)`,
        [BUSINESS_A, operationId, a.ownerId],
      );
      await expect(
        admin.query(
          `INSERT INTO stock_movement (id_negocio, operation_id, warehouse_id, product_id, delta, reason)
           VALUES ($1, $2, $3, $4, 5, 'purchase')`,
          [BUSINESS_A, operationId, a.warehouseId, PRODUCT_1],
        ),
      ).rejects.toThrow(/row-level security policy for table "stock_balance"/);

      expect(await count('stock_movement')).toBe(0);
    });
  });

  // ---------- Idempotencia ----------

  describe('idempotency by operationId', () => {
    it('answers a resent sale with the original and creates nothing twice', async () => {
      await stock(PRODUCT_1, 10);
      const shift = await openShift(admin, BUSINESS_A);
      const input = saleOf(shift, {
        lines: [{ productId: PRODUCT_1, quantity: 4, unitPrice: 250 }],
      });

      const first = await registerSale(admin, input);
      const again = await registerSale(admin, input);

      expect(first.replayed).toBe(false);
      expect(again).toEqual({ ...first, replayed: true });
      expect(await count('sale')).toBe(1);
      expect(await count('stock_movement')).toBe(2); // la compra y la venta
      expect(await count('cash_movement')).toBe(1);
      expect(await balance(PRODUCT_1)).toBe(6);
    });

    it('treats the same operationId in another business as a different operation', async () => {
      const operationId = randomUUID();
      await stock(PRODUCT_1, 10, BUSINESS_A);
      await stock(PRODUCT_OF_B, 10, BUSINESS_B);
      const shiftA = await openShift(admin, BUSINESS_A);
      const shiftB = await openShift(admin, BUSINESS_B);

      const a = await registerSale(admin, saleOf(shiftA, { operationId }));
      const b = await registerSale(
        admin,
        saleOf(shiftB, {
          operationId,
          businessId: BUSINESS_B,
          lines: [{ productId: PRODUCT_OF_B, quantity: 1, unitPrice: 1000 }],
        }),
      );

      expect(a.replayed).toBe(false);
      expect(b.replayed).toBe(false);
      expect(await balance(PRODUCT_1, BUSINESS_A)).toBe(9);
      expect(await balance(PRODUCT_OF_B, BUSINESS_B)).toBe(9);
    });

    it('applies exactly once when the same sale arrives ten times at the same moment', async () => {
      await stock(PRODUCT_1, 10);
      const shift = await openShift(admin, BUSINESS_A);
      const input = saleOf(shift);

      const outcomes = await Promise.all(
        Array.from({ length: 10 }, () => registerSale(admin, input)),
      );

      expect(outcomes.filter((outcome) => !outcome.replayed)).toHaveLength(1);
      expect(new Set(outcomes.map((outcome) => outcome.saleId)).size).toBe(1);
      expect(await count('sale')).toBe(1);
      expect(await balance(PRODUCT_1)).toBe(9);
    });
  });

  // ---------- Concurrencia ----------

  describe('concurrency', () => {
    it('loses no sale when thirty cashiers sell the same product at once', async () => {
      await stock(PRODUCT_1, 30);
      const shift = await openShift(admin, BUSINESS_A);

      await Promise.all(Array.from({ length: 30 }, () => registerSale(admin, saleOf(shift))));

      expect(await count('sale')).toBe(30);
      expect(await balance(PRODUCT_1)).toBe(0);
      expect(await driftedBalances()).toEqual([]);
    });

    it('accepts every sale of an oversold product and flags exactly those that left it negative', async () => {
      await stock(PRODUCT_1, 10);
      const shift = await openShift(admin, BUSINESS_A);

      const outcomes = await Promise.all(
        Array.from({ length: 20 }, () => registerSale(admin, saleOf(shift))),
      );

      expect(await count('sale')).toBe(20);
      expect(await balance(PRODUCT_1)).toBe(-10);
      expect(outcomes.filter((outcome) => outcome.needsAdjustment)).toHaveLength(10);
    });

    it('does not deadlock when sales that share two products arrive in opposite order', async () => {
      await stock(PRODUCT_1, 100);
      await stock(PRODUCT_2, 100);
      const shift = await openShift(admin, BUSINESS_A);
      const both = (first: string, second: string) =>
        saleOf(shift, {
          lines: [
            { productId: first, quantity: 1, unitPrice: 100 },
            { productId: second, quantity: 1, unitPrice: 100 },
          ],
        });

      await Promise.all(
        Array.from({ length: 40 }, (_, index) =>
          registerSale(
            admin,
            index % 2 === 0 ? both(PRODUCT_1, PRODUCT_2) : both(PRODUCT_2, PRODUCT_1),
          ),
        ),
      );

      expect(await count('sale')).toBe(40);
      expect(await balance(PRODUCT_1)).toBe(60);
      expect(await balance(PRODUCT_2)).toBe(60);
    });

    it('would miss an oversell if the check read a plain sum instead of the locked balance (why the balance exists)', async () => {
      // Sin el saldo (disparador apagado) cada venta suma solo lo confirmado mas lo suyo.
      await admin.query(`ALTER TABLE stock_movement DISABLE TRIGGER apply_stock_movement`);
      await stock(PRODUCT_1, 1);
      const sumSeenBy = async (client: pg.PoolClient): Promise<number> => {
        await insertMovement(client, PRODUCT_1, -1);
        const result = await client.query<{ total: string }>(
          `SELECT sum(delta) AS total FROM stock_movement
            WHERE id_negocio = $1 AND product_id = $2`,
          [BUSINESS_A, PRODUCT_1],
        );
        return Number(result.rows[0]?.total);
      };
      const left = await admin.connect();
      const right = await admin.connect();
      try {
        await left.query('BEGIN');
        await right.query('BEGIN');
        const seenByLeft = await sumSeenBy(left);
        const seenByRight = await sumSeenBy(right);
        await left.query('COMMIT');
        await right.query('COMMIT');

        // Las dos creen que quedaron en cero, y la existencia real quedo en -1: nadie lo marco.
        expect([seenByLeft, seenByRight]).toEqual([0, 0]);
        expect(await summed(PRODUCT_1)).toBe(-1);
      } finally {
        left.release();
        right.release();
        // El disparador es de la tabla, no de la prueba: se deja como estaba para las demas.
        await admin.query(`ALTER TABLE stock_movement ENABLE TRIGGER apply_stock_movement`);
      }
    });

    it('would deadlock if the movements were written in the order received (why they are sorted)', async () => {
      const left = await admin.connect();
      const right = await admin.connect();
      const insert = (client: pg.PoolClient, productId: string) =>
        insertMovement(client, productId, -1);
      try {
        for (const client of [left, right]) {
          await client.query('BEGIN');
          await client.query("SELECT set_config('app.id_negocio', $1, true)", [BUSINESS_A]);
        }
        await insert(left, PRODUCT_1);
        await insert(right, PRODUCT_2);
        const leftSecond = insert(left, PRODUCT_2).then(
          () => 'ok',
          (error: { code?: string }) => error.code,
        );
        const rightSecond = insert(right, PRODUCT_1).then(
          () => 'ok',
          (error: { code?: string }) => error.code,
        );
        const results = await Promise.all([leftSecond, rightSecond]);

        // PostgreSQL detecta el abrazo mortal y cancela a una de las dos.
        expect(results).toContain('40P01');
      } finally {
        await left.query('ROLLBACK').catch(() => undefined);
        await right.query('ROLLBACK').catch(() => undefined);
        left.release();
        right.release();
      }
    });
  });

  // ---------- Una venta es una sola operacion ----------

  describe('a sale is one unit of work', () => {
    it('accepts a sale that leaves the stock negative and marks it as needing adjustment', async () => {
      await stock(PRODUCT_1, 2);
      const shift = await openShift(admin, BUSINESS_A);

      const outcome = await registerSale(
        admin,
        saleOf(shift, { lines: [{ productId: PRODUCT_1, quantity: 5, unitPrice: 100 }] }),
      );

      expect(outcome.needsAdjustment).toBe(true);
      expect(await balance(PRODUCT_1)).toBe(-3);
      expect(await count('sale')).toBe(1);
    });

    it('does not mark a sale that the stock covers', async () => {
      await stock(PRODUCT_1, 5);
      const shift = await openShift(admin, BUSINESS_A);

      const outcome = await registerSale(admin, saleOf(shift));

      expect(outcome.needsAdjustment).toBe(false);
    });

    it('does not mark a sale that takes the stock exactly to zero', async () => {
      await stock(PRODUCT_1, 5);
      const shift = await openShift(admin, BUSINESS_A);

      const outcome = await registerSale(
        admin,
        saleOf(shift, { lines: [{ productId: PRODUCT_1, quantity: 5, unitPrice: 100 }] }),
      );

      expect(outcome.needsAdjustment).toBe(false);
      expect(await balance(PRODUCT_1)).toBe(0);
    });

    it('makes closing the shift wait for the sales in flight, so the cash count misses none', async () => {
      await stock(PRODUCT_1, 5);
      const shift = await openShift(admin, BUSINESS_A);
      let closed = false;
      let closing: Promise<unknown> = Promise.resolve();

      const sale = registerSale(admin, saleOf(shift), {
        afterShiftLock: async () => {
          closing = admin
            .query(
              `UPDATE cash_shift SET closed_at = now(), counted_amount = 0, closed_by_user_id = user_id WHERE id = $1`,
              [shift],
            )
            .then(() => {
              closed = true;
            });
          await new Promise((resolve) => setTimeout(resolve, 300));
          expect(closed).toBe(false); // el cierre sigue esperando a la venta
        },
      });

      await sale;
      await closing;

      expect(closed).toBe(true);
      expect(await count('cash_movement')).toBe(1);
    });

    it('forbids, in the database itself, a sale that points to a shift of another business', async () => {
      const shiftOfB = await openShift(admin, BUSINESS_B);

      const operationId = randomUUID();
      await admin.query(
        `INSERT INTO operation (id_negocio, operation_id, kind, user_id) VALUES ($1, $2, 'sale', $3)`,
        [BUSINESS_A, operationId, a.ownerId],
      );

      await expect(
        admin.query(
          `INSERT INTO sale (id_negocio, operation_id, shift_id, folio, folio_reported, total, needs_adjustment)
           VALUES ($1, $2, $3, 'X-1', 'X-1', 100, false)`,
          [BUSINESS_A, operationId, shiftOfB],
        ),
      ).rejects.toThrow(/sale_id_negocio_shift_id_fkey/);
    });

    it('records the cash collected for the sale in the open shift', async () => {
      await stock(PRODUCT_1, 5);
      const shift = await openShift(admin, BUSINESS_A);

      const outcome = await registerSale(
        admin,
        saleOf(shift, { lines: [{ productId: PRODUCT_1, quantity: 3, unitPrice: 1200 }] }),
      );

      const cash = await admin.query<{ amount: string; shift_id: string }>(
        `SELECT amount, shift_id FROM cash_movement WHERE id_negocio = $1`,
        [BUSINESS_A],
      );
      expect(outcome.total).toBe(3600);
      expect(cash.rows).toEqual([{ amount: '3600', shift_id: shift }]);
    });

    it('undoes everything when the shift is closed: no sale, no movements, no trace of the operation', async () => {
      await stock(PRODUCT_1, 5);
      const shift = await openShift(admin, BUSINESS_A);
      await admin.query(
        `UPDATE cash_shift SET closed_at = now(), counted_amount = 0, closed_by_user_id = user_id WHERE id = $1`,
        [shift],
      );
      const input = saleOf(shift);

      await expect(registerSale(admin, input)).rejects.toThrow(/shift/i);

      expect(await count('sale')).toBe(0);
      expect(await count('stock_movement')).toBe(1); // solo la compra de antes
      expect(await count('cash_movement')).toBe(0);
      expect(await count('operation')).toBe(1); // solo la compra de antes
      expect(await balance(PRODUCT_1)).toBe(5);

      // El mismo operationId, reenviado cuando ya hay un turno abierto, se aplica una sola vez.
      const open = await openShift(admin, BUSINESS_A);
      const retried = await registerSale(admin, { ...input, shiftId: open });
      expect(retried.replayed).toBe(false);
      expect(await balance(PRODUCT_1)).toBe(4);
    });

    it('undoes everything when the connection dies after the stock movements were written', async () => {
      await stock(PRODUCT_1, 5);
      const shift = await openShift(admin, BUSINESS_A);
      const input = saleOf(shift);

      await expect(
        registerSale(admin, input, {
          afterStockMovements: async (client) => {
            client.on('error', () => undefined);
            const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
            await admin.query('SELECT pg_terminate_backend($1)', [rows[0]?.pid]);
            await client.query('SELECT 1');
          },
        }),
      ).rejects.toThrow();

      expect(await count('sale')).toBe(0);
      expect(await count('stock_movement')).toBe(1);
      expect(await count('operation')).toBe(1);
      expect(await balance(PRODUCT_1)).toBe(5);

      const retried = await registerSale(admin, input);
      expect(retried.replayed).toBe(false);
      expect(await balance(PRODUCT_1)).toBe(4);
    });

    it('refuses a shift that belongs to another business', async () => {
      await stock(PRODUCT_1, 5);
      const shiftOfB = await openShift(admin, BUSINESS_B);

      await expect(registerSale(admin, saleOf(shiftOfB))).rejects.toThrow(/shift/i);
      expect(await count('sale')).toBe(0);
      expect(await balance(PRODUCT_1)).toBe(5);
    });
  });

  it('keeps the balance with an owner that is subject to row level security (no BYPASSRLS needed)', async () => {
    const owner = await admin.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT r.rolsuper, r.rolbypassrls
         FROM pg_proc p
         JOIN pg_roles r ON r.oid = p.proowner
        WHERE p.proname = 'apply_stock_movement' AND p.pronamespace = 'public'::regnamespace`,
    );
    await stock(PRODUCT_1, 7);

    expect(owner.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    expect(await balance(PRODUCT_1)).toBe(7);
  });

  it('pins an empty search_path on every SECURITY DEFINER function, so nobody can hijack it', async () => {
    const functions = await admin.query<{ proname: string; proconfig: string[] | null }>(
      `SELECT proname, proconfig FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace AND prosecdef`,
    );

    expect(functions.rows.length).toBeGreaterThan(0);
    for (const row of functions.rows) {
      expect(row.proconfig, row.proname).toContain('search_path=""');
    }
  });
});
