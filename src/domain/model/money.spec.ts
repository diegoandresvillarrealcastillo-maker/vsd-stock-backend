import { describe, expect, it } from 'vitest';
import { MAX_PESOS, Money } from './money.js';

describe('Money', () => {
  it('holds a whole number of Colombian pesos', () => {
    const price = Money.of(2500);

    expect(price.amount).toBe(2500);
    expect(price.currency).toBe('COP');
  });

  it('has a zero', () => {
    expect(Money.zero().amount).toBe(0);
    expect(Money.zero().isZero()).toBe(true);
    expect(Money.of(1).isZero()).toBe(false);
  });

  it('accepts a negative amount (a void or a refund)', () => {
    expect(Money.of(-500).isNegative()).toBe(true);
    expect(Money.of(500).isNegative()).toBe(false);
    expect(Money.zero().isNegative()).toBe(false);
  });

  it.each([
    ['a fraction of a peso', 1.5],
    ['not a number', Number.NaN],
    ['infinity', Number.POSITIVE_INFINITY],
    ['a number outside the safe range', Number.MAX_SAFE_INTEGER + 2],
    ['an amount above the maximum', MAX_PESOS + 1],
    ['an amount below the negative maximum', -MAX_PESOS - 1],
  ])('rejects %s', (_label, amount) => {
    expect(() => Money.of(amount)).toThrow(RangeError);
  });

  it('rejects what is not a number at all', () => {
    expect(() => Money.of('mil' as never)).toThrow(RangeError);
    expect(() => Money.of(null as never)).toThrow(RangeError);
    expect(() => Money.of(10n as never)).toThrow(RangeError);
  });

  it('accepts the maximum and its negative', () => {
    expect(Money.of(MAX_PESOS).amount).toBe(MAX_PESOS);
    expect(Money.of(-MAX_PESOS).amount).toBe(-MAX_PESOS);
  });

  it('adds and subtracts without touching the originals', () => {
    const a = Money.of(1000);
    const b = Money.of(250);

    expect(a.add(b).amount).toBe(1250);
    expect(a.subtract(b).amount).toBe(750);
    expect(b.subtract(a).amount).toBe(-750);
    expect(a.amount).toBe(1000);
    expect(b.amount).toBe(250);
  });

  it('negates', () => {
    expect(Money.of(300).negate().amount).toBe(-300);
    expect(Money.of(-300).negate().amount).toBe(300);
    expect(Money.zero().negate().amount).toBe(0);
    expect(Object.is(Money.zero().negate().amount, -0)).toBe(false);
  });

  it('refuses a result above the maximum instead of silently losing precision', () => {
    expect(() => Money.of(MAX_PESOS).add(Money.of(1))).toThrow(RangeError);
    expect(() => Money.of(-MAX_PESOS).subtract(Money.of(1))).toThrow(RangeError);
  });

  it('compares by amount', () => {
    expect(Money.of(100).equals(Money.of(100))).toBe(true);
    expect(Money.of(100).equals(Money.of(101))).toBe(false);
    expect(Money.of(100).compareTo(Money.of(200))).toBeLessThan(0);
    expect(Money.of(200).compareTo(Money.of(100))).toBeGreaterThan(0);
    expect(Money.of(100).compareTo(Money.of(100))).toBe(0);
  });

  it('cannot be changed once created', () => {
    const price = Money.of(100);

    expect(() => {
      (price as { amount: number }).amount = 999;
    }).toThrow(TypeError);
    expect(price.amount).toBe(100);
  });

  it('serializes as the plain integer of pesos', () => {
    expect(JSON.stringify({ price: Money.of(1900) })).toBe('{"price":1900}');
  });
});
