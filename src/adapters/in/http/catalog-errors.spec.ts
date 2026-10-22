import { describe, expect, it } from 'vitest';
import {
  BarcodeTakenError,
  CategoryInUseError,
  CategoryNameTakenError,
  CategoryNotFoundError,
  ProductNotFoundError,
  SkuTakenError,
  UnitLockedError,
} from '../../../domain/model/catalog-errors.js';
import { problemOfDomainError } from './domain-errors.js';

/** Lo que el cliente ve de cada error del catalogo: el estado, el codigo estable y una frase en espanol. */
describe('catalog errors as API problems (ADR 0015)', () => {
  it.each([
    [new CategoryNotFoundError(), 404, 'category-not-found', 'No existe esa categoría'],
    [new ProductNotFoundError(), 404, 'product-not-found', 'No existe ese producto'],
    [
      new CategoryNameTakenError(),
      409,
      'category-name-taken',
      'Ya hay una categoría con ese nombre',
    ],
    [new CategoryInUseError(), 409, 'category-in-use', 'todavía tiene productos'],
    [new SkuTakenError(), 409, 'sku-taken', 'Ya hay un producto con ese SKU'],
    [new BarcodeTakenError(), 409, 'barcode-taken', 'Ya hay un producto con ese código de barras'],
    [new UnitLockedError(), 409, 'unit-locked', 'ya tiene movimientos'],
  ])('answers %s with %i %s and says it in words', (error, status, code, words) => {
    const problem = problemOfDomainError(error);

    expect(problem?.getStatus()).toBe(status);
    expect(problem?.code).toBe(code);
    expect(problem?.detail).toContain(words);
  });
});
