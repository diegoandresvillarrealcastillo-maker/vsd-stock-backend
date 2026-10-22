import { describe, expect, it } from 'vitest';
import { DeviceCode } from './device-code.js';
import { Folio, MAX_SERIAL, nextFolio } from './folio.js';

const K7 = DeviceCode.parse('K7');

describe('Folio.of', () => {
  it('writes the device code, a dash and the serial padded to six digits', () => {
    expect(Folio.of(K7, 142).toString()).toBe('K7-000142');
    expect(Folio.of(K7, 1).toString()).toBe('K7-000001');
    expect(Folio.of(K7, 999_999).toString()).toBe('K7-999999');
  });

  it('keeps growing past six digits instead of wrapping', () => {
    expect(Folio.of(K7, 1_000_000).toString()).toBe('K7-1000000');
    expect(Folio.of(K7, MAX_SERIAL).toString()).toBe('K7-999999999');
  });

  it.each([0, -1, 1.5, Number.NaN, MAX_SERIAL + 1])('rejects the serial %s', (serial) => {
    expect(() => Folio.of(K7, serial)).toThrow(RangeError);
  });

  it('is the same folio only with the same device and the same serial', () => {
    expect(Folio.of(K7, 5).equals(Folio.of(DeviceCode.parse('K7'), 5))).toBe(true);
    expect(Folio.of(K7, 5).equals(Folio.of(K7, 6))).toBe(false);
    expect(Folio.of(K7, 5).equals(Folio.of(DeviceCode.parse('K8'), 5))).toBe(false);
  });

  it('cannot be changed once created', () => {
    const folio = Folio.of(K7, 5);

    expect(() => {
      (folio as { serial: number }).serial = 6;
    }).toThrow(TypeError);
  });
});

describe('Folio.parse', () => {
  it('reads back what it writes', () => {
    for (const serial of [1, 9, 142, 99_999, 999_999, 1_000_000, 123_456_789, MAX_SERIAL]) {
      const folio = Folio.of(K7, serial);

      expect(Folio.parse(folio.toString()).equals(folio), String(serial)).toBe(true);
    }
  });

  it('reads folios of devices with codes of two, three and four characters', () => {
    expect(Folio.parse('AA-000001').device?.value).toBe('AA');
    expect(Folio.parse('AAA-000001').device?.value).toBe('AAA');
    expect(Folio.parse('A2B3-000001').device?.value).toBe('A2B3');
  });

  it('tolerates the case and the spaces a person types', () => {
    expect(Folio.parse('  k7-000142 ').toString()).toBe('K7-000142');
  });

  it.each([
    ['', 'empty'],
    ['K7000142', 'no dash'],
    ['K7-142', 'a serial that is not padded to six digits'],
    ['K7-0001420', 'a serial with a zero too many'],
    ['K7-000000', 'serial zero'],
    ['K7-00014a', 'a letter in the serial'],
    ['K0-000142', 'a character outside the alphabet'],
    ['-000142', 'no device'],
    ['K7-', 'no serial'],
    ['K7-000142-1', 'a second dash'],
    ['K7-1000000000', 'a serial over the maximum'],
  ])('rejects "%s" (%s)', (text) => {
    expect(() => Folio.parse(text)).toThrow(RangeError);
  });

  it('rejects what is not text', () => {
    expect(() => Folio.parse(142 as never)).toThrow(RangeError);
  });
});

describe('nextFolio', () => {
  it('numbers the first sale of a device 1', () => {
    expect(nextFolio(K7, 0).toString()).toBe('K7-000001');
  });

  it('follows the last serial the device used', () => {
    expect(nextFolio(K7, 141).toString()).toBe('K7-000142');
  });

  it('numbers a device without gaps and without repeating', () => {
    const seen = new Set<string>();
    let last = 0;
    for (let sale = 0; sale < 2000; sale += 1) {
      const folio = nextFolio(K7, last);
      seen.add(folio.toString());
      last = folio.serial;
    }

    expect(seen.size).toBe(2000);
    expect(last).toBe(2000);
  });

  it('refuses to number past the maximum', () => {
    expect(() => nextFolio(K7, MAX_SERIAL)).toThrow(RangeError);
  });

  it.each([-1, 1.5, Number.NaN])('rejects the last serial %s', (last) => {
    expect(() => nextFolio(K7, last)).toThrow(RangeError);
    expect(() => nextFolio(K7, last)).toThrow(/last serial/);
  });
});
