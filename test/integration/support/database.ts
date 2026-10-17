import pg from 'pg';
import { APP_ROLE } from '../../../scripts/prepare-database.ts';

export { APP_ROLE };

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
  return inTransactionAsApplication(
    pool,
    businessId === null ? {} : { 'app.id_negocio': businessId },
    work,
  );
}

/**
 * Como `asApplication`, pero con el contexto de IDENTIDAD: solo se sabe quien es la persona (el `sub` del token
 * verificado), todavia no su negocio. Es lo que permite resolver a que negocio pertenece (ADR 0022).
 */
export async function asIdentity<T>(
  pool: pg.Pool,
  authUserId: string,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  return inTransactionAsApplication(pool, { 'app.auth_user_id': authUserId }, work);
}

async function inTransactionAsApplication<T>(
  pool: pg.Pool,
  settings: Record<string, string>,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
    for (const [name, value] of Object.entries(settings)) {
      await client.query('SELECT set_config($1, $2, true)', [name, value]);
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
