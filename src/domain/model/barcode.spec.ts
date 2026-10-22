import { describe, expect, it } from 'vitest';
import { Barcode } from './barcode.js';

/** Digito de control GTIN calculado aparte de la implementacion: pesos 3 y 1 desde la derecha. */
function referenceCheckDigit(body: string): number {
  let sum = 0;
  [...body].reverse().forEach((digit, index) => {
    sum += Number(digit) * (index % 2 === 0 ? 3 : 1);
  });
  return (10 - (sum % 10)) % 10;
}

const withCheckDigit = (body: string): string => `${body}${referenceCheckDigit(body)}`;

describe('Barcode.parse', () => {
  it.each([
    ['EAN-13', '4006381333931'],
    ['EAN-13', '5901234123457'],
    ['UPC-A', '036000291452'],
    ['EAN-8', '96385074'],
    ['EAN-8', '73513537'],
    ['GTIN-14', '10614141000415'],
  ])('accepts the %s code %s', (_format, code) => {
    expect(Barcode.parse(code).value).toBe(code);
  });

  it('accepts a code built with the reference check digit, for every accepted length', () => {
    for (const length of [8, 12, 13, 14]) {
      for (const seed of ['1', '12345', '987654', '70123']) {
        const body = seed.padEnd(length - 1, '7').slice(0, length - 1);
        const code = withCheckDigit(body);

        expect(Barcode.parse(code).value, code).toBe(code);
      }
    }
  });

  it('rejects a code whose check digit is wrong, which is how a typed typo shows up', () => {
    expect(() => Barcode.parse('4006381333932')).toThrow(RangeError);
    expect(() => Barcode.parse('7701234567890')).toThrow(RangeError);
  });

  it('catches every single-digit typo in a code', () => {
    const code = '4006381333931';
    for (let position = 0; position < code.length; position += 1) {
      for (const digit of '0123456789') {
        if (digit === code[position]) continue;
        const typo = `${code.slice(0, position)}${digit}${code.slice(position + 1)}`;

        expect(() => Barcode.parse(typo), typo).toThrow(RangeError);
      }
    }
  });

  it('catches almost every swap of two neighbouring digits (it misses digits that differ by 5: a known limit)', () => {
    const code = '4006381333931';
    let caught = 0;
    let missed = 0;
    for (let position = 0; position < code.length - 1; position += 1) {
      const a = code[position] ?? '';
      const b = code[position + 1] ?? '';
      if (a === b) continue;
      const swapped = `${code.slice(0, position)}${b}${a}${code.slice(position + 2)}`;
      try {
        Barcode.parse(swapped);
        missed += 1;
      } catch {
        caught += 1;
      }
    }

    expect(caught).toBeGreaterThan(missed);
  });

  it.each([
    ['', 'empty'],
    ['   ', 'blank'],
    ['400638133393', '12 digits but the check digit fails'],
    ['40063813339', '11 digits'],
    ['400638133393100', '15 digits'],
    ['4006381333 931', 'a space inside'],
    ['4006381333-931', 'a dash'],
    ['ABCDEFGH', 'letters'],
    ['4006381333931x', 'a trailing letter'],
    ['0000000000000', 'all zeros has a valid check digit but is not a product'],
    ['12345678', 'eight digits, wrong check'],
  ])('rejects "%s" (%s)', (text) => {
    expect(() => Barcode.parse(text)).toThrow(RangeError);
  });

  it('accepts only the lengths of a GTIN, even when the check digit is right', () => {
    for (let length = 1; length <= 20; length += 1) {
      if ([8, 12, 13, 14].includes(length)) continue;
      const code = withCheckDigit('7'.repeat(Math.max(length - 1, 0)));
      const attempt = () => Barcode.parse(length === 1 ? '7' : code);

      expect(attempt, `${length} digits`).toThrow(/8, 12, 13 or 14/);
    }
  });

  it('says that a barcode is digits only when it has letters', () => {
    expect(() => Barcode.parse('ABCDEFGH')).toThrow(/digits only/);
    expect(() => Barcode.parse('4006381333931x')).toThrow(/digits only/);
    expect(() => Barcode.parse('4006-3813-3393')).toThrow(/digits only/);
  });

  it('ignores the whitespace and the line break a scanner adds', () => {
    expect(Barcode.parse(' 4006381333931\r\n').value).toBe('4006381333931');
    expect(Barcode.parse('\t96385074\n').value).toBe('96385074');
  });

  it('rejects what is not text', () => {
    expect(() => Barcode.parse(4_006_381_333_931 as never)).toThrow(RangeError);
    expect(() => Barcode.parse(null as never)).toThrow(RangeError);
  });

  it('says in the error what it could not read, without echoing a huge input', () => {
    expect(() => Barcode.parse('4006381333932')).toThrow(/4006381333932/);
    expect(() => Barcode.parse('9'.repeat(5000))).toThrow(/^[^]{0,200}$/);
  });
});

describe('Barcode key', () => {
  it('is the 14-digit form, so that the same product has one key whatever its length', () => {
    expect(Barcode.parse('96385074').key).toBe('00000096385074');
    expect(Barcode.parse('036000291452').key).toBe('00036000291452');
    expect(Barcode.parse('4006381333931').key).toBe('04006381333931');
    expect(Barcode.parse('10614141000415').key).toBe('10614141000415');
  });

  it('makes a UPC-A and the EAN-13 that adds a leading zero the same code', () => {
    const upc = Barcode.parse('036000291452');
    const ean = Barcode.parse('0036000291452');

    expect(upc.key).toBe(ean.key);
    expect(upc.equals(ean)).toBe(true);
    expect(upc.value).not.toBe(ean.value);
  });

  it('tells two different products apart', () => {
    expect(Barcode.parse('4006381333931').equals(Barcode.parse('5901234123457'))).toBe(false);
  });
});

describe('Barcode is immutable', () => {
  it('cannot be changed once created', () => {
    const code = Barcode.parse('96385074');

    expect(() => {
      (code as { value: string }).value = '1';
    }).toThrow(TypeError);
  });
});
