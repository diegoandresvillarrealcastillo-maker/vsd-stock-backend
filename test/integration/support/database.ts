import pg from 'pg';

/** Rol que representa a la aplicacion: sin privilegios, sin BYPASSRLS, no propietario. */
export const APP_ROLE = 'stock_app_test';

/** Conexion de administracion: solo para preparar y comprobar datos, nunca para probar el aislamiento. */
export function createAdminPool(max = 4): pg.Pool {
  const url = process.env['TEST_DATABASE_URL'];
  if (url === undefined || url === '') {
    throw new Error(
      'Falta TEST_DATABASE_URL. En local arranca la base con `npm run db:up` y usa `npm run test:integration`.',
    );
  }
  return new pg.Pool({ connectionString: url, max });
}

/**
 * Ejecuta `work` como lo hara la API: dentro de UNA transaccion, con el rol de
 * la aplicacion y, si se indica, con el contexto de un negocio fijado solo
 * para esa transaccion (ADR 0005). Sin negocio, no hay contexto.
 */
export async function asApplication<T>(
  pool: pg.Pool,
  businessId: string | null,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
    if (businessId !== null) {
      await client.query("SELECT set_config('app.id_negocio', $1, true)", [businessId]);
    }
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
