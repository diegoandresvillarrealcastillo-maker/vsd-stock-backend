import { randomUUID } from 'node:crypto';
import type pg from 'pg';

/**
 * Datos de prueba sobre el esquema REAL (ADR 0021). Se escriben con la conexion de administracion, que no pasa
 * por RLS: son el punto de partida, no lo que se prueba.
 */

export const BUSINESS_A = '11111111-1111-4111-8111-111111111111';
export const BUSINESS_B = '22222222-2222-4222-8222-222222222222';

export interface SeededBusiness {
  businessId: string;
  branchId: string;
  warehouseId: string;
  /** Una persona dueña, para las operaciones que exigen quien las hizo. */
  ownerId: string;
  /** Un dispositivo, para los turnos de caja. Su codigo es `ZZ` a proposito, lejos de los que reparte el contador. */
  deviceId: string;
}

/** Deja la base sin un solo dato, incluso el libro de movimientos (que no se puede truncar con los disparadores). */
export async function resetData(admin: pg.Pool): Promise<void> {
  const client = await admin.connect();
  try {
    // En esta sesion los disparadores no corren: asi se puede vaciar el libro, que es de solo agregar.
    await client.query('SET session_replication_role = replica');
    await client.query('TRUNCATE business CASCADE');
    await client.query('SET session_replication_role = DEFAULT');
  } finally {
    client.release();
  }
}

export async function seedBusiness(
  admin: pg.Pool,
  businessId: string,
  name = `Negocio ${businessId.slice(0, 4)}`,
): Promise<SeededBusiness> {
  const seeded: SeededBusiness = {
    businessId,
    branchId: randomUUID(),
    warehouseId: randomUUID(),
    ownerId: randomUUID(),
    deviceId: randomUUID(),
  };
  await admin.query('INSERT INTO business (id, name) VALUES ($1, $2)', [businessId, name]);
  await admin.query('INSERT INTO branch (id, id_negocio, name) VALUES ($1, $2, $3)', [
    seeded.branchId,
    businessId,
    'Principal',
  ]);
  await admin.query(
    'INSERT INTO warehouse (id, id_negocio, branch_id, name) VALUES ($1, $2, $3, $4)',
    [seeded.warehouseId, businessId, seeded.branchId, 'Bodega'],
  );
  await admin.query(
    `INSERT INTO app_user (id, id_negocio, auth_user_id, full_name, role)
     VALUES ($1, $2, $3, 'Dueña', 'owner')`,
    [seeded.ownerId, businessId, randomUUID()],
  );
  await admin.query(
    `INSERT INTO device (id, id_negocio, device_code, enrolled_by_user_id)
     VALUES ($1, $2, 'ZZ', $3)`,
    [seeded.deviceId, businessId, seeded.ownerId],
  );
  return seeded;
}

let productCounter = 0;

/** Un producto valido. `productId` permite fijar el identificador para que una prueba lo nombre. */
export async function seedProduct(
  admin: pg.Pool,
  businessId: string,
  productId: string = randomUUID(),
  overrides: { sku?: string; unit?: string } = {},
): Promise<string> {
  productCounter += 1;
  await admin.query(
    `INSERT INTO product (id, id_negocio, name, sku, unit, unit_price, tax_rate_bp, tax_kind)
     VALUES ($1, $2, $3, $4, $5, 1000, 1900, 'taxed')`,
    [
      productId,
      businessId,
      `Producto ${productCounter}`,
      overrides.sku ?? `SKU-${productCounter}-${productId.slice(0, 8)}`,
      overrides.unit ?? 'unit',
    ],
  );
  return productId;
}
