import { describe, expect, it } from 'vitest';
import {
  ShiftAlreadyOpenError,
  ShiftClosedError,
  ShiftIdReusedError,
  ShiftNotFoundError,
  ShiftRequiredError,
} from '../../../domain/model/shift-errors.js';
import { problemOfDomainError } from './domain-errors.js';

/** Lo que el cliente ve de cada error de turnos: el estado, el codigo estable y una frase en espanol. */
describe('shift errors as API problems (C3-02)', () => {
  it.each([
    [new ShiftNotFoundError(), 404, 'shift-not-found', 'No existe ese turno'],
    [new ShiftAlreadyOpenError(), 409, 'shift-already-open', 'Ya tienes un turno abierto'],
    [
      new ShiftIdReusedError(),
      409,
      'shift-id-reused',
      'Ese identificador de turno ya es de otro turno',
    ],
    [new ShiftClosedError(), 409, 'shift-closed', 'El turno ya está cerrado'],
    [new ShiftRequiredError(), 409, 'shift-required', 'hace falta un turno tuyo que esté abierto'],
  ])('answers %s with %i %s and says it in words', (error, status, code, words) => {
    const problem = problemOfDomainError(error);

    expect(problem?.getStatus()).toBe(status);
    expect(problem?.code).toBe(code);
    expect(problem?.detail).toContain(words);
  });
});
