import { describe, expect, it } from 'vitest';
import { DEVICE_CODE_ALPHABET } from './device-code.js';
import { Folio } from './folio.js';
import { MAX_VOID_NUMBER, VOID_FOLIO_PREFIX, voidFolio } from './void-folio.js';

describe('voidFolio', () => {
  it('writes the prefix, a dash and the number padded to six digits', () => {
    expect(voidFolio(1)).toBe('ANU-000001');
    expect(voidFolio(142)).toBe('ANU-000142');
    expect(voidFolio(999_999)).toBe('ANU-999999');
  });

  it('keeps growing past six digits instead of wrapping', () => {
    expect(voidFolio(1_000_000)).toBe('ANU-1000000');
    expect(voidFolio(MAX_VOID_NUMBER)).toBe('ANU-2147483646');
  });

  it('is the last number the counter of a business can give: it keeps the next one in an integer column', () => {
    expect(MAX_VOID_NUMBER).toBe(2_147_483_646);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_VOID_NUMBER + 1])(
    'rejects the number %s',
    (number) => {
      expect(() => voidFolio(number)).toThrow(RangeError);
    },
  );

  it('says which number it rejected and what range it accepts', () => {
    expect(() => voidFolio(0)).toThrow('A void number is a whole number from 1 to 2147483646: 0');
  });
});

describe('the prefix of the void folios', () => {
  it('is ANU', () => {
    expect(VOID_FOLIO_PREFIX).toBe('ANU');
  });

  it('has a character no device code can have, so a void folio never equals a sale folio (ADR 0016)', () => {
    const outside = [...VOID_FOLIO_PREFIX].filter((c) => !DEVICE_CODE_ALPHABET.includes(c));

    expect(outside).toEqual(['U']);
  });

  it('is not read as the folio of a sale', () => {
    expect(() => Folio.parse(voidFolio(7))).toThrow(RangeError);
  });
});
