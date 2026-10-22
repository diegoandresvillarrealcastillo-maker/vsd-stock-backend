const MAX_SKU_LENGTH = 40;

/** Letras, digitos y `. _ / -`, en grupos separados por un solo espacio. */
const SKU_PATTERN = /^[A-Za-z0-9._/-]+(?: [A-Za-z0-9._/-]+)*$/;

function shorten(text: string): string {
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

/**
 * El codigo interno con que un negocio nombra su mercancia (ADR 0015). Inmutable.
 *
 * `value` es como se escribio (sin espacios a los lados); `key` es esa misma cadena en mayusculas,
 * que es lo que se compara y lo que debe ser unico por negocio: «Arroz-500» y «ARROZ-500» son el mismo
 * codigo. Solo letras sin acento, digitos y `. _ / -`: lo que un lector, una impresora y una hoja de
 * calculo copian sin sorpresas.
 */
export class Sku {
  readonly value: string;
  readonly key: string;

  private constructor(value: string) {
    this.value = value;
    this.key = value.toUpperCase();
    Object.freeze(this);
  }

  /** Lanza RangeError si esta vacio, pasa de 40 caracteres o usa un caracter fuera del conjunto. */
  static parse(text: string): Sku {
    if (typeof text !== 'string') {
      throw new RangeError(`A SKU is read from text: ${String(text)}`);
    }
    const value = text.trim();
    if (value.length === 0 || value.length > MAX_SKU_LENGTH || !SKU_PATTERN.test(value)) {
      throw new RangeError(
        `"${shorten(value)}" is not a SKU: 1 to ${MAX_SKU_LENGTH} letters, digits and . _ / - (single spaces between)`,
      );
    }
    return new Sku(value);
  }

  equals(other: Sku): boolean {
    return this.key === other.key;
  }
}
