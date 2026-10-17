import { describe, expect, it } from 'vitest';
import {
  OperationIdReusedError,
  PurchaseNotFoundError,
  SupplierInUseError,
  SupplierNotFoundError,
  WarehouseMissingError,
} from '../../../domain/model/purchase-errors.js';
import { problemOfDomainError } from './domain-errors.js';

/** Lo que el cliente ve de cada error de proveedores y compras: el estado, el codigo estable y una frase en espanol. */
describe('supplier and purchase errors as API problems (C2-06)', () => {
  it.each([
    [new SupplierNotFoundError(), 404, 'supplier-not-found', 'No existe ese proveedor'],
    [new PurchaseNotFoundError(), 404, 'purchase-not-found', 'No existe esa compra'],
    [new SupplierInUseError(), 409, 'supplier-in-use', 'ya tiene compras'],
    [
      new OperationIdReusedError(),
      409,
      'operation-id-reused',
      'Ese identificador de operación ya se usó con otros datos',
    ],
  ])('answers %s with %i %s and says it in words', (error, status, code, words) => {
    const problem = problemOfDomainError(error);

    expect(problem?.getStatus()).toBe(status);
    expect(problem?.code).toBe(code);
    expect(problem?.detail).toContain(words);
  });

  it('does not hide a business without warehouse behind a client error: it is a broken business, a 500 in the log', () => {
    expect(problemOfDomainError(new WarehouseMissingError())).toBeUndefined();
  });
});
