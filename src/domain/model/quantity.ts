import { MAX_QUANTITY_MILLI } from './sale-totals.js';
import { isUnitOfMeasure, isWholeOnly, unitSymbol, type UnitOfMeasure } from './unit-of-measure.js';

const MILLI = 1000;

/** Un texto de cantidad: enteros, y un separador decimal (punto o coma) con hasta tres decimales. */
const QUANTITY_TEXT = /^(\d*)(?:[.,](\d{0,3}))?$/;
const TOO_MANY_DECIMALS = /^\d*[.,]\d{4,}$/;

/** Recorta lo que se cita en un mensaje de error, para que una entrada enorme no lo llene. */
function shorten(text: string): string {
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

/**
 * Una cantidad positiva de un producto, en milesimas de su unidad (ADR 0015): 1 unidad = 1000,
 * 1,5 kg = 1500. Inmutable. Una unidad que solo se cuenta en enteros no admite fracciones.
 */
export class Quantity {
  readonly milli: number;
  readonly unit: UnitOfMeasure;

  private constructor(milli: number, unit: UnitOfMeasure) {
    this.milli = milli;
    this.unit = unit;
    Object.freeze(this);
  }

  /** Lanza RangeError si no es un entero positivo de milesimas dentro del maximo, o si la unidad no admite fracciones. */
  static of(milli: number, unit: UnitOfMeasure): Quantity {
    if (!isUnitOfMeasure(unit)) {
      throw new RangeError(`Unknown unit of measure: ${String(unit)}`);
    }
    if (!Number.isInteger(milli) || milli < 1 || milli > MAX_QUANTITY_MILLI) {
      throw new RangeError(
        `A quantity is whole thousandths between 1 and ${MAX_QUANTITY_MILLI}: ${String(milli)}`,
      );
    }
    if (isWholeOnly(unit) && milli % MILLI !== 0) {
      throw new RangeError(
        `The unit "${unit}" is counted in whole numbers: ${Quantity.format(milli)}`,
      );
    }
    return new Quantity(milli, unit);
  }

  /**
   * Lee lo que escribe una persona: «2», «1,5» o «1.5». El punto y la coma son SIEMPRE el separador
   * decimal, nunca de miles, asi que «1.500» son un kilo y medio. Mas de tres decimales se rechazan
   * en lugar de redondearse en silencio.
   */
  static parse(text: string, unit: UnitOfMeasure): Quantity {
    if (typeof text !== 'string') {
      throw new RangeError(`A quantity is read from text: ${String(text)}`);
    }
    const trimmed = text.trim();
    if (TOO_MANY_DECIMALS.test(trimmed)) {
      throw new RangeError(`"${shorten(trimmed)}" has more than three decimals`);
    }
    const match = QUANTITY_TEXT.exec(trimmed);
    const whole = match?.[1] ?? '';
    const fraction = match?.[2] ?? '';
    if (match === null || (whole === '' && fraction === '')) {
      throw new RangeError(`"${shorten(trimmed)}" is not a quantity`);
    }
    const milli = BigInt(whole === '' ? '0' : whole) * 1000n + BigInt(fraction.padEnd(3, '0'));
    // Un numero enorme se vuelve impreciso al pasar a `number`, pero sigue pasando del maximo y `of` lo rechaza.
    return Quantity.of(Number(milli), unit);
  }

  /** La suma de dos cantidades de la misma unidad; un kilo y un litro no se suman. */
  add(other: Quantity): Quantity {
    if (this.unit !== other.unit) {
      throw new RangeError(`Cannot add ${other.unit} to ${this.unit}`);
    }
    return Quantity.of(this.milli + other.milli, this.unit);
  }

  equals(other: Quantity): boolean {
    return this.milli === other.milli && this.unit === other.unit;
  }

  /** «1.5 kg»: la cifra con punto decimal y sin ceros de mas, y el simbolo de la unidad. */
  toString(): string {
    return `${Quantity.format(this.milli)} ${unitSymbol(this.unit)}`;
  }

  private static format(milli: number): string {
    const whole = Math.floor(milli / MILLI);
    const fraction = String(milli % MILLI)
      .padStart(3, '0')
      .replace(/0+$/, '');
    return fraction === '' ? String(whole) : `${whole}.${fraction}`;
  }
}
