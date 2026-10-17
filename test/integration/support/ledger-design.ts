import type pg from 'pg';
import { APP_ROLE, asApplication } from './database.js';

/**
 * Especificacion ejecutable del diseno del ADR 0013: el libro de movimientos,
 * la existencia derivada y la venta como una sola operacion.
 *
 * Es un esquema de juguete (como el de isolation-fixture.ts): demuestra el
 * diseno en un PostgreSQL real antes de que exista el esquema de negocio.
 * Las migraciones reales del Ciclo 2 lo traducen a Prisma.
 */

export const LEDGER_SCHEMA = 'ledger_design';
export const BUSINESS_A = '11111111-1111-4111-8111-111111111111';
export const BUSINESS_B = '22222222-2222-4222-8222-222222222222';

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

/** Las politicas son las del ADR 0005: el negocio de la fila contra el de la transaccion. */
const POLICY = `
  USING (id_negocio = nullif(current_setting('app.id_negocio', true), '')::uuid)
  WITH CHECK (id_negocio = nullif(current_setting('app.id_negocio', true), '')::uuid)`;

const TABLES = [
  'operation',
  'cash_shift',
  'sale',
  'stock_movement',
  'stock_balance',
  'cash_movement',
];

/**
 * Propietario de las tablas y de las funciones: el papel del rol de migraciones
 * real. A proposito NO es superusuario ni tiene BYPASSRLS, para demostrar que el
 * disparador funciona aun cuando el propietario esta sujeto a RLS (FORCE): el
 * contexto del negocio sigue puesto dentro de la transaccion.
 */
export const OWNER_ROLE = 'stock_owner_test';

export async function createLedgerDesign(admin: pg.Pool): Promise<void> {
  await dropLedgerDesign(admin);
  await admin.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
        CREATE ROLE ${APP_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS;
      END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${OWNER_ROLE}') THEN
        CREATE ROLE ${OWNER_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS;
      END IF;
    END $$;
    -- Los roles sobreviven a DROP SCHEMA: se vuelven a dejar como deben ser.
    ALTER ROLE ${OWNER_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE SCHEMA ${LEDGER_SCHEMA};
    GRANT USAGE ON SCHEMA ${LEDGER_SCHEMA} TO ${APP_ROLE};

    -- Cada operacion que llega del dispositivo se registra una sola vez por
    -- negocio: la clave primaria ES la idempotencia (ADR 0009).
    CREATE TABLE ${LEDGER_SCHEMA}.operation (
      id_negocio uuid NOT NULL,
      operation_id uuid NOT NULL,
      kind text NOT NULL,
      received_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id_negocio, operation_id)
    );

    CREATE TABLE ${LEDGER_SCHEMA}.cash_shift (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      id_negocio uuid NOT NULL,
      opened_at timestamptz NOT NULL DEFAULT now(),
      closed_at timestamptz,
      -- Permite la clave foranea compuesta: un turno de otro negocio no se puede referenciar.
      UNIQUE (id_negocio, id)
    );

    CREATE TABLE ${LEDGER_SCHEMA}.sale (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      id_negocio uuid NOT NULL,
      operation_id uuid NOT NULL,
      shift_id uuid NOT NULL,
      total bigint NOT NULL CHECK (total >= 0),
      needs_adjustment boolean NOT NULL,
      UNIQUE (id_negocio, operation_id),
      CONSTRAINT sale_shift_fk FOREIGN KEY (id_negocio, shift_id)
        REFERENCES ${LEDGER_SCHEMA}.cash_shift (id_negocio, id)
    );

    -- El libro: solo se agrega. Corregir es agregar otro movimiento.
    CREATE TABLE ${LEDGER_SCHEMA}.stock_movement (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      id_negocio uuid NOT NULL,
      operation_id uuid NOT NULL,
      product_id uuid NOT NULL,
      delta bigint NOT NULL CHECK (delta <> 0),
      reason text NOT NULL CHECK (reason IN ('sale', 'purchase', 'adjustment', 'void')),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX stock_movement_product ON ${LEDGER_SCHEMA}.stock_movement (id_negocio, product_id);

    -- La existencia: una fila por producto, derivada del libro. Solo la escribe
    -- el disparador; la aplicacion tiene permiso de lectura y nada mas.
    CREATE TABLE ${LEDGER_SCHEMA}.stock_balance (
      id_negocio uuid NOT NULL,
      product_id uuid NOT NULL,
      quantity bigint NOT NULL,
      PRIMARY KEY (id_negocio, product_id)
    );

    CREATE TABLE ${LEDGER_SCHEMA}.cash_movement (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      id_negocio uuid NOT NULL,
      operation_id uuid NOT NULL,
      shift_id uuid NOT NULL,
      amount bigint NOT NULL CHECK (amount > 0),
      CONSTRAINT cash_movement_shift_fk FOREIGN KEY (id_negocio, shift_id)
        REFERENCES ${LEDGER_SCHEMA}.cash_shift (id_negocio, id)
    );

    -- Cada movimiento suma su cambio al saldo en la MISMA transaccion. El upsert
    -- toma el candado de la fila del saldo, asi que dos ventas del mismo producto
    -- se turnan en lugar de pisarse. SECURITY DEFINER: la aplicacion no puede
    -- escribir el saldo, pero el disparador si, y solo con lo que el movimiento
    -- (que ya paso por RLS) dicta.
    CREATE FUNCTION ${LEDGER_SCHEMA}.apply_stock_movement() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
    AS $$
    BEGIN
      INSERT INTO ${LEDGER_SCHEMA}.stock_balance AS b (id_negocio, product_id, quantity)
      VALUES (NEW.id_negocio, NEW.product_id, NEW.delta)
      ON CONFLICT (id_negocio, product_id)
      DO UPDATE SET quantity = b.quantity + EXCLUDED.quantity;
      RETURN NULL;
    END
    $$;
    CREATE TRIGGER apply_stock_movement AFTER INSERT ON ${LEDGER_SCHEMA}.stock_movement
      FOR EACH ROW EXECUTE FUNCTION ${LEDGER_SCHEMA}.apply_stock_movement();

    -- Inmutabilidad: ni siquiera quien es dueno de la tabla puede editar o borrar.
    CREATE FUNCTION ${LEDGER_SCHEMA}.refuse_ledger_change() RETURNS trigger
      LANGUAGE plpgsql SET search_path = ''
    AS $$
    BEGIN
      RAISE EXCEPTION 'stock_movement is append-only: add a compensating movement instead'
        USING ERRCODE = 'integrity_constraint_violation';
    END
    $$;
    CREATE TRIGGER refuse_ledger_change BEFORE UPDATE OR DELETE ON ${LEDGER_SCHEMA}.stock_movement
      FOR EACH ROW EXECUTE FUNCTION ${LEDGER_SCHEMA}.refuse_ledger_change();
    CREATE TRIGGER refuse_ledger_truncate BEFORE TRUNCATE ON ${LEDGER_SCHEMA}.stock_movement
      FOR EACH STATEMENT EXECUTE FUNCTION ${LEDGER_SCHEMA}.refuse_ledger_change();

    GRANT SELECT, INSERT ON ${LEDGER_SCHEMA}.operation TO ${APP_ROLE};
    -- UPDATE en el turno: cerrarlo, y bloquearlo (SELECT ... FOR SHARE) al vender.
    GRANT SELECT, INSERT, UPDATE ON ${LEDGER_SCHEMA}.cash_shift TO ${APP_ROLE};
    GRANT SELECT, INSERT ON ${LEDGER_SCHEMA}.sale TO ${APP_ROLE};
    GRANT SELECT, INSERT ON ${LEDGER_SCHEMA}.stock_movement TO ${APP_ROLE};
    GRANT SELECT ON ${LEDGER_SCHEMA}.stock_balance TO ${APP_ROLE};
    GRANT SELECT, INSERT ON ${LEDGER_SCHEMA}.cash_movement TO ${APP_ROLE};
  `);

  for (const table of TABLES) {
    await admin.query(`
      ALTER TABLE ${LEDGER_SCHEMA}.${table} ENABLE ROW LEVEL SECURITY;
      ALTER TABLE ${LEDGER_SCHEMA}.${table} FORCE ROW LEVEL SECURITY;
      CREATE POLICY business_isolation ON ${LEDGER_SCHEMA}.${table} ${POLICY};
    `);
  }

  // Al final: las tablas y las funciones pasan a un propietario sujeto a RLS.
  const owned = TABLES.map(
    (table) => `ALTER TABLE ${LEDGER_SCHEMA}.${table} OWNER TO ${OWNER_ROLE};`,
  );
  await admin.query(`
    ALTER SCHEMA ${LEDGER_SCHEMA} OWNER TO ${OWNER_ROLE};
    ${owned.join('\n')}
    ALTER FUNCTION ${LEDGER_SCHEMA}.apply_stock_movement() OWNER TO ${OWNER_ROLE};
    ALTER FUNCTION ${LEDGER_SCHEMA}.refuse_ledger_change() OWNER TO ${OWNER_ROLE};
  `);
}

export async function dropLedgerDesign(admin: pg.Pool): Promise<void> {
  await admin.query(`DROP SCHEMA IF EXISTS ${LEDGER_SCHEMA} CASCADE`);
}

export async function openShift(pool: pg.Pool, businessId: string): Promise<string> {
  return asApplication(pool, businessId, async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO ${LEDGER_SCHEMA}.cash_shift (id_negocio) VALUES ($1) RETURNING id`,
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
    `INSERT INTO ${LEDGER_SCHEMA}.operation (id_negocio, operation_id, kind)
     VALUES ($1, $2, $3)
     ON CONFLICT (id_negocio, operation_id) DO NOTHING`,
    [businessId, operationId, kind],
  );
  return claimed.rowCount === 1;
}

export async function recordStockEntry(pool: pg.Pool, entry: StockEntry): Promise<void> {
  await asApplication(pool, entry.businessId, async (client) => {
    if (!(await claimOperation(client, entry.businessId, entry.operationId, 'stock_entry'))) return;
    await client.query(
      `INSERT INTO ${LEDGER_SCHEMA}.stock_movement (id_negocio, operation_id, product_id, delta, reason)
       VALUES ($1, $2, $3, $4, $5)`,
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
        `SELECT id, total, needs_adjustment FROM ${LEDGER_SCHEMA}.sale
          WHERE id_negocio = $1 AND operation_id = $2`,
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
        `INSERT INTO ${LEDGER_SCHEMA}.stock_movement (id_negocio, operation_id, product_id, delta, reason)
         VALUES ($1, $2, $3, $4, 'sale')`,
        [input.businessId, input.operationId, line.productId, -line.quantity],
      );
    }
    if (hooks.afterStockMovements !== undefined) await hooks.afterStockMovements(client);

    // Los saldos de estos productos ya llevan nuestro cambio y estan bloqueados
    // por nosotros hasta confirmar: lo que leemos es lo que quedara.
    const negative = await client.query(
      `SELECT 1 FROM ${LEDGER_SCHEMA}.stock_balance
        WHERE id_negocio = $1 AND product_id = ANY($2::uuid[]) AND quantity < 0 LIMIT 1`,
      [input.businessId, lines.map((line) => line.productId)],
    );
    const needsAdjustment = negative.rowCount === 1;

    // El turno se bloquea al final y en modo compartido: cerrarlo espera a las
    // ventas en curso, y el candado dura lo minimo.
    const shift = await client.query(
      `SELECT 1 FROM ${LEDGER_SCHEMA}.cash_shift
        WHERE id_negocio = $1 AND id = $2 AND closed_at IS NULL FOR SHARE`,
      [input.businessId, input.shiftId],
    );
    if (shift.rowCount !== 1) {
      throw new Error(`The shift ${input.shiftId} is not open for this business`);
    }
    if (hooks.afterShiftLock !== undefined) await hooks.afterShiftLock(client);

    const total = lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);
    const sale = await client.query<{ id: string }>(
      `INSERT INTO ${LEDGER_SCHEMA}.sale (id_negocio, operation_id, shift_id, total, needs_adjustment)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [input.businessId, input.operationId, input.shiftId, total, needsAdjustment],
    );
    if (total > 0) {
      await client.query(
        `INSERT INTO ${LEDGER_SCHEMA}.cash_movement (id_negocio, operation_id, shift_id, amount)
         VALUES ($1, $2, $3, $4)`,
        [input.businessId, input.operationId, input.shiftId, total],
      );
    }
    return { replayed: false, saleId: sale.rows[0]!.id, total, needsAdjustment };
  });
}
