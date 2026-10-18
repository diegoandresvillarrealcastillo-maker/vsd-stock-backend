import { UserInactiveError, type Session } from '../../domain/ports/in/authenticate.js';
import type { GetMe, MeView } from '../../domain/ports/in/get-me.js';
import type { UnitOfWork } from '../../domain/ports/out/unit-of-work.js';

/** Caso de uso: «quien soy». Una persona sin negocio todavia recibe `membership: null`; una dada de baja, un error. */
export class GetMeUseCase implements GetMe {
  constructor(private readonly work: UnitOfWork) {}

  async execute(session: Session): Promise<MeView> {
    const identity = { id: session.identity.subject, email: session.identity.email };
    const membership = session.membership;
    if (membership === null) return { identity, membership: null };
    if (!membership.active) throw new UserInactiveError();

    const business = await this.work.inBusiness(membership.businessId, (scope) =>
      scope.business.current(),
    );
    if (business === null) {
      // Una persona con negocio cuyo negocio no se lee es una base rota, no una persona sin negocio.
      throw new Error(`The business ${membership.businessId} of a member could not be read`);
    }
    return {
      identity,
      membership: {
        userId: membership.userId,
        businessId: membership.businessId,
        businessName: business.name,
        role: membership.role,
        fullName: membership.fullName,
      },
    };
  }
}
