import type { Denial } from './authorization.js';

/** La persona ya trabaja en un negocio: una persona pertenece a uno solo (ADR 0021). */
export class AlreadyMemberError extends Error {
  constructor() {
    super('The person already belongs to a business');
    this.name = 'AlreadyMemberError';
  }
}

/** La persona aun no tiene negocio: debe crear uno o canjear una invitacion antes de seguir. */
export class NoMembershipError extends Error {
  constructor() {
    super('The person does not belong to any business yet');
    this.name = 'NoMembershipError';
  }
}

/** El rol de la persona no le permite hacer esto. El motivo es para quien lee el registro, no para el cliente. */
export class ForbiddenError extends Error {
  constructor(readonly reason: Denial) {
    super(`The action is not allowed: ${reason}`);
    this.name = 'ForbiddenError';
  }
}

/** No existe esa persona en este negocio (o es de otro: el cliente no distingue ambos casos). */
export class PersonNotFoundError extends Error {
  constructor() {
    super('There is no such person in this business');
    this.name = 'PersonNotFoundError';
  }
}

/** El cambio dejaria al negocio sin ningun dueno activo (ADR 0017). */
export class LastOwnerError extends Error {
  constructor() {
    super('The change would leave the business without an active owner');
    this.name = 'LastOwnerError';
  }
}

/** Ninguna invitacion pendiente tiene ese codigo: nunca existio, ya se uso o se dio de baja. Mismo mensaje para todo. */
export class InvitationNotFoundError extends Error {
  constructor() {
    super('There is no pending invitation with that code');
    this.name = 'InvitationNotFoundError';
  }
}

/** El codigo existe pero ya vencio: hay que pedir uno nuevo a quien invito. */
export class InvitationExpiredError extends Error {
  constructor() {
    super('The invitation expired');
    this.name = 'InvitationExpiredError';
  }
}

/** Solo se renueva una invitacion pendiente de alguien dado de alta: o ya canjeo la suya o esta dado de baja. */
export class InvitationNotPendingError extends Error {
  constructor() {
    super('The person has no pending invitation to renew');
    this.name = 'InvitationNotPendingError';
  }
}
