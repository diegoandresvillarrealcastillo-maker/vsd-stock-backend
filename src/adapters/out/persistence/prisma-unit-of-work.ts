import type {
  BusinessReader,
  BusinessScope,
  BusinessSummary,
  UnitOfWork,
} from '../../../domain/ports/out/unit-of-work.js';
import type { Prisma, PrismaClient } from '../../../generated/prisma/client.js';

/** La transaccion de Prisma, ya con el negocio fijado. Solo la usan los repositorios de este adaptador. */
export type PrismaTransaction = Prisma.TransactionClient;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Cuanto puede esperar una transaccion por una conexion libre y cuanto puede durar: cortas a proposito (ADR 0013). */
const MAX_WAIT_MS = 2_000;
const TIMEOUT_MS = 10_000;

class PrismaBusinessReader implements BusinessReader {
  constructor(private readonly tx: PrismaTransaction) {}

  async current(): Promise<BusinessSummary | null> {
    // La seguridad por fila deja ver UN solo negocio: el de la transaccion.
    const row = await this.tx.business.findFirst({ select: { id: true, name: true } });
    return row === null ? null : { id: row.id, name: row.name };
  }
}

/**
 * Unidad de trabajo sobre Prisma y PostgreSQL. Cada llamada abre UNA transaccion y, antes de cualquier consulta, fija
 * `app.id_negocio` con `set_config(..., true)`: el valor es local a la transaccion, asi que no sobrevive a ella ni se
 * filtra a quien reuse la conexion (ADR 0005). La seguridad por fila de la base hace el resto.
 */
export class PrismaUnitOfWork implements UnitOfWork {
  constructor(private readonly prisma: PrismaClient) {}

  async inBusiness<T>(businessId: string, work: (scope: BusinessScope) => Promise<T>): Promise<T> {
    return this.transaction(businessId, (tx) =>
      work({ businessId, business: new PrismaBusinessReader(tx) }),
    );
  }

  /**
   * La misma transaccion pero entregando el cliente de Prisma: es lo que usan los repositorios de este adaptador
   * (cada uno recibe la transaccion y arma su consulta). Quien llama desde application/ usa `inBusiness`.
   */
  async transaction<T>(
    businessId: string,
    work: (tx: PrismaTransaction) => Promise<T>,
  ): Promise<T> {
    // Se valida antes de tocar la base: un identificador que no es un UUID no es un negocio, y asi el error es claro.
    if (!UUID.test(businessId)) {
      throw new RangeError('The value is not a valid business identifier (a UUID is expected)');
    }
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.id_negocio', ${businessId}, true)`;
        return work(tx);
      },
      { maxWait: MAX_WAIT_MS, timeout: TIMEOUT_MS },
    );
  }
}
