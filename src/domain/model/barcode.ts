/** Los largos de un GTIN: EAN-8, UPC-A (12), EAN-13 y GTIN-14. */
const GTIN_LENGTHS: readonly number[] = [8, 12, 13, 14];

function shorten(text: string): string {
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

/** Digito de control GTIN: pesos 3 y 1 alternados desde la derecha del cuerpo (sin el digito de control). */
function checkDigit(body: string): number {
  let sum = 0;
  for (let index = 0; index < body.length; index += 1) {
    const digit = Number(body[body.length - 1 - index]);
    sum += digit * (index % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

/**
 * Un codigo de barras de producto (GTIN) con su digito de control comprobado (ADR 0015). Inmutable.
 *
 * `value` es lo que se leyo o se escribio; `key` es su forma de 14 digitos, con ceros a la izquierda,
 * que es lo que se compara y lo que debe ser unico por negocio: un UPC-A y el EAN-13 que le antepone
 * un cero son el mismo producto y comparten `key`.
 *
 * No admite los codigos de balanza (prefijos 20 a 29) como si fueran un producto: llevan precio o
 * peso adentro y no identifican nada. Tampoco el codigo de todo ceros.
 */
export class Barcode {
  readonly value: string;
  readonly key: string;

  private constructor(value: string) {
    this.value = value;
    this.key = value.padStart(14, '0');
    Object.freeze(this);
  }

  /** Lanza RangeError si no son 8, 12, 13 o 14 digitos con el digito de control correcto. */
  static parse(text: string): Barcode {
    if (typeof text !== 'string') {
      throw new RangeError(`A barcode is read from text: ${String(text)}`);
    }
    // Un lector de mano agrega un salto de linea al terminar: no es parte del codigo.
    const value = text.trim();
    if (!/^\d+$/.test(value) || !GTIN_LENGTHS.includes(value.length)) {
      throw new RangeError(
        `"${shorten(value)}" is not a barcode: digits only, 8, 12, 13 or 14 of them`,
      );
    }
    if (/^0+$/.test(value)) {
      throw new RangeError(`"${value}" is not a product barcode: it is all zeros`);
    }
    const expected = checkDigit(value.slice(0, -1));
    if (expected !== Number(value.slice(-1))) {
      throw new RangeError(
        `The check digit of the barcode ${value} is wrong (it should end in ${expected}): was it mistyped?`,
      );
    }
    return new Barcode(value);
  }

  equals(other: Barcode): boolean {
    return this.key === other.key;
  }
}
