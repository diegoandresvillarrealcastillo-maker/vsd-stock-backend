import { formatInvitationCode } from '../../domain/model/invitation-code.js';
import {
  InvitationNotPendingError,
  PersonNotFoundError,
} from '../../domain/model/people-errors.js';
import { canChangePerson } from '../../domain/model/user-administration.js';
import { isUuid } from '../../domain/model/uuid.js';
import type { Session } from '../../domain/ports/in/authenticate.js';
import type {
  InvitationView,
  RegenerateInvitation,
} from '../../domain/ports/in/business-people.js';
import type { Clock } from '../../domain/ports/out/clock.js';
import type { InvitationCodes } from '../../domain/ports/out/invitation-codes.js';
import type { UnitOfWork } from '../../domain/ports/out/unit-of-work.js';
import { toPersonView } from '../person-view.js';
import { ensureAllowed, requireMember } from '../session-guards.js';
import { INVITATION_VALID_DAYS } from './invite-user.usecase.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Caso de uso: dar un codigo nuevo a una invitacion pendiente (se perdio o vencio). El codigo anterior deja de
 * servir. Hace falta poder administrar a alguien con el rol de la persona invitada (ADR 0017).
 */
export class RegenerateInvitationUseCase implements RegenerateInvitation {
  constructor(
    private readonly work: UnitOfWork,
    private readonly codes: InvitationCodes,
    private readonly clock: Clock,
  ) {}

  async execute(session: Session, userId: string): Promise<InvitationView> {
    const actor = requireMember(session);
    // Un identificador que no es un UUID no es de nadie: no se le pregunta nada a la base.
    if (!isUuid(userId)) throw new PersonNotFoundError();

    const invitation = this.codes.generate();
    const expiresAt = new Date(this.clock.now().getTime() + INVITATION_VALID_DAYS * DAY_MS);
    const renewed = await this.work.inBusiness(actor.businessId, async (scope) => {
      const target = await scope.people.find(userId);
      if (target === null) throw new PersonNotFoundError();
      ensureAllowed(canChangePerson(actor, target, {}));
      if (target.bound || !target.active) throw new InvitationNotPendingError();
      const rotated = await scope.people.rotateInvitation(userId, invitation.hash, expiresAt);
      // Entre leerla y renovarla alguien la canjeo o la dio de baja.
      if (rotated === null) throw new InvitationNotPendingError();
      return rotated;
    });
    return {
      person: toPersonView(renewed),
      invitation: { code: formatInvitationCode(invitation.code), expiresAt },
    };
  }
}
