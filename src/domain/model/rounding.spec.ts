import { describe, expect, it } from 'vitest';
import { divideRounded } from './rounding.js';

describe('divideRounded', () => {
  it('returns the exact quotient when the division is exact', () => {
    expect(divideRounded(10n, 5n)).toBe(2n);
    expect(divideRounded(0n, 7n)).toBe(0n);
    expect(divideRounded(-10n, 5n)).toBe(-2n);
  });

  it('rounds down below one half and up above it', () => {
    expect(divideRounded(7n, 3n)).toBe(2n); // 2,33
    expect(divideRounded(8n, 3n)).toBe(3n); // 2,67
    expect(divideRounded(-7n, 3n)).toBe(-2n);
    expect(divideRounded(-8n, 3n)).toBe(-3n);
  });

  it('sends exactly one half away from zero, on both sides', () => {
    expect(divideRounded(1n, 2n)).toBe(1n); // 0,5
    expect(divideRounded(3n, 2n)).toBe(2n); // 1,5
    expect(divideRounded(5n, 2n)).toBe(3n); // 2,5
    expect(divideRounded(-1n, 2n)).toBe(-1n);
    expect(divideRounded(-3n, 2n)).toBe(-2n);
    expect(divideRounded(-5n, 2n)).toBe(-3n);
  });

  it('treats a sale and its void symmetrically', () => {
    for (let numerator = 0n; numerator <= 200n; numerator += 1n) {
      expect(divideRounded(-numerator, 7n)).toBe(-divideRounded(numerator, 7n));
    }
  });

  it('is exact beyond the range of safe integers', () => {
    const huge = 10n ** 30n;

    // (10^30 + 1) / 2 = 5 * 10^29 + 0,5: la mitad exacta sube.
    expect(divideRounded(huge + 1n, 2n)).toBe(huge / 2n + 1n);
    // (10^30 + 1) / 3 = 333...333,667: sube.
    expect(divideRounded(huge + 1n, 3n)).toBe(huge / 3n + 1n);
    expect(divideRounded(huge, 3n)).toBe(huge / 3n); // 333...333,333: baja
    expect(divideRounded(-(huge + 1n), 2n)).toBe(-(huge / 2n + 1n));
  });

  it('rejects a denominator that is not positive', () => {
    expect(() => divideRounded(1n, 0n)).toThrow(RangeError);
    expect(() => divideRounded(1n, -2n)).toThrow(RangeError);
  });
});
