import type pg from 'pg';

/**
 * Devuelve las tablas del esquema que tienen una columna `id_negocio` y cuyo
 * RLS no esta habilitado Y forzado (ADR 0005). Una lista vacia es lo correcto.
 *
 * Mira el catalogo de PostgreSQL, no los archivos de migracion: lo que cuenta
 * es lo que la base realmente tiene.
 */
export async function findTablesWithoutForcedRls(
  admin: pg.Pool,
  schema: string,
): Promise<string[]> {
  const result = await admin.query<{ table_name: string }>(
    `SELECT c.relname AS table_name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND c.relkind IN ('r', 'p')
        AND EXISTS (
          SELECT 1
            FROM pg_attribute a
           WHERE a.attrelid = c.oid
             AND a.attname = 'id_negocio'
             AND NOT a.attisdropped
        )
        AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
      ORDER BY c.relname`,
    [schema],
  );
  return result.rows.map((row) => row.table_name);
}
