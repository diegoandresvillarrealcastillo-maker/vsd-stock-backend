import { AlreadyMemberError } from '../../domain/model/people-errors.js';
import { InputReader } from '../../domain/model/validation.js';
import type { Session } from '../../domain/ports/in/authenticate.js';
import type { CreateBusiness } from '../../domain/ports/in/business-people.js';
import type { MembershipView } from '../../domain/ports/in/get-me.js';
import type { BusinessSetup } from '../../domain/ports/out/business-setup.js';
import { normalizedEmail } from '../session-guards.js';

/** Lo que cabe en `business.name` y `app_user.full_name` (ADR 0021). */
const MAX_NAME_LENGTH = 120;

/**
 * Caso de uso: abrir un negocio. Lo hace quien se registro en el servicio de identidad y aun no pertenece a ninguno;
 * queda como dueno (ADR 0023). El negocio, su primera sucursal y su primera bodega nacen juntos o no nace nada.
 */
export class CreateBusinessUseCase implements CreateBusiness {
  constructor(private readonly setup: BusinessSetup) {}

  async execute(session: Session, body: unknown): Promise<MembershipView> {
    // Quien ya pertenece a un negocio no abre otro, aunque haya sido dado de baja: se mira antes que lo que mando.
    if (session.membership !== null) throw new AlreadyMemberError();

    const reader = new InputReader(body, ['businessName', 'ownerName']);
    const businessName = reader.text('businessName', {
      label: 'El nombre del negocio',
      max: MAX_NAME_LENGTH,
    });
    const ownerName = reader.text('ownerName', { label: 'Tu nombre', max: MAX_NAME_LENGTH });
    reader.finish();

    const created = await this.setup.createBusiness({
      businessName,
      owner: {
        authUserId: session.identity.subject,
        email: normalizedEmail(session.identity.email),
        fullName: ownerName,
      },
    });
    return {
      userId: created.userId,
      businessId: created.businessId,
      businessName,
      role: 'owner',
      fullName: ownerName,
    };
  }
}
