import { normalizeInvitationCode } from '../../domain/model/invitation-code.js';
import { AlreadyMemberError } from '../../domain/model/people-errors.js';
import { InputReader } from '../../domain/model/validation.js';
import type { Session } from '../../domain/ports/in/authenticate.js';
import type { RedeemInvitation } from '../../domain/ports/in/business-people.js';
import type { MembershipView } from '../../domain/ports/in/get-me.js';
import type { Clock } from '../../domain/ports/out/clock.js';
import type { InvitationCodes } from '../../domain/ports/out/invitation-codes.js';
import type { InvitationRedeemer } from '../../domain/ports/out/invitation-redeemer.js';
import { normalizedEmail } from '../session-guards.js';

/** Un codigo escrito a mano cabe de sobra en esto, con guiones y espacios; mas es una pegada equivocada. */
const MAX_TYPED_CODE_LENGTH = 64;

/**
 * Caso de uso: unirse a un negocio con el codigo de una invitacion (ADR 0023). Lo hace quien se registro en el
 * servicio de identidad y aun no pertenece a ninguno; queda con el rol con que lo invitaron.
 */
export class RedeemInvitationUseCase implements RedeemInvitation {
  constructor(
    private readonly redeemer: InvitationRedeemer,
    private readonly codes: InvitationCodes,
    private readonly clock: Clock,
  ) {}

  async execute(session: Session, body: unknown): Promise<MembershipView> {
    if (session.membership !== null) throw new AlreadyMemberError();

    const reader = new InputReader(body, ['code']);
    const typed = reader.text('code', { label: 'El código', max: MAX_TYPED_CODE_LENGTH });
    const code = normalizeInvitationCode(typed);
    if (typed !== '' && code === undefined) {
      reader.fail(
        '/code',
        'invalid-code',
        'El código no tiene la forma de un código de invitación.',
      );
    }
    reader.finish();

    const redeemed = await this.redeemer.redeem({
      invitationHash: this.codes.hash(code as string),
      authUserId: session.identity.subject,
      email: normalizedEmail(session.identity.email),
      now: this.clock.now(),
    });
    return {
      userId: redeemed.userId,
      businessId: redeemed.businessId,
      businessName: redeemed.businessName,
      role: redeemed.role,
      fullName: redeemed.fullName,
    };
  }
}
