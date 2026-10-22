import type pg from 'pg';
import { DeviceCode } from '../../../src/domain/model/device-code.js';
import { resolveOperationTime } from '../../../src/domain/model/operation-time.js';
import { asApplication } from './database.js';

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
 * Especificacion ejecutable del servidor en el ADR 0016, sobre las tablas REALES (ADR 0021): registrar
 * dispositivos con un contador por negocio, recibir una venta con su folio y su hora, y nunca rechazarla.
 * La hora y las marcas viven en `operation`; el folio, en `sale`.
 *
 * La venta de verdad la construye el Ciclo 3: aqui solo hace falta lo que el ADR 0016 prueba, con un turno y
 * un total que cumplan las claves foraneas.
 */

/** Registra un dispositivo nuevo y devuelve su codigo. Nunca reutiliza uno, ni siquiera el de un dispositivo dado de baja. */
export async function enrollDevice(pool: pg.Pool, businessId: string): Promise<DeviceCode> {
  return asApplication(pool, businessId, async (client) => {
    // El contador por negocio es lo que impide que dos dispositivos reciban el mismo codigo: el UPDATE toma el
    // candado de la fila y los registros simultaneos se turnan.
    const next = await client.query<{ index: number }>(
      `INSERT INTO device_counter (id_negocio, next_index) VALUES ($1, 1)
       ON CONFLICT (id_negocio) DO UPDATE SET next_index = device_counter.next_index + 1
       RETURNING next_index - 1 AS index`,
      [businessId],
    );
    const code = DeviceCode.forIndex(next.rows[0]!.index);
    await client.query(`INSERT INTO device (id_negocio, device_code) VALUES ($1, $2)`, [
      businessId,
      code.value,
    ]);
    return code;
  });
}

/** El turno abierto del negocio; si no hay, abre uno con el dispositivo y la persona de los datos de prueba. */
async function openShiftOf(client: pg.PoolClient, businessId: string): Promise<string> {
  const open = await client.query<{ id: string }>(
    'SELECT id FROM cash_shift WHERE id_negocio = $1 AND closed_at IS NULL LIMIT 1',
    [businessId],
  );
  if (open.rows[0] !== undefined) return open.rows[0].id;
  const opened = await client.query<{ id: string }>(
    `INSERT INTO cash_shift (id_negocio, device_id, user_id)
     SELECT $1, d.id, u.id FROM device d, app_user u
      WHERE d.id_negocio = $1 AND d.device_code = 'ZZ' AND u.id_negocio = $1 AND u.role = 'owner'
      LIMIT 1
     RETURNING id`,
    [businessId],
  );
  return opened.rows[0]!.id;
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
      `SELECT s.folio, s.folio_conflict, o.occurred_at, o.time_flags
         FROM sale s JOIN operation o USING (id_negocio, operation_id)
        WHERE s.id_negocio = $1 AND s.operation_id = $2`,
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
    const shiftId = await openShiftOf(client, arrival.businessId);
    await client.query(
      `INSERT INTO operation
         (id_negocio, operation_id, kind, user_id, device_id, occurred_at, received_at, device_time_raw,
          time_source, time_flags)
       SELECT $1, $2, 'sale', u.id, d.id, $3, $4, $5, $6, $7
         FROM app_user u, device d
        WHERE u.id_negocio = $1 AND u.role = 'owner' AND d.id_negocio = $1 AND d.device_code = 'ZZ'
        LIMIT 1`,
      [
        arrival.businessId,
        arrival.operationId,
        time.effectiveAt,
        arrival.receivedAt,
        arrival.deviceTime,
        time.source,
        time.flags,
      ],
    );

    const insert = (folio: string, conflict: boolean) =>
      client.query<{ folio: string }>(
        `INSERT INTO sale
           (id_negocio, operation_id, shift_id, folio, folio_reported, folio_conflict, total, needs_adjustment)
         VALUES ($1, $2, $3, $4, $5, $6, 0, false)
         ON CONFLICT (id_negocio, folio) DO NOTHING
         RETURNING folio`,
        [arrival.businessId, arrival.operationId, shiftId, folio, arrival.folio, conflict],
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
