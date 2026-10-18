import type pg from 'pg';
import { asApplication } from './database.js';

/**
 * Especificacion ejecutable del diseno del ADR 0013: el libro de movimientos, la existencia derivada y la venta
 * como una sola operacion. Escribio el diseno en un esquema de juguete (Ciclo 1); desde el Ciclo 2 corre sobre
 * las tablas REALES que crean las migraciones (ADR 0021), asi que lo que demuestra es lo que de verdad existe.
 *
 * La venta definitiva la construye el Ciclo 3 como caso de uso; aqui esta lo minimo para demostrar que una venta
 * con sus movimientos de stock y de caja es una sola transaccion.
 */

export { BUSINESS_A, BUSINESS_B } from './seed.js';

export interface SaleLine {
  productId: string;
  quantity: number;
  unitPrice: number;
}

export interface SaleInput {
  businessId: string;
  operationId: string;
  shiftId: string;
  lines: SaleLine[];
}

export interface SaleOutcome {
  /** `true` si la operacion ya se habia aplicado y esta respuesta es la de la primera vez. */
  replayed: boolean;
  saleId: string;
  total: number;
  needsAdjustment: boolean;
}

export interface SaleHooks {
  /** Se ejecuta dentro de la transaccion, despues de escribir los movimientos de stock. */
  afterStockMovements?: (client: pg.PoolClient) => Promise<void>;
  /** Se ejecuta dentro de la transaccion, con el turno ya bloqueado. */
  afterShiftLock?: (client: pg.PoolClient) => Promise<void>;
}

export interface StockEntry {
  businessId: string;
  operationId: string;
  productId: string;
  delta: number;
  reason: 'purchase' | 'adjustment';
}

/** Abre un turno de caja con el dispositivo y la persona de los datos de prueba (ver seed.ts). */
export async function openShift(pool: pg.Pool, businessId: string): Promise<string> {
  return asApplication(pool, businessId, async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO cash_shift (id_negocio, device_id, user_id)
       SELECT $1, d.id, u.id FROM device d, app_user u
        WHERE d.id_negocio = $1 AND d.device_code = 'ZZ' AND u.id_negocio = $1 AND u.role = 'owner'
        LIMIT 1
       RETURNING id`,
      [businessId],
    );
    return result.rows[0]!.id;
  });
}

/**
 * Reclama la operacion para este negocio. Devuelve `false` si ya estaba
 * reclamada. Si otra transaccion la esta reclamando en este momento, el INSERT
 * espera a que termine: si confirma, esta es una repeticion; si deshace, la
 * reclamamos nosotros.
 */
async function claimOperation(
  client: pg.PoolClient,
  businessId: string,
  operationId: string,
  kind: string,
): Promise<boolean> {
  const claimed = await client.query(
    `INSERT INTO operation (id_negocio, operation_id, kind, user_id)
     SELECT $1, $2, $3, u.id FROM app_user u WHERE u.id_negocio = $1 AND u.role = 'owner' LIMIT 1
     ON CONFLICT (id_negocio, operation_id) DO NOTHING`,
    [businessId, operationId, kind],
  );
  return claimed.rowCount === 1;
}

export async function recordStockEntry(pool: pg.Pool, entry: StockEntry): Promise<void> {
  await asApplication(pool, entry.businessId, async (client) => {
    if (!(await claimOperation(client, entry.businessId, entry.operationId, entry.reason))) return;
    await client.query(
      `INSERT INTO stock_movement (id_negocio, operation_id, warehouse_id, product_id, delta, reason)
       SELECT $1, $2, w.id, $3, $4, $5 FROM warehouse w WHERE w.id_negocio = $1 LIMIT 1`,
      [entry.businessId, entry.operationId, entry.productId, entry.delta, entry.reason],
    );
  });
}

interface SaleRow {
  id: string;
  total: string;
  needs_adjustment: boolean;
}

/**
 * La venta completa en UNA transaccion: reclamo de la operacion, movimientos de
 * stock, marca de ajuste, venta y cobro en efectivo. Si algo falla, no queda
 * nada, ni siquiera el reclamo, y el mismo `operationId` se puede reenviar.
 */
export async function registerSale(
  pool: pg.Pool,
  input: SaleInput,
  hooks: SaleHooks = {},
): Promise<SaleOutcome> {
  return asApplication(pool, input.businessId, async (client) => {
    const first = await claimOperation(client, input.businessId, input.operationId, 'sale');
    if (!first) {
      const previous = await client.query<SaleRow>(
        `SELECT id, total, needs_adjustment FROM sale WHERE id_negocio = $1 AND operation_id = $2`,
        [input.businessId, input.operationId],
      );
      const row = previous.rows[0]!;
      return {
        replayed: true,
        saleId: row.id,
        total: Number(row.total),
        needsAdjustment: row.needs_adjustment,
      };
    }

    // En orden de producto: dos ventas que comparten productos toman los
    // candados de los saldos en el mismo orden y nunca se esperan en circulo.
    const lines = [...input.lines].sort((a, b) => a.productId.localeCompare(b.productId));
    for (const line of lines) {
      await client.query(
        `INSERT INTO stock_movement (id_negocio, operation_id, warehouse_id, product_id, delta, reason)
         SELECT $1, $2, w.id, $3, $4, 'sale' FROM warehouse w WHERE w.id_negocio = $1 LIMIT 1`,
        [input.businessId, input.operationId, line.productId, -line.quantity],
      );
    }
    if (hooks.afterStockMovements !== undefined) await hooks.afterStockMovements(client);

    // Los saldos de estos productos ya llevan nuestro cambio y estan bloqueados
    // por nosotros hasta confirmar: lo que leemos es lo que quedara.
    const negative = await client.query(
      `SELECT 1 FROM stock_balance
        WHERE id_negocio = $1 AND product_id = ANY($2::uuid[]) AND quantity < 0 LIMIT 1`,
      [input.businessId, lines.map((line) => line.productId)],
    );
    const needsAdjustment = negative.rowCount === 1;

    // El turno se bloquea al final y en modo compartido: cerrarlo espera a las
    // ventas en curso, y el candado dura lo minimo.
    const shift = await client.query(
      `SELECT 1 FROM cash_shift
        WHERE id_negocio = $1 AND id = $2 AND closed_at IS NULL FOR SHARE`,
      [input.businessId, input.shiftId],
    );
    if (shift.rowCount !== 1) {
      throw new Error(`The shift ${input.shiftId} is not open for this business`);
    }
    if (hooks.afterShiftLock !== undefined) await hooks.afterShiftLock(client);

    const total = lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);
    const folio = `T-${input.operationId.slice(0, 8)}`;
    const sale = await client.query<{ id: string }>(
      `INSERT INTO sale (id_negocio, operation_id, shift_id, folio, folio_reported, total, needs_adjustment)
       VALUES ($1, $2, $3, $4, $4, $5, $6) RETURNING id`,
      [input.businessId, input.operationId, input.shiftId, folio, total, needsAdjustment],
    );
    if (total > 0) {
      await client.query(
        `INSERT INTO cash_movement (id_negocio, operation_id, shift_id, direction, amount)
         VALUES ($1, $2, $3, 'in', $4)`,
        [input.businessId, input.operationId, input.shiftId, total],
      );
    }
    return { replayed: false, saleId: sale.rows[0]!.id, total, needsAdjustment };
  });
}
