import { describe, expect, it } from 'vitest';
import {
  NEW_SUPPLIER_FIELDS,
  SUPPLIER_CHANGE_FIELDS,
  readNewSupplier,
  readSupplierChange,
} from './supplier-input.js';
import { InputReader, ValidationFailedError, type FieldError } from './validation.js';

const run = <T>(work: (reader: InputReader) => T, body: unknown, fields: readonly string[]): T => {
  const reader = new InputReader(body, fields);
  const value = work(reader);
  reader.finish();
  return value;
};
const created = (body: unknown) => run(readNewSupplier, body, NEW_SUPPLIER_FIELDS);
const changed = (body: unknown) => run(readSupplierChange, body, SUPPLIER_CHANGE_FIELDS);

const errorsOf = (work: (body: unknown) => unknown, body: unknown): readonly FieldError[] => {
  try {
    work(body);
    return [];
  } catch (error) {
    if (error instanceof ValidationFailedError) return error.errors;
    throw error;
  }
};

describe('a new supplier', () => {
  it('needs a name; the contact is optional', () => {
    expect(created({ name: 'Distribuidora El Sol' })).toEqual({
      name: 'Distribuidora El Sol',
      contact: null,
    });
    expect(created({ name: '  Lácteos  ', contact: ' 300 123 4567 ' })).toEqual({
      name: 'Lácteos',
      contact: '300 123 4567',
    });
  });

  it('reads null as no contact', () => {
    expect(created({ name: 'A', contact: null }).contact).toBeNull();
  });

  it('accepts a name of 120 characters and refuses one of 121', () => {
    expect(created({ name: 'n'.repeat(120) }).name).toHaveLength(120);
    expect(errorsOf(created, { name: 'n'.repeat(121) })).toEqual([
      { pointer: '/name', code: 'too-long', detail: 'El nombre no puede pasar de 120 caracteres.' },
    ]);
  });

  it('accepts a contact of 200 characters and refuses one of 201', () => {
    expect(created({ name: 'A', contact: 'c'.repeat(200) }).contact).toHaveLength(200);
    expect(errorsOf(created, { name: 'A', contact: 'c'.repeat(201) })).toEqual([
      {
        pointer: '/contact',
        code: 'too-long',
        detail: 'El contacto no puede pasar de 200 caracteres.',
      },
    ]);
  });

  it('says what is missing or blank, every field at once', () => {
    expect(errorsOf(created, {}).map((e) => `${e.pointer}:${e.code}`)).toEqual(['/name:required']);
    expect(
      errorsOf(created, { name: ' ', contact: '' }).map((e) => `${e.pointer}:${e.code}`),
    ).toEqual(['/name:blank', '/contact:blank']);
  });

  it('refuses a field it does not know', () => {
    expect(errorsOf(created, { name: 'A', phone: 1 })[0]).toMatchObject({
      pointer: '/phone',
      code: 'unknown-field',
    });
  });
});

describe('a change to a supplier', () => {
  it('changes only what was sent', () => {
    expect(changed({ name: 'Nuevo' })).toEqual({ name: 'Nuevo' });
    expect(changed({ contact: 'otro' })).toEqual({ contact: 'otro' });
  });

  it('clears the contact with null', () => {
    expect(changed({ contact: null })).toEqual({ contact: null });
  });

  it('asks for at least one change', () => {
    expect(errorsOf(changed, {})).toEqual([
      { pointer: '', code: 'empty-change', detail: 'Indica al menos un dato para cambiar.' },
    ]);
  });

  it('does not take null for the name', () => {
    expect(errorsOf(changed, { name: null })[0]).toMatchObject({
      pointer: '/name',
      code: 'invalid-type',
    });
  });
});
