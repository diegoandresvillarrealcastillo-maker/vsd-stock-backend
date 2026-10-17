/**
 * El monto mas grande que acepta el sistema, en pesos: un billon (10^12).
 * Mantiene toda suma y todo producto dentro de lo que un `number` representa sin
 * perder un peso, y deja de sobra para una tienda.
 */
export const MAX_PESOS = 1_000_000_000_000;

/**
 * Dinero en pesos colombianos, siempre un numero ENTERO de pesos (ADR 0014).
 * Nunca un `float`: el comercio no cobra centavos y un decimal es una fuente de
 * descuadres. Inmutable. Puede ser negativo (una anulacion compensa).
 */
export class Money {
  readonly currency = 'COP' as const;
  readonly amount: number;

  private constructor(amount: number) {
    this.amount = amount;
    Object.freeze(this);
  }

  /** Lanza RangeError si no es un entero de pesos dentro del maximo. */
  static of(amount: number): Money {
    // Number.isSafeInteger rechaza todo lo que no sea un numero (un texto, null, un bigint).
    if (!Number.isSafeInteger(amount) || Math.abs(amount) > MAX_PESOS) {
      throw new RangeError(
        `Money must be a whole number of pesos within ±${MAX_PESOS}: ${String(amount)}`,
      );
    }
    // -0 y 0 son el mismo dinero.
    return new Money(amount === 0 ? 0 : amount);
  }

  static zero(): Money {
    return new Money(0);
  }

  add(other: Money): Money {
    return Money.of(this.amount + other.amount);
  }

  subtract(other: Money): Money {
    return Money.of(this.amount - other.amount);
  }

  negate(): Money {
    return Money.of(-this.amount);
  }

  equals(other: Money): boolean {
    return this.amount === other.amount;
  }

  /** Negativo si es menor, cero si es igual, positivo si es mayor. */
  compareTo(other: Money): number {
    return Math.sign(this.amount - other.amount);
  }

  isZero(): boolean {
    return this.amount === 0;
  }

  isNegative(): boolean {
    return this.amount < 0;
  }

  /** En JSON viaja como el entero de pesos, sin moneda: la moneda es COP (ADR 0014). */
  toJSON(): number {
    return this.amount;
  }
}
