import { describe, expect, it } from 'vitest';
import { InputReader, ValidationFailedError, type FieldError } from './validation.js';

/** Lo que dice el lector cuando la entrada no sirve, o `[]` si sirve. */
const errorsOf = (
  work: (reader: InputReader) => void,
  input: unknown,
  allowed: string[],
): readonly FieldError[] => {
  try {
    const reader = new InputReader(input, allowed);
    work(reader);
    reader.finish();
    return [];
  } catch (error) {
    if (error instanceof ValidationFailedError) return error.errors;
    throw error;
  }
};

describe('InputReader', () => {
  describe('the object', () => {
    it.each([null, undefined, 'texto', 42, true, ['a']])('must be an object, not %j', (input) => {
      expect(errorsOf(() => undefined, input, [])).toEqual([
        { pointer: '', code: 'invalid-type', detail: 'La petición debe ser un objeto JSON.' },
      ]);
    });

    it('refuses a field it does not know, naming it, so a typo does not pass silently', () => {
      const errors = errorsOf(() => undefined, { nombre: 'Ana', rol: 'admin' }, ['nombre']);

      expect(errors).toEqual([
        {
          pointer: '/rol',
          code: 'unknown-field',
          detail: 'El campo «rol» no existe en esta petición.',
        },
      ]);
    });

    it('escapes the pointer of an unknown field as RFC 6901 asks (~ and /)', () => {
      const errors = errorsOf(() => undefined, { 'a/b~c': 1 }, []);

      expect(errors[0]?.pointer).toBe('/a~1b~0c');
    });
  });

  describe('text', () => {
    const read = (reader: InputReader) => reader.text('name', { label: 'El nombre', max: 10 });

    it('returns the text without the spaces around it', () => {
      const reader = new InputReader({ name: '  Ana Gómez ' }, ['name']);

      expect(reader.text('name', { label: 'El nombre', max: 20 })).toBe('Ana Gómez');
      expect(() => reader.finish()).not.toThrow();
    });

    it('says a missing field is required', () => {
      expect(errorsOf(read, {}, ['name'])).toEqual([
        { pointer: '/name', code: 'required', detail: 'Falta el nombre.' },
      ]);
    });

    it.each([1, true, null, {}, ['a']])('says %j is not text', (value) => {
      expect(errorsOf(read, { name: value }, ['name'])).toEqual([
        { pointer: '/name', code: 'invalid-type', detail: 'El nombre debe ser un texto.' },
      ]);
    });

    it.each(['', '   ', '\t\n'])('says %j is blank', (value) => {
      expect(errorsOf(read, { name: value }, ['name'])).toEqual([
        { pointer: '/name', code: 'blank', detail: 'El nombre no puede estar en blanco.' },
      ]);
    });

    it('accepts the longest allowed text and refuses one character more', () => {
      expect(errorsOf(read, { name: 'a'.repeat(10) }, ['name'])).toEqual([]);
      expect(errorsOf(read, { name: 'a'.repeat(11) }, ['name'])).toEqual([
        {
          pointer: '/name',
          code: 'too-long',
          detail: 'El nombre no puede pasar de 10 caracteres.',
        },
      ]);
    });

    it('measures the length after trimming, so spaces do not eat the allowance', () => {
      expect(errorsOf(read, { name: `  ${'a'.repeat(10)}  ` }, ['name'])).toEqual([]);
    });

    it('counts characters a person sees, not UTF-16 units: ten emoji are ten', () => {
      expect(errorsOf(read, { name: '😀'.repeat(10) }, ['name'])).toEqual([]);
      expect(errorsOf(read, { name: '😀'.repeat(11) }, ['name'])[0]?.code).toBe('too-long');
    });

    it('reads only what the caller sent: an inherited name such as constructor is a missing field', () => {
      expect(
        errorsOf((r) => r.text('constructor', { label: 'El dato', max: 10 }), {}, ['constructor']),
      ).toEqual([{ pointer: '/constructor', code: 'required', detail: 'Falta el dato.' }]);
    });

    it.each(['a\u0000b', 'a\nb', 'a\u0007b', 'a\u001fb', 'a\u007fb', 'a\u0085b', 'a\u009fb'])(
      'refuses control characters (%j)',
      (value) => {
        expect(errorsOf(read, { name: value }, ['name'])).toEqual([
          {
            pointer: '/name',
            code: 'invalid-characters',
            detail: 'El nombre no puede llevar caracteres de control.',
          },
        ]);
      },
    );

    it('lets an optional field be absent, and says nothing', () => {
      const reader = new InputReader({}, ['name']);

      expect(reader.text('name', { label: 'El nombre', max: 10, optional: true })).toBeUndefined();
      expect(() => reader.finish()).not.toThrow();
    });

    it('still validates an optional field that is present', () => {
      const reader = new InputReader({ name: '' }, ['name']);
      reader.text('name', { label: 'El nombre', max: 10, optional: true });

      expect(() => reader.finish()).toThrow(ValidationFailedError);
    });
  });

  describe('one of a closed set', () => {
    const roles = ['admin', 'cashier'] as const;

    it('returns the value', () => {
      const reader = new InputReader({ role: 'cashier' }, ['role']);

      expect(reader.oneOf('role', roles, { label: 'El rol' })).toBe('cashier');
    });

    it.each(['owner', 'Admin', '', 7, null])('refuses %j and lists what is allowed', (value) => {
      const reader = new InputReader({ role: value }, ['role']);
      reader.oneOf('role', roles, { label: 'El rol' });

      try {
        reader.finish();
        expect.unreachable();
      } catch (error) {
        expect((error as ValidationFailedError).errors).toEqual([
          {
            pointer: '/role',
            code: 'invalid-value',
            detail: 'El rol debe ser uno de: admin, cashier.',
          },
        ]);
      }
    });

    it('lets an optional one be absent, and still checks it when it is there', () => {
      const absent = new InputReader({}, ['role']);
      expect(absent.oneOf('role', roles, { label: 'El rol', optional: true })).toBeUndefined();
      expect(() => absent.finish()).not.toThrow();

      const wrong = new InputReader({ role: 'owner' }, ['role']);
      wrong.oneOf('role', roles, { label: 'El rol', optional: true });
      expect(() => wrong.finish()).toThrow(ValidationFailedError);
    });

    it('says a missing one is required', () => {
      expect(errorsOf((r) => r.oneOf('role', roles, { label: 'El rol' }), {}, ['role'])).toEqual([
        { pointer: '/role', code: 'required', detail: 'Falta el rol.' },
      ]);
    });

    it('does not accept an inherited property name such as constructor', () => {
      const errors = errorsOf(
        (r) => r.oneOf('role', roles, { label: 'El rol' }),
        { role: 'constructor' },
        ['role'],
      );

      expect(errors[0]?.code).toBe('invalid-value');
    });
  });

  describe('boolean', () => {
    it('returns true and false', () => {
      expect(
        new InputReader({ active: false }, ['active']).boolean('active', { label: 'Activa' }),
      ).toBe(false);
      expect(
        new InputReader({ active: true }, ['active']).boolean('active', { label: 'Activa' }),
      ).toBe(true);
    });

    it('lets an optional one be absent, and still checks it when it is there', () => {
      const absent = new InputReader({}, ['active']);
      expect(absent.boolean('active', { label: 'Activa', optional: true })).toBeUndefined();
      expect(() => absent.finish()).not.toThrow();

      const wrong = new InputReader({ active: 'si' }, ['active']);
      wrong.boolean('active', { label: 'Activa', optional: true });
      expect(() => wrong.finish()).toThrow(ValidationFailedError);
    });

    it.each(['true', 1, 0, null])('refuses %j, which is not a boolean', (value) => {
      expect(
        errorsOf((r) => r.boolean('active', { label: 'Activa' }), { active: value }, ['active']),
      ).toEqual([
        { pointer: '/active', code: 'invalid-type', detail: 'Activa debe ser verdadero o falso.' },
      ]);
    });
  });

  describe('email', () => {
    const read = (r: InputReader) => r.email('email', { label: 'El correo', optional: true });

    it('returns it trimmed and in lower case, because the two spellings are the same person', () => {
      const reader = new InputReader({ email: '  Ana.Gomez@Ejemplo.CO ' }, ['email']);

      expect(reader.email('email', { label: 'El correo', optional: true })).toBe(
        'ana.gomez@ejemplo.co',
      );
    });

    it('lets an optional one be absent', () => {
      expect(read(new InputReader({}, ['email']))).toBeUndefined();
      expect(errorsOf(read, {}, ['email'])).toEqual([]);
    });

    it.each([
      'ana',
      'ana@',
      '@ejemplo.co',
      'ana@ejemplo',
      'ana gomez@ejemplo.co',
      'a@b@c.co',
      'ana@.co',
      'ana@ejemplo.',
    ])('refuses %j, which is not an address', (value) => {
      expect(errorsOf(read, { email: value }, ['email'])).toEqual([
        {
          pointer: '/email',
          code: 'invalid-email',
          detail: 'El correo no parece una dirección de correo.',
        },
      ]);
    });

    it('accepts the longest address the database allows and refuses one more character', () => {
      const local = 'a'.repeat(64);
      const domain = `${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(58)}.co`;
      const longest = `${local}@${domain}`;
      expect(longest.length).toBe(254);

      expect(errorsOf(read, { email: longest }, ['email'])).toEqual([]);
      expect(errorsOf(read, { email: `a${longest}` }, ['email'])[0]).toMatchObject({
        code: 'too-long',
        detail: 'El correo no puede pasar de 254 caracteres.',
      });
    });

    it('says a required one is missing', () => {
      expect(errorsOf((r) => r.email('email', { label: 'El correo' }), {}, ['email'])).toEqual([
        { pointer: '/email', code: 'required', detail: 'Falta el correo.' },
      ]);
    });

    it('says a non-text value is not text', () => {
      expect(errorsOf(read, { email: 5 }, ['email'])[0]).toMatchObject({ code: 'invalid-type' });
    });
  });

  describe('integers', () => {
    const read = (r: InputReader) => r.integer('limit', { label: 'El límite', min: 1, max: 200 });

    it('accepts a whole number inside the range, with its edges', () => {
      for (const value of [1, 50, 200]) {
        expect(errorsOf(read, { limit: value }, ['limit'])).toEqual([]);
      }
    });

    it.each([0, 201, -5])('refuses %j, outside the range', (value) => {
      expect(errorsOf(read, { limit: value }, ['limit'])[0]).toMatchObject({
        pointer: '/limit',
        code: 'out-of-range',
        detail: 'El límite debe estar entre 1 y 200.',
      });
    });

    it.each([1.5, '3', NaN, Infinity])('refuses %j, which is not a whole number', (value) => {
      expect(errorsOf(read, { limit: value }, ['limit'])[0]).toMatchObject({
        code: 'invalid-type',
      });
    });
  });

  it('reports every problem at once, not only the first, so a form can show them all', () => {
    const errors = errorsOf(
      (r) => {
        r.text('name', { label: 'El nombre', max: 10 });
        r.oneOf('role', ['admin', 'cashier'] as const, { label: 'El rol' });
      },
      { extra: 1 },
      ['name', 'role'],
    );

    expect(errors.map((e) => `${e.pointer}:${e.code}`)).toEqual([
      '/extra:unknown-field',
      '/name:required',
      '/role:required',
    ]);
  });

  describe('raw', () => {
    it('hands back what was sent, untouched, for a reader of its own', () => {
      const reader = new InputReader({ limit: ' 7 ' }, ['limit']);

      expect(reader.raw('limit')).toBe(' 7 ');
      expect(reader.raw('cursor')).toBeUndefined();
    });

    it('hands back nothing for an inherited name or when the input was not an object', () => {
      expect(new InputReader({}, []).raw('constructor')).toBeUndefined();
      expect(new InputReader('texto', []).raw('length')).toBeUndefined();
    });
  });

  it('lets the caller add its own error before finishing', () => {
    const reader = new InputReader({ a: 1 }, ['a']);
    reader.fail('/a', 'inconsistent', 'No cuadra con lo demás.');

    expect(() => reader.finish()).toThrow(ValidationFailedError);
  });
});
