import { describe, expect, it } from 'vitest';
import {
  AlreadyMemberError,
  ForbiddenError,
  InvitationExpiredError,
  InvitationNotFoundError,
  InvitationNotPendingError,
  LastOwnerError,
  NoMembershipError,
  PersonNotFoundError,
} from '../../../domain/model/people-errors.js';
import { ValidationFailedError } from '../../../domain/model/validation.js';
import { problemOfDomainError } from './domain-errors.js';
import { buildProblem } from './problem-details.js';

/** Lo que el cliente ve de cada error de negocio y personas: el estado, el codigo estable y una frase en espanol. */
describe('people and business errors as API problems (ADR 0023)', () => {
  it.each([
    [new AlreadyMemberError(), 409, 'already-member', 'ya trabaja en un negocio'],
    [
      new NoMembershipError(),
      403,
      'no-membership',
      'Primero crea un negocio o canjea una invitación',
    ],
    [new ForbiddenError('role'), 403, 'forbidden', 'Tu rol no permite hacer esto'],
    [new PersonNotFoundError(), 404, 'person-not-found', 'No existe esa persona'],
    [new LastOwnerError(), 409, 'last-owner', 'sin un dueño activo'],
    [
      new InvitationNotFoundError(),
      404,
      'invitation-not-found',
      'No hay una invitación pendiente con ese código',
    ],
    [new InvitationExpiredError(), 410, 'invitation-expired', 'La invitación venció'],
    [
      new InvitationNotPendingError(),
      409,
      'invitation-not-pending',
      'no tiene una invitación pendiente',
    ],
  ])('answers %s with %i %s and says it in words', (error, status, code, words) => {
    const problem = problemOfDomainError(error);

    expect(problem?.getStatus()).toBe(status);
    expect(problem?.code).toBe(code);
    expect(problem?.detail).toContain(words);
  });

  it('never tells the client why a role was refused: the reason is for the log', () => {
    const detail = (
      reason: 'role' | 'inactive' | 'other-business' | 'unknown-action' | 'needs-connection',
    ) => problemOfDomainError(new ForbiddenError(reason))?.detail;

    expect(
      new Set(
        ['role', 'inactive', 'other-business', 'unknown-action', 'needs-connection'].map((r) =>
          detail(r as 'role'),
        ),
      ).size,
    ).toBe(1);
  });

  it('answers a request with invalid data with 400 and every field that failed', () => {
    const errors = [
      { pointer: '/fullName', code: 'blank', detail: 'El nombre no puede estar en blanco.' },
      {
        pointer: '/role',
        code: 'invalid-value',
        detail: 'El rol debe ser uno de: admin, cashier.',
      },
    ];

    const problem = problemOfDomainError(new ValidationFailedError(errors));

    expect(problem?.getStatus()).toBe(400);
    expect(problem?.code).toBe('validation-failed');
    expect(problem?.extras.errors).toEqual(errors);
    expect(problem?.detail).toContain('datos que no sirven');
  });

  it('gives a 410 a title of its own instead of the generic client error', () => {
    const body = buildProblem({
      status: 410,
      code: 'invitation-expired',
      instance: '/v1/x',
      traceId: 't',
    });

    expect(body.title).toBe('Ya no está disponible');
  });
});
