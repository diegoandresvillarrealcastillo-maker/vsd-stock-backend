import { canInvite } from '../../domain/model/user-administration.js';
import { pageOf, readPageRequest, type Page } from '../../domain/model/pagination.js';
import { InputReader } from '../../domain/model/validation.js';
import type { Session } from '../../domain/ports/in/authenticate.js';
import type { ListUsers, PersonView } from '../../domain/ports/in/business-people.js';
import type { UnitOfWork } from '../../domain/ports/out/unit-of-work.js';
import { toPersonView } from '../person-view.js';
import { ensureAllowed, requireMember } from '../session-guards.js';

/**
 * Caso de uso: las personas del negocio, por nombre. Quien puede invitar a un cajero (la gerencia) puede verlas
 * (ADR 0017). Pagina por cursor: la posicion es (nombre, id), que no cambia cuando alguien se suma o se va.
 */
export class ListUsersUseCase implements ListUsers {
  constructor(private readonly work: UnitOfWork) {}

  async execute(session: Session, query: unknown): Promise<Page<PersonView>> {
    const actor = requireMember(session);
    ensureAllowed(canInvite(actor, 'cashier'));

    const reader = new InputReader(query, ['limit', 'cursor']);
    const request = readPageRequest(reader, 2);
    reader.finish();

    const [afterName, afterId] = request.after ?? [];
    const rows = await this.work.inBusiness(actor.businessId, (scope) =>
      scope.people.list({
        // Una de mas: si llega, hay otra pagina.
        limit: request.limit + 1,
        ...(afterName !== undefined && afterId !== undefined
          ? { after: [afterName, afterId] as const }
          : {}),
      }),
    );
    return pageOf(rows.map(toPersonView), request.limit, (person) => [person.fullName, person.id]);
  }
}
