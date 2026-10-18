import type pg from 'pg';

/** Una fila leida a ciegas: cada valor es `unknown` y la prueba lo compara con lo que espera. */
export type Row = Record<string, unknown>;

/** Lee filas con la conexion de administracion. Solo para comprobar datos, nunca para probar el aislamiento. */
export async function select(
  pool: pg.Pool,
  text: string,
  params: readonly unknown[] = [],
): Promise<Row[]> {
  const result = await pool.query<Row>(text, [...params]);
  return result.rows;
}
