import {
  AlreadyMemberError,
  InvitationExpiredError,
  InvitationNotFoundError,
} from '../../../domain/model/people-errors.js';
import { isRole } from '../../../domain/model/role.js';
import { isUuid } from '../../../domain/model/uuid.js';
import type {
  InvitationRedeemer,
  InvitationRedemption,
  RedeemedInvitation,
} from '../../../domain/ports/out/invitation-redeemer.js';
import type { PrismaClient } from '../../../generated/prisma/client.js';

const MAX_WAIT_MS = 2_000;
const TIMEOUT_MS = 10_000;

/** El error de Prisma por una restriccion de unicidad: en esta actualizacion, solo puede ser la identidad repetida. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
  );
}

/**
 * Canjea una invitacion sobre Prisma (ADR 0023). Quien canjea aun no tiene negocio, asi que la transaccion fija dos
 * cosas, y solo esas: el hash del codigo que conoce (con el la base le deja ver y tomar UNA fila) y la identidad a la que
 * se liga. Una vez tomada la fila, la misma transaccion pasa a ser del negocio al que pertenece para leer su nombre.
 */
export class PrismaInvitationRedeemer implements InvitationRedeemer {
  constructor(private readonly prisma: PrismaClient) {}

  async redeem(redemption: InvitationRedemption): Promise<RedeemedInvitation> {
    if (!isUuid(redemption.authUserId)) {
      throw new RangeError('The value is not a valid identity identifier (a UUID is expected)');
    }
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT
          set_config('app.invitation_hash', ${redemption.invitationHash}, true),
          set_config('app.auth_user_id', ${redemption.authUserId}, true)`;

        const pending = await tx.appUser.findFirst({
          where: { invitationHash: redemption.invitationHash, authUserId: null },
          select: {
            id: true,
            idNegocio: true,
            role: true,
            fullName: true,
            active: true,
            invitationExpiresAt: true,
          },
        });
        // No existe, ya se uso o se dio de baja: una sola respuesta, para no ensenar cual fue.
        if (pending === null || !pending.active) throw new InvitationNotFoundError();
        if (pending.invitationExpiresAt === null || pending.invitationExpiresAt <= redemption.now) {
          throw new InvitationExpiredError();
        }
        if (!isRole(pending.role)) {
          // La base lo impide con una restriccion; si llegara aqui, mejor caer que dar un rol que no existe.
          throw new Error(`The person ${pending.id} has a role that does not exist`);
        }

        try {
          const taken = await tx.appUser.updateManyAndReturn({
            where: { id: pending.id, authUserId: null, invitationHash: redemption.invitationHash },
            data: {
              authUserId: redemption.authUserId,
              invitationHash: null,
              invitationExpiresAt: null,
              ...(redemption.email !== null ? { email: redemption.email } : {}),
            },
            select: { id: true },
          });
          // Otra persona la canjeo entre leerla y tomarla.
          if (taken.length === 0) throw new InvitationNotFoundError();
        } catch (error) {
          // La identidad ya esta ligada a otro negocio. Se deshace todo: la invitacion sigue pendiente.
          if (isUniqueViolation(error)) throw new AlreadyMemberError();
          throw error;
        }

        // Desde aqui la persona es del negocio: la transaccion se fija a el para leer su nombre.
        await tx.$queryRaw`SELECT set_config('app.id_negocio', ${pending.idNegocio}, true)`;
        const business = await tx.business.findFirst({ select: { name: true } });
        if (business === null) {
          throw new Error(`The business ${pending.idNegocio} of an invitation could not be read`);
        }
        return {
          businessId: pending.idNegocio,
          businessName: business.name,
          userId: pending.id,
          role: pending.role,
          fullName: pending.fullName,
        };
      },
      { maxWait: MAX_WAIT_MS, timeout: TIMEOUT_MS },
    );
  }
}
