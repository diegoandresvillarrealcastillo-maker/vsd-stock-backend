import { randomUUID } from 'node:crypto';
import { AlreadyMemberError } from '../../../domain/model/people-errors.js';
import type {
  BusinessSetup,
  CreatedBusiness,
  NewBusiness,
} from '../../../domain/ports/out/business-setup.js';
import type { PrismaUnitOfWork } from './prisma-unit-of-work.js';

/** El error de Prisma por una restriccion de unicidad (en `app_user`, solo puede ser la identidad repetida). */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
  );
}

/**
 * Abre un negocio sobre Prisma. El negocio todavia no existe, asi que su identificador lo da este adaptador y la
 * transaccion se abre YA fijada a el: la seguridad por fila deja escribir exactamente lo que le pertenece (ADR 0005).
 */
export class PrismaBusinessSetup implements BusinessSetup {
  constructor(private readonly unitOfWork: PrismaUnitOfWork) {}

  async createBusiness(business: NewBusiness): Promise<CreatedBusiness> {
    const businessId = randomUUID();
    return this.unitOfWork.transaction(businessId, async (tx) => {
      await tx.business.create({ data: { id: businessId, name: business.businessName } });
      const branch = await tx.branch.create({
        data: { idNegocio: businessId, name: 'Principal' },
        select: { id: true },
      });
      await tx.warehouse.create({
        data: { idNegocio: businessId, branchId: branch.id, name: 'Principal' },
      });
      try {
        const owner = await tx.appUser.create({
          data: {
            idNegocio: businessId,
            authUserId: business.owner.authUserId,
            email: business.owner.email,
            fullName: business.owner.fullName,
            role: 'owner',
          },
          select: { id: true },
        });
        return { businessId, userId: owner.id };
      } catch (error) {
        // Una persona pertenece a un solo negocio: la identidad ya esta ligada a otro. Se deshace todo.
        if (isUniqueViolation(error)) throw new AlreadyMemberError();
        throw error;
      }
    });
  }
}
