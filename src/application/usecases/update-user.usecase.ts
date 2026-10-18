import { LastOwnerError, PersonNotFoundError } from '../../domain/model/people-errors.js';
import { ROLES } from '../../domain/model/role.js';
import {
  canChangePerson,
  canInvite,
  wouldLeaveNoOwner,
  type PersonChange,
} from '../../domain/model/user-administration.js';
import { isUuid } from '../../domain/model/uuid.js';
import { InputReader } from '../../domain/model/validation.js';
import type { Session } from '../../domain/ports/in/authenticate.js';
import type { PersonView, UpdateUser } from '../../domain/ports/in/business-people.js';
import type { UnitOfWork } from '../../domain/ports/out/unit-of-work.js';
import { toPersonView } from '../person-view.js';
import { ensureAllowed, requireMember } from '../session-guards.js';

const MAX_NAME_LENGTH = 120;

/**
 * Caso de uso: cambiar el rol, el nombre o el alta de una persona. Al cajero lo administra la gerencia; a un
 * administrador o a un dueno, solo el dueno (ADR 0017). Nunca deja al negocio sin un dueno activo.
 */
export class UpdateUserUseCase implements UpdateUser {
  constructor(private readonly work: UnitOfWork) {}

  async execute(session: Session, userId: string, body: unknown): Promise<PersonView> {
    const actor = requireMember(session);
    ensureAllowed(canInvite(actor, 'cashier'));

    const reader = new InputReader(body, ['fullName', 'role', 'active']);
    const fullName = reader.text('fullName', {
      label: 'El nombre',
      max: MAX_NAME_LENGTH,
      optional: true,
    });
    const role = reader.oneOf('role', ROLES, { label: 'El rol', optional: true });
    const active = reader.boolean('active', { label: 'El alta', optional: true });
    if (fullName === undefined && role === undefined && active === undefined) {
      reader.fail('', 'empty-change', 'Indica al menos un dato para cambiar.');
    }
    reader.finish();
    const change: PersonChange = {
      ...(fullName !== undefined ? { fullName } : {}),
      ...(role !== undefined ? { role } : {}),
      ...(active !== undefined ? { active } : {}),
    };

    // Un identificador que no es un UUID no es de nadie: no se le pregunta nada a la base.
    if (!isUuid(userId)) throw new PersonNotFoundError();

    const updated = await this.work.inBusiness(actor.businessId, async (scope) => {
      // Los duenos se cuentan bajo candado ANTES de mirar a la persona: dos cambios a la vez sobre los ultimos duenos
      // se turnan, y el segundo ve lo que dejo el primero.
      const owners = await scope.people.lockActiveOwners();
      const target = await scope.people.find(userId);
      if (target === null) throw new PersonNotFoundError();
      ensureAllowed(canChangePerson(actor, target, change));
      if (wouldLeaveNoOwner(target, change, owners.length)) throw new LastOwnerError();
      return scope.people.update(userId, change);
    });
    return toPersonView(updated);
  }
}
