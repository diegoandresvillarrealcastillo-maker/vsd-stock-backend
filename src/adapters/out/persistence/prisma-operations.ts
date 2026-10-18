import { createHash } from 'node:crypto';
import type {
  OperationClaim,
  OperationClaimRequest,
  OperationRegistry,
} from '../../../domain/ports/out/operations.js';
import type { PrismaTransaction } from './prisma-unit-of-work.js';

/**
 * El registro de operaciones del negocio de la transaccion, sobre Prisma (ADR 0019). De la peticion solo se guarda su
 * huella (SHA-256): lo bastante para saber si un reintento es la misma peticion, y nada de lo que la peticion decia.
 *
 * Reclamar es `INSERT ... ON CONFLICT DO NOTHING` sobre la llave `(negocio, operationId)`: si otra transaccion la tiene
 * a medio hacer, esta ESPERA a que termine (con exito o no) y recien entonces decide, asi que dos peticiones iguales a
 * la vez nunca aplican dos veces.
 */
export class PrismaOperationRegistry implements OperationRegistry {
  constructor(
    private readonly tx: PrismaTransaction,
    private readonly businessId: string,
  ) {}

  async claim(request: OperationClaimRequest): Promise<OperationClaim> {
    const bodyHash = createHash('sha256').update(request.fingerprint, 'utf8').digest('hex');
    const { count } = await this.tx.operation.createMany({
      data: [
        {
          idNegocio: this.businessId,
          operationId: request.operationId,
          kind: request.kind,
          userId: request.userId,
          bodyHash,
        },
      ],
      skipDuplicates: true,
    });
    if (count === 1) return 'claimed';

    const known = await this.tx.operation.findFirst({
      where: { operationId: request.operationId },
      select: { kind: true, bodyHash: true },
    });
    return known !== null && known.kind === request.kind && known.bodyHash === bodyHash
      ? 'replay'
      : 'conflict';
  }
}
