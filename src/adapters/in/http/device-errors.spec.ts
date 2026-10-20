import { describe, expect, it } from 'vitest';
import { DeviceIdReusedError, DeviceNotFoundError } from '../../../domain/model/device-errors.js';
import { problemOfDomainError } from './domain-errors.js';

/** Lo que el cliente ve de cada error de dispositivos: el estado, el codigo estable y una frase en espanol. */
describe('device errors as API problems (C3-01)', () => {
  it.each([
    [new DeviceNotFoundError(), 404, 'device-not-found', 'No existe ese dispositivo'],
    [
      new DeviceIdReusedError(),
      409,
      'device-id-reused',
      'Ese identificador de dispositivo ya se registró con otros datos',
    ],
  ])('answers %s with %i %s and says it in words', (error, status, code, words) => {
    const problem = problemOfDomainError(error);

    expect(problem?.getStatus()).toBe(status);
    expect(problem?.code).toBe(code);
    expect(problem?.detail).toContain(words);
  });
});
