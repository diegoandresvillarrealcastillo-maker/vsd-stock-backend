import type {
  IdentityDirectory,
  Membership,
} from '../../../domain/ports/out/identity-directory.js';
import { isRole } from '../../../domain/model/role.js';
import type { PrismaClient } from '../../../generated/prisma/client.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_WAIT_MS = 2_000;
const TIMEOUT_MS = 10_000;

/**
 * A que negocio pertenece una persona, antes de conocer el negocio (ADR 0021, punto 7). La transaccion fija
 * `app.auth_user_id` —el `sub` de un token ya verificado— y la politica `identity_lookup` de la base deja ver
 * UNA fila: la de esa persona. Con eso se averigua el negocio y el rol; el trabajo de negocio abre luego su propia
 * transaccion con `app.id_negocio`.
 */
export class PrismaIdentityDirectory implements IdentityDirectory {
  constructor(private readonly prisma: PrismaClient) {}

  async findMembership(authUserId: string): Promise<Membership | null> {
    if (!UUID.test(authUserId)) {
      throw new RangeError('The value is not a valid identity identifier (a UUID is expected)');
    }
    const row = await this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.auth_user_id', ${authUserId}, true)`;
        return tx.appUser.findFirst({
          where: { authUserId },
          select: { id: true, idNegocio: true, role: true, active: true, fullName: true },
        });
      },
      { maxWait: MAX_WAIT_MS, timeout: TIMEOUT_MS },
    );
    if (row === null) return null;
    if (!isRole(row.role)) {
      // La base lo impide con una restriccion; si llegara aqui, mejor caer que dar un rol que no existe.
      throw new Error(`The person ${row.id} has a role that does not exist`);
    }
    return {
      userId: row.id,
      businessId: row.idNegocio,
      role: row.role,
      active: row.active,
      fullName: row.fullName,
    };
  }
}
