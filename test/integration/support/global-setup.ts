import { prepareDatabase } from '../../../scripts/prepare-database.ts';

/**
 * Una sola vez por corrida: roles, esquema vacio y las migraciones REALES aplicadas con Prisma. Las
 * especificaciones trabajan sobre esas tablas, no sobre esquemas de juguete (ADR 0021).
 */
export async function setup(): Promise<void> {
  await prepareDatabase();
}
