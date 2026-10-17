import { describe, expect, it } from 'vitest';
import { DEVICE_CODE_ALPHABET, DeviceCode } from './device-code.js';

describe('device code alphabet', () => {
  it('has thirty characters and none that can be mistaken for another', () => {
    expect(DEVICE_CODE_ALPHABET).toHaveLength(30);
    expect(new Set(DEVICE_CODE_ALPHABET).size).toBe(30);
    for (const confusing of ['0', '1', 'I', 'L', 'O', 'U']) {
      expect(DEVICE_CODE_ALPHABET, confusing).not.toContain(confusing);
    }
  });

  it('starts with letters, so the first devices are AA, AB, AC...', () => {
    expect(DEVICE_CODE_ALPHABET.startsWith('ABCDEFGH')).toBe(true);
  });
});

describe('DeviceCode.forIndex', () => {
  it.each([
    [0, 'AA'],
    [1, 'AB'],
    [29, 'A9'],
    [30, 'BA'],
    [899, '99'],
  ])('gives device %i the code %s', (index, code) => {
    expect(DeviceCode.forIndex(index).value).toBe(code);
  });

  it('grows to three and then four characters when the two-character codes run out', () => {
    expect(DeviceCode.forIndex(900).value).toBe('AAA');
    expect(DeviceCode.forIndex(900 + 27_000 - 1).value).toBe('999');
    expect(DeviceCode.forIndex(900 + 27_000).value).toBe('AAAA');
    expect(DeviceCode.forIndex(900 + 27_000 + 810_000 - 1).value).toBe('9999');
  });

  it('never gives two devices the same code, across all the lengths', () => {
    const seen = new Set<string>();
    for (let index = 0; index < 30_000; index += 1) {
      seen.add(DeviceCode.forIndex(index).value);
    }

    expect(seen.size).toBe(30_000);
  });

  it('only uses characters of the alphabet, and every code can be read back', () => {
    for (const index of [0, 7, 29, 30, 899, 900, 12_345, 27_899, 27_900, 100_000]) {
      const code = DeviceCode.forIndex(index);

      expect(DeviceCode.parse(code.value).equals(code)).toBe(true);
    }
  });

  it.each([-1, 1.5, Number.NaN, 900 + 27_000 + 810_000])('rejects the index %s', (index) => {
    expect(() => DeviceCode.forIndex(index)).toThrow(RangeError);
  });
});

describe('DeviceCode.parse', () => {
  it.each(['AA', 'K7', 'ZZ9', 'A2B3', '99'])('accepts "%s"', (text) => {
    expect(DeviceCode.parse(text).value).toBe(text);
  });

  it('reads lower case as upper case, because a person types it', () => {
    expect(DeviceCode.parse(' k7 ').value).toBe('K7');
  });

  it.each([
    ['', 'empty'],
    ['A', 'one character'],
    ['ABCDE', 'five characters'],
    ['A0', 'a zero'],
    ['A1', 'a one'],
    ['AO', 'a letter O'],
    ['AI', 'a letter I'],
    ['AL', 'a letter L'],
    ['AU', 'a letter U'],
    ['A-', 'a dash'],
    ['A B', 'a space inside'],
  ])('rejects "%s" (%s)', (text) => {
    expect(() => DeviceCode.parse(text)).toThrow(RangeError);
  });

  it('rejects what is not text', () => {
    expect(() => DeviceCode.parse(12 as never)).toThrow(RangeError);
  });

  it('is shown as its value', () => {
    expect(String(DeviceCode.parse('K7'))).toBe('K7');
  });

  it('cannot be changed once created', () => {
    const code = DeviceCode.parse('K7');

    expect(() => {
      (code as { value: string }).value = 'ZZ';
    }).toThrow(TypeError);
  });
});
