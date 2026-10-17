/**
 * El alfabeto de los codigos de dispositivo (ADR 0016): treinta caracteres, sin 0, 1, I, L, O ni U, que
 * se confunden entre si al leerlos de un ticket o al dictarlos. Empieza por letras, asi que los primeros
 * dispositivos de un negocio son AA, AB, AC...
 */
export const DEVICE_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

const BASE = DEVICE_CODE_ALPHABET.length;
const MIN_LENGTH = 2;
const MAX_LENGTH = 4;

function shorten(text: string): string {
  return text.length > 20 ? `${text.slice(0, 20)}…` : text;
}

/**
 * El codigo corto que identifica a un dispositivo dentro de un negocio y encabeza sus folios (ADR 0016).
 * Lo asigna el servidor al registrar el dispositivo, nunca se reutiliza y sale de un contador, no del azar:
 * por eso dos dispositivos de un negocio no pueden tener el mismo. Inmutable.
 */
export class DeviceCode {
  readonly value: string;

  private constructor(value: string) {
    this.value = value;
    Object.freeze(this);
  }

  /** Lee un codigo escrito por una persona: 2 a 4 caracteres del alfabeto, sin importar mayusculas. */
  static parse(text: string): DeviceCode {
    if (typeof text !== 'string') {
      throw new RangeError(`A device code is read from text: ${String(text)}`);
    }
    const value = text.trim().toUpperCase();
    const valid =
      value.length >= MIN_LENGTH &&
      value.length <= MAX_LENGTH &&
      [...value].every((character) => DEVICE_CODE_ALPHABET.includes(character));
    if (!valid) {
      throw new RangeError(
        `"${shorten(text)}" is not a device code: ${MIN_LENGTH} to ${MAX_LENGTH} characters of ${DEVICE_CODE_ALPHABET}`,
      );
    }
    return new DeviceCode(value);
  }

  /**
   * El codigo del dispositivo numero `index` de un negocio, contando desde 0: los primeros 900 tienen dos
   * caracteres, los siguientes 27 000 tres y los siguientes 810 000 cuatro. Dos indices distintos nunca dan
   * el mismo codigo. Lanza RangeError si el negocio agota los 837 900.
   */
  static forIndex(index: number): DeviceCode {
    if (!Number.isInteger(index) || index < 0) {
      throw new RangeError(`A device index is a whole number from 0: ${String(index)}`);
    }
    let length = MIN_LENGTH;
    let offset = 0;
    let size = BASE ** MIN_LENGTH;
    while (index >= offset + size) {
      offset += size;
      length += 1;
      size *= BASE;
      if (length > MAX_LENGTH) {
        throw new RangeError(`A business has at most ${offset} devices: ${index}`);
      }
    }
    let rest = index - offset;
    let value = '';
    for (let position = 0; position < length; position += 1) {
      value = `${DEVICE_CODE_ALPHABET[rest % BASE]}${value}`;
      rest = Math.floor(rest / BASE);
    }
    return new DeviceCode(value);
  }

  equals(other: DeviceCode): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
