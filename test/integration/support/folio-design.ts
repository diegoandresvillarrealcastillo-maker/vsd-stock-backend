import type pg from 'pg';
import { DeviceCode } from '../../../src/domain/model/device-code.js';
import { resolveOperationTime } from '../../../src/domain/model/operation-time.js';
import { APP_ROLE, asApplication } from './database.js';

export const FOLIO_SCHEMA = 'folio_design';

export interface RecordedSale {
  replayed: boolean;
  folio: string;
  folioConflict: boolean;
  occurredAt: string;
  timeFlags: string[];
}

export interface SaleArrival {
  businessId: string;
  operationId: string;
  /** El folio que trajo el dispositivo. */
  folio: string;
  deviceTime: string;
  clockOffsetMs: number | null;
  receivedAt: string;
}

/**
 * Especificacion ejecutable del servidor en el ADR 0016: registrar dispositivos con un contador por negocio,
 * recibir una venta con su folio y su hora, y nunca rechazarla. Es un esquema de juguete (como ledger-design.ts):
 * las migraciones reales del Ciclo 2 lo traducen a Prisma.
 */
export async function createFolioDesign(admin: pg.Pool): Promise<void> {
  await dropFolioDesign(admin);
  await admin.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
        CREATE ROLE ${APP_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS;
      END IF;
    END $$;
    CREATE SCHEMA ${FOLIO_SCHEMA};
    GRANT USAGE ON SCHEMA ${FOLIO_SCHEMA} TO ${APP_ROLE};

    -- El contador por negocio es lo que impide que dos dispositivos reciban el mismo codigo: el UPDATE toma el
    -- candado de la fila y los registros simultaneos se turnan.
    CREATE TABLE ${FOLIO_SCHEMA}.device_counter (
      id_negocio uuid PRIMARY KEY,
      next_index integer NOT NULL
    );

    CREATE TABLE ${FOLIO_SCHEMA}.device (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      id_negocio uuid NOT NULL,
      device_code text NOT NULL,
      enrolled_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT device_code_unique UNIQUE (id_negocio, device_code)
    );

    CREATE TABLE ${FOLIO_SCHEMA}.sale (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      id_negocio uuid NOT NULL,
      operation_id uuid NOT NULL,
      folio text NOT NULL,
      folio_reported text NOT NULL,
      folio_conflict boolean NOT NULL DEFAULT false,
      device_time_raw text NOT NULL,
      occurred_at timestamptz NOT NULL,
      received_at timestamptz NOT NULL,
      time_source text NOT NULL CHECK (time_source IN ('device', 'corrected', 'received')),
      time_flags text[] NOT NULL DEFAULT '{}',
      CONSTRAINT sale_operation_unique UNIQUE (id_negocio, operation_id),
      CONSTRAINT sale_folio_unique UNIQUE (id_negocio, folio)
    );

    GRANT SELECT, INSERT, UPDATE ON ${FOLIO_SCHEMA}.device_counter TO ${APP_ROLE};
    GRANT SELECT, INSERT ON ${FOLIO_SCHEMA}.device TO ${APP_ROLE};
    GRANT SELECT, INSERT ON ${FOLIO_SCHEMA}.sale TO ${APP_ROLE};
  `);
  for (const table of ['device_counter', 'device', 'sale']) {
    await admin.query(`
      ALTER TABLE ${FOLIO_SCHEMA}.${table} ENABLE ROW LEVEL SECURITY;
      ALTER TABLE ${FOLIO_SCHEMA}.${table} FORCE ROW LEVEL SECURITY;
      CREATE POLICY business_isolation ON ${FOLIO_SCHEMA}.${table}
        USING (id_negocio = nullif(current_setting('app.id_negocio', true), '')::uuid)
        WITH CHECK (id_negocio = nullif(current_setting('app.id_negocio', true), '')::uuid);
    `);
  }
}

export async function dropFolioDesign(admin: pg.Pool): Promise<void> {
  await admin.query(`DROP SCHEMA IF EXISTS ${FOLIO_SCHEMA} CASCADE`);
}

/** Registra un dispositivo nuevo y devuelve su codigo. Nunca reutiliza uno, ni siquiera el de un dispositivo dado de baja. */
export async function enrollDevice(pool: pg.Pool, businessId: string): Promise<DeviceCode> {
  return asApplication(pool, businessId, async (client) => {
    const next = await client.query<{ index: number }>(
      `INSERT INTO ${FOLIO_SCHEMA}.device_counter (id_negocio, next_index) VALUES ($1, 1)
       ON CONFLICT (id_negocio) DO UPDATE SET next_index = ${FOLIO_SCHEMA}.device_counter.next_index + 1
       RETURNING next_index - 1 AS index`,
      [businessId],
    );
    const code = DeviceCode.forIndex(next.rows[0]!.index);
    await client.query(
      `INSERT INTO ${FOLIO_SCHEMA}.device (id_negocio, device_code) VALUES ($1, $2)`,
      [businessId, code.value],
    );
    return code;
  });
}

/**
 * Recibe una venta hecha sin conexion. La acepta SIEMPRE: si el folio ya existe con otra operacion (un
 * dispositivo clonado, por ejemplo) la guarda con un folio distinto y la marca; si la hora no se puede leer o
 * no cuadra, la corrige o la marca. Reenviarla devuelve lo que se guardo la primera vez.
 */
export async function recordSale(pool: pg.Pool, arrival: SaleArrival): Promise<RecordedSale> {
  return asApplication(pool, arrival.businessId, async (client) => {
    const previous = await client.query<{
      folio: string;
      folio_conflict: boolean;
      occurred_at: Date;
      time_flags: string[];
    }>(
      `SELECT folio, folio_conflict, occurred_at, time_flags FROM ${FOLIO_SCHEMA}.sale
        WHERE id_negocio = $1 AND operation_id = $2`,
      [arrival.businessId, arrival.operationId],
    );
    if (previous.rows[0] !== undefined) {
      const row = previous.rows[0];
      return {
        replayed: true,
        folio: row.folio,
        folioConflict: row.folio_conflict,
        occurredAt: row.occurred_at.toISOString(),
        timeFlags: row.time_flags,
      };
    }

    const time = resolveOperationTime({
      deviceTime: arrival.deviceTime,
      clockOffsetMs: arrival.clockOffsetMs,
      receivedAt: arrival.receivedAt,
    });
    const columns = [
      arrival.businessId,
      arrival.operationId,
      arrival.folio,
      arrival.deviceTime,
      time.effectiveAt,
      arrival.receivedAt,
      time.source,
      time.flags,
    ];
    const insert = (folio: string, conflict: boolean) =>
      client.query<{ folio: string }>(
        `INSERT INTO ${FOLIO_SCHEMA}.sale
           (id_negocio, operation_id, folio, folio_reported, folio_conflict, device_time_raw,
            occurred_at, received_at, time_source, time_flags)
         VALUES ($1, $2, $9, $3, $10, $4, $5, $6, $7, $8)
         ON CONFLICT (id_negocio, folio) DO NOTHING
         RETURNING folio`,
        [...columns, folio, conflict],
      );

    let stored = await insert(arrival.folio, false);
    let conflict = false;
    if (stored.rowCount === 0) {
      // El folio ya es de otra venta: esta se acepta igual, con un folio que no choca, y se marca.
      conflict = true;
      stored = await insert(`${arrival.folio}~${arrival.operationId.slice(0, 8)}`, true);
    }
    return {
      replayed: false,
      folio: stored.rows[0]!.folio,
      folioConflict: conflict,
      occurredAt: time.effectiveAt,
      timeFlags: [...time.flags],
    };
  });
}
