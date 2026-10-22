import { personStatus } from '../domain/model/user-administration.js';
import type { PersonView } from '../domain/ports/in/business-people.js';
import type { PersonRecord } from '../domain/ports/out/people.js';

/** Lo que se le cuenta a quien administra de una persona: nunca el hash de su invitacion. */
export function toPersonView(person: PersonRecord): PersonView {
  return {
    id: person.id,
    fullName: person.fullName,
    email: person.email,
    role: person.role,
    status: personStatus(person),
    invitationExpiresAt: person.invitationExpiresAt,
    createdAt: person.createdAt,
  };
}
