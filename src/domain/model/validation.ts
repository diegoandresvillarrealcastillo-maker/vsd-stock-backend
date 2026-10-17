import { isUuid } from './uuid.js';

/** Un dato de la peticion que no sirve: donde esta (puntero JSON), que le pasa (codigo estable) y como decirlo. */
export interface FieldError {
  readonly pointer: string;
  readonly code: string;
  readonly detail: string;
}

/** La peticion trae datos que no sirven. Lleva TODOS los problemas juntos para que un formulario los muestre a la vez. */
export class ValidationFailedError extends Error {
  constructor(readonly errors: readonly FieldError[]) {
    super('The request carries data that cannot be used');
    this.name = 'ValidationFailedError';
  }
}

interface Labelled {
  /** Como se llama el dato en las frases, con su articulo: «El nombre». */
  readonly label: string;
}

export interface TextOptions extends Labelled {
  readonly max: number;
  readonly optional?: boolean;
}

export interface IntegerOptions extends Labelled {
  readonly min: number;
  readonly max: number;
}

/** Un caracter de control (C0, DEL y C1) no tiene lugar en un nombre ni en un texto de una linea. */
const hasControlCharacter = (text: string): boolean => {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
};

/** Un UUID escrito mide treinta y seis caracteres. */
const UUID_TEXT_LENGTH = 36;

/** Lo que la base acepta en `app_user.email`. */
const MAX_EMAIL_LENGTH = 254;

/** Una forma minima: algo, una arroba, y un dominio con al menos un punto en medio. Quien confirma el correo es el servicio de identidad. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/** «El nombre» pasa a «el nombre» para seguir a una palabra, sin tocar siglas como «El SKU». */
const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);

/** RFC 6901: `~` y `/` no pueden ir tal cual dentro de un segmento del puntero. */
const escapePointer = (segment: string): string =>
  segment.replaceAll('~', '~0').replaceAll('/', '~1');

/**
 * Lee un cuerpo JSON campo por campo y junta todos los problemas, en vez de parar en el primero.
 *
 * Cada metodo devuelve el valor ya limpio. Si el campo no sirve, anota el error y devuelve un valor de relleno: el
 * llamador lee todo, llama a `finish()` (que lanza si hubo errores) y solo entonces usa lo leido.
 */
export class InputReader {
  private readonly source: Readonly<Record<string, unknown>> | undefined;
  private readonly errors: FieldError[];
  /** El puntero del objeto que se lee dentro del cuerpo: vacio para el cuerpo mismo, `/lines/0` para una linea. */
  private readonly prefix: string;

  constructor(
    input: unknown,
    allowed: readonly string[],
    scope: { readonly prefix: string; readonly errors: FieldError[] } = { prefix: '', errors: [] },
  ) {
    this.prefix = scope.prefix;
    this.errors = scope.errors;
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      this.fail('', 'invalid-type', 'La petición debe ser un objeto JSON.');
      return;
    }
    this.source = input as Record<string, unknown>;
    for (const key of Object.keys(this.source)) {
      if (!allowed.includes(key)) {
        this.fail(
          `/${escapePointer(key)}`,
          'unknown-field',
          `El campo «${key}» no existe en esta petición.`,
        );
      }
    }
  }

  text(key: string, options: TextOptions & { readonly optional: true }): string | undefined;
  text(key: string, options: TextOptions): string;
  text(key: string, options: TextOptions): string | undefined {
    const raw = this.raw(key);
    if (raw === undefined)
      return this.missing(key, options, options.optional === true) ? undefined : '';
    if (typeof raw !== 'string')
      return this.reject(key, 'invalid-type', `${options.label} debe ser un texto.`, '');
    const text = raw.trim();
    if (text === '')
      return this.reject(key, 'blank', `${options.label} no puede estar en blanco.`, '');
    if (hasControlCharacter(text)) {
      return this.reject(
        key,
        'invalid-characters',
        `${options.label} no puede llevar caracteres de control.`,
        '',
      );
    }
    if ([...text].length > options.max) {
      return this.reject(
        key,
        'too-long',
        `${options.label} no puede pasar de ${options.max} caracteres.`,
        '',
      );
    }
    return text;
  }

  /** Un correo: sin espacios alrededor y en minusculas, porque las dos escrituras son la misma persona. */
  email(key: string, options: Labelled & { readonly optional: true }): string | undefined;
  email(key: string, options: Labelled): string;
  email(key: string, options: Labelled & { readonly optional?: boolean }): string | undefined {
    const before = this.errors.length;
    const text = this.text(key, { label: options.label, max: MAX_EMAIL_LENGTH, optional: true });
    if (text === undefined) {
      return this.missing(key, options, options.optional === true) ? undefined : '';
    }
    if (this.errors.length > before) return '';
    if (!EMAIL_SHAPE.test(text)) {
      return this.reject(
        key,
        'invalid-email',
        `${options.label} no parece una dirección de correo.`,
        '',
      );
    }
    return text.toLowerCase();
  }

  oneOf<const T extends readonly [string, ...string[]]>(
    key: string,
    allowed: T,
    options: Labelled & { readonly optional: true },
  ): T[number] | undefined;
  oneOf<const T extends readonly [string, ...string[]]>(
    key: string,
    allowed: T,
    options: Labelled,
  ): T[number];
  oneOf<const T extends readonly [string, ...string[]]>(
    key: string,
    allowed: T,
    options: Labelled & { readonly optional?: boolean },
  ): T[number] | undefined {
    const raw = this.raw(key);
    if (raw === undefined) {
      return this.missing(key, options, options.optional === true) ? undefined : allowed[0];
    }
    if (typeof raw !== 'string' || !(allowed as readonly string[]).includes(raw)) {
      return this.reject(
        key,
        'invalid-value',
        `${options.label} debe ser uno de: ${allowed.join(', ')}.`,
        allowed[0],
      );
    }
    return raw;
  }

  boolean(key: string, options: Labelled & { readonly optional: true }): boolean | undefined;
  boolean(key: string, options: Labelled): boolean;
  boolean(key: string, options: Labelled & { readonly optional?: boolean }): boolean | undefined {
    const raw = this.raw(key);
    if (raw === undefined) {
      return this.missing(key, options, options.optional === true) ? undefined : false;
    }
    if (typeof raw !== 'boolean') {
      return this.reject(
        key,
        'invalid-type',
        `${options.label} debe ser verdadero o falso.`,
        false,
      );
    }
    return raw;
  }

  integer(key: string, options: IntegerOptions): number {
    const raw = this.raw(key);
    if (raw === undefined) {
      this.missing(key, options, false);
      return options.min;
    }
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) {
      return this.reject(
        key,
        'invalid-type',
        `${options.label} debe ser un número entero.`,
        options.min,
      );
    }
    if (raw < options.min || raw > options.max) {
      return this.reject(
        key,
        'out-of-range',
        `${options.label} debe estar entre ${options.min} y ${options.max}.`,
        options.min,
      );
    }
    return raw;
  }

  /** Un identificador (UUID) escrito como texto. */
  uuid(key: string, options: Labelled & { readonly optional: true }): string | undefined;
  uuid(key: string, options: Labelled): string;
  uuid(key: string, options: Labelled & { readonly optional?: boolean }): string | undefined {
    const before = this.errors.length;
    const text = this.text(key, { label: options.label, max: UUID_TEXT_LENGTH, optional: true });
    if (text === undefined) {
      return this.missing(key, options, options.optional === true) ? undefined : '';
    }
    if (this.errors.length > before) return '';
    if (!isUuid(text)) {
      return this.reject(
        key,
        'invalid-id',
        `${options.label} no tiene la forma de un identificador.`,
        '',
      );
    }
    return text;
  }

  /** Los elementos de una lista, tal cual llegaron, para leer cada uno con `within`. */
  items(
    key: string,
    options: Labelled & { readonly min: number; readonly max: number },
  ): readonly unknown[] {
    const raw = this.raw(key);
    if (raw === undefined) {
      this.missing(key, options, false);
      return [];
    }
    if (!Array.isArray(raw)) {
      return this.reject(key, 'invalid-type', `${options.label} debe ser una lista.`, []);
    }
    if (raw.length < options.min) {
      const plural = options.min === 1 ? 'elemento' : 'elementos';
      return this.reject(
        key,
        'too-few',
        `${options.label} debe tener al menos ${options.min} ${plural}.`,
        [],
      );
    }
    if (raw.length > options.max) {
      return this.reject(
        key,
        'too-many',
        `${options.label} no puede pasar de ${options.max} elementos.`,
        [],
      );
    }
    return raw as readonly unknown[];
  }

  /**
   * Un lector para un objeto que va DENTRO del cuerpo (una linea de una compra). Sus problemas salen con el puntero
   * completo (`/lines/0/quantityMilli`) y se suman a los de este lector, en el orden en que se encuentran.
   */
  within(pointer: string, input: unknown, allowed: readonly string[]): InputReader {
    return new InputReader(input, allowed, {
      prefix: `${this.prefix}${pointer}`,
      errors: this.errors,
    });
  }

  /** Si el campo llego como `null`, que en una peticion quiere decir «ninguno», distinto de no haber llegado. */
  isNull(key: string): boolean {
    return this.raw(key) === null;
  }

  /**
   * Convierte un valor ya leido con una funcion del dominio que lanza `RangeError` cuando lo rechaza (un SKU, un codigo de
   * barras). El rechazo queda como error del campo, con la frase que se indica; cualquier otro fallo es un defecto y sigue
   * su camino.
   */
  convert<T>(
    key: string,
    failure: { readonly code: string; readonly detail: string },
    convert: () => T,
    placeholder: T,
  ): T {
    try {
      return convert();
    } catch (error) {
      if (error instanceof RangeError) {
        return this.reject(key, failure.code, failure.detail, placeholder);
      }
      throw error;
    }
  }

  /** Para una regla que mira varios campos a la vez y que el lector no conoce. */
  fail(pointer: string, code: string, detail: string): void {
    this.errors.push({ pointer: `${this.prefix}${pointer}`, code, detail });
  }

  /** Lanza si algo no sirvio; si no, deja usar lo leido. */
  finish(): void {
    if (this.errors.length > 0) throw new ValidationFailedError([...this.errors]);
  }

  /**
   * Lo que la persona mando en ese campo, tal cual, para quien lo lee a su manera (los parametros de una URL son
   * texto). Solo lo propio: un nombre heredado como `constructor` cuenta como ausente.
   */
  raw(key: string): unknown {
    if (this.source === undefined || !Object.hasOwn(this.source, key)) return undefined;
    return this.source[key];
  }

  /** Anota «falta» salvo que el campo sea opcional. Devuelve si el campo podia faltar. */
  private missing(key: string, options: Labelled, optional: boolean): boolean {
    if (this.source === undefined) return optional;
    if (!optional)
      this.fail(`/${escapePointer(key)}`, 'required', `Falta ${lowerFirst(options.label)}.`);
    return optional;
  }

  private reject<T>(key: string, code: string, detail: string, placeholder: T): T {
    this.fail(`/${escapePointer(key)}`, code, detail);
    return placeholder;
  }
}
