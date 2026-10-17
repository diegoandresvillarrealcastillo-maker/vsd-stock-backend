import { formatInvitationCode } from '../../domain/model/invitation-code.js';
import { InputReader } from '../../domain/model/validation.js';
import { INVITABLE_ROLES, canInvite } from '../../domain/model/user-administration.js';
import type { Session } from '../../domain/ports/in/authenticate.js';
import type { InvitationView, InviteUser } from '../../domain/ports/in/business-people.js';
import type { Clock } from '../../domain/ports/out/clock.js';
import type { InvitationCodes } from '../../domain/ports/out/invitation-codes.js';
import type { UnitOfWork } from '../../domain/ports/out/unit-of-work.js';
import { toPersonView } from '../person-view.js';
import { ensureAllowed, requireMember } from '../session-guards.js';

/** Cuanto vale el codigo de una invitacion (ADR 0023). */
export const INVITATION_VALID_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_NAME_LENGTH = 120;

/**
 * Caso de uso: invitar a alguien al negocio de quien llama. Crea la fila de la persona como invitacion pendiente y
 * entrega el codigo UNA vez; de ahi en adelante solo se guarda su hash (ADR 0023).
 */
export class InviteUserUseCase implements InviteUser {
  constructor(
    private readonly work: UnitOfWork,
    private readonly codes: InvitationCodes,
    private readonly clock: Clock,
  ) {}

  async execute(session: Session, body: unknown): Promise<InvitationView> {
    const actor = requireMember(session);
    // Quien no puede invitar ni a un cajero no invita a nadie: se le dice antes de revisar lo que mando.
    ensureAllowed(canInvite(actor, 'cashier'));

    const reader = new InputReader(body, ['fullName', 'role', 'email']);
    const fullName = reader.text('fullName', { label: 'El nombre', max: MAX_NAME_LENGTH });
    const role = reader.oneOf('role', INVITABLE_ROLES, { label: 'El rol' });
    const email = reader.email('email', { label: 'El correo', optional: true });
    reader.finish();
    ensureAllowed(canInvite(actor, role));

    const invitation = this.codes.generate();
    const expiresAt = new Date(this.clock.now().getTime() + INVITATION_VALID_DAYS * DAY_MS);
    const person = await this.work.inBusiness(actor.businessId, (scope) =>
      scope.people.invite({
        fullName,
        email: email ?? null,
        role,
        invitationHash: invitation.hash,
        invitationExpiresAt: expiresAt,
      }),
    );
    return {
      person: toPersonView(person),
      invitation: { code: formatInvitationCode(invitation.code), expiresAt },
    };
  }
}
