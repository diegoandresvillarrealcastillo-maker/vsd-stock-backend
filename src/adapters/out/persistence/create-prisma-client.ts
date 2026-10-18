import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../../generated/prisma/client.js';

export interface PrismaClientOptions {
  /** Cuantas conexiones abre como maximo. Por omision, 10. */
  readonly max?: number;
}

/**
 * El cliente de Prisma, con su adaptador de PostgreSQL. La cadena de conexion lleva la contrasena: este es el unico
 * lugar que la recibe y nunca la imprime.
 */
export function createPrismaClient(
  connectionString: string,
  options: PrismaClientOptions = {},
): PrismaClient {
  const adapter = new PrismaPg({ connectionString, max: options.max ?? 10 });
  return new PrismaClient({ adapter });
}
