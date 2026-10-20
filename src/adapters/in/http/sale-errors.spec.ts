import { describe, expect, it } from 'vitest';
import { SaleNotFoundError, SaleVoidedError } from '../../../domain/model/sale-errors.js';
import { problemOfDomainError } from './domain-errors.js';

/** Lo que el cliente ve de cada error de ventas: el estado, el codigo estable y una frase en espanol. */
describe('sale errors as API problems (C3-04)', () => {
  it('answers a sale that does not exist, or that the person can not see, with 404 sale-not-found', () => {
    const problem = problemOfDomainError(new SaleNotFoundError());

    expect(problem?.getStatus()).toBe(404);
    expect(problem?.code).toBe('sale-not-found');
    expect(problem?.detail).toContain('No existe esa venta');
  });

  it('answers a sale that is already voided with 409 sale-voided', () => {
    const problem = problemOfDomainError(new SaleVoidedError());

    expect(problem?.getStatus()).toBe(409);
    expect(problem?.code).toBe('sale-voided');
    expect(problem?.detail).toContain('ya está anulada');
  });
});
