import { describe, expect, it } from 'vitest';
import { NEW_DEVICE_FIELDS, readNewDevice } from './device-input.js';
import { InputReader, ValidationFailedError, type FieldError } from './validation.js';

const ID = '3f6c2d1e-8a4b-4c7d-9e1f-5a2b3c4d5e6f';

const read = (body: unknown) => {
  const reader = new InputReader(body, NEW_DEVICE_FIELDS);
  const value = readNewDevice(reader);
  reader.finish();
  return value;
};

const errorsOf = (body: unknown): readonly FieldError[] => {
  try {
    read(body);
    return [];
  } catch (error) {
    if (error instanceof ValidationFailedError) return error.errors;
    throw error;
  }
};

describe('a new device', () => {
  it('needs the id the device made up for itself; the name is optional', () => {
    expect(read({ id: ID })).toEqual({ id: ID, name: null });
    expect(read({ id: ID, name: '  Caja del frente ' })).toEqual({
      id: ID,
      name: 'Caja del frente',
    });
  });

  it('reads null as no name', () => {
    expect(read({ id: ID, name: null }).name).toBeNull();
  });

  it('writes the id in lowercase, however it came', () => {
    expect(read({ id: ID.toUpperCase() }).id).toBe(ID);
  });

  it('accepts a name of 80 characters and refuses one of 81', () => {
    expect(read({ id: ID, name: 'n'.repeat(80) }).name).toHaveLength(80);
    expect(errorsOf({ id: ID, name: 'n'.repeat(81) })).toEqual([
      { pointer: '/name', code: 'too-long', detail: 'El nombre no puede pasar de 80 caracteres.' },
    ]);
  });

  it('refuses a missing id, an id that is not a UUID and a blank name', () => {
    expect(errorsOf({}).map((e) => `${e.pointer}:${e.code}`)).toEqual(['/id:required']);
    expect(errorsOf({ id: 'caja-1' }).map((e) => `${e.pointer}:${e.code}`)).toEqual([
      '/id:invalid-id',
    ]);
    expect(errorsOf({ id: ID, name: '   ' }).map((e) => `${e.pointer}:${e.code}`)).toEqual([
      '/name:blank',
    ]);
  });

  it('refuses a field that is not part of a device', () => {
    expect(errorsOf({ id: ID, code: 'AA' }).map((e) => `${e.pointer}:${e.code}`)).toEqual([
      '/code:unknown-field',
    ]);
  });
});
