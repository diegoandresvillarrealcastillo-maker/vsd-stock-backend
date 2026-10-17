import { describe, expect, it } from 'vitest';
import {
  INVITATION_CODE_ALPHABET,
  INVITATION_CODE_LENGTH,
  formatInvitationCode,
  invitationCodeFromBytes,
  normalizeInvitationCode,
} from './invitation-code.js';

describe('the alphabet', () => {
  it('has 32 characters and leaves out I, L, O and U, which are confused with 1, 0 and V when read aloud', () => {
    expect(INVITATION_CODE_ALPHABET).toHaveLength(32);
    expect(new Set(INVITATION_CODE_ALPHABET).size).toBe(32);
    for (const forbidden of ['I', 'L', 'O', 'U']) {
      expect(INVITATION_CODE_ALPHABET).not.toContain(forbidden);
    }
  });

  it('gives sixteen characters, which are eighty bits: guessing one is not a matter of trying', () => {
    expect(INVITATION_CODE_LENGTH).toBe(16);
    expect(Math.log2(32) * INVITATION_CODE_LENGTH).toBe(80);
  });
});

describe('a code from random bytes', () => {
  it('reads ten bytes as sixteen groups of five bits, in order', () => {
    expect(
      invitationCodeFromBytes(Uint8Array.from([0, 68, 50, 20, 199, 66, 84, 182, 53, 207])),
    ).toBe('0123456789ABCDEF');
    expect(
      invitationCodeFromBytes(Uint8Array.from([132, 101, 58, 86, 215, 198, 117, 190, 119, 223])),
    ).toBe('GHJKMNPQRSTVWXYZ');
  });

  it('gives the first and the last characters for all zeros and all ones', () => {
    expect(invitationCodeFromBytes(new Uint8Array(10))).toBe('0000000000000000');
    expect(invitationCodeFromBytes(new Uint8Array(10).fill(255))).toBe('ZZZZZZZZZZZZZZZZ');
  });

  it.each([0, 9, 11, 16])(
    'refuses %i bytes: it needs exactly ten, or a short code would pass as a good one',
    (size) => {
      expect(() => invitationCodeFromBytes(new Uint8Array(size))).toThrow(RangeError);
    },
  );
});

describe('writing a code for a person', () => {
  it('groups it in fours, so it can be read from a screen and dictated', () => {
    expect(formatInvitationCode('0123456789ABCDEF')).toBe('0123-4567-89AB-CDEF');
  });
});

describe('reading a code a person typed', () => {
  it('accepts the canonical text', () => {
    expect(normalizeInvitationCode('0123456789ABCDEF')).toBe('0123456789ABCDEF');
  });

  it.each([
    ['dashes', '0123-4567-89AB-CDEF'],
    ['spaces', ' 0123 4567 89AB CDEF '],
    ['lower case', '0123-4567-89ab-cdef'],
    ['tabs and new lines from a paste', '\t0123456789ABCDEF\n'],
    ['no separators at all', '0123456789abcdef'],
  ])('accepts it with %s', (_label, text) => {
    expect(normalizeInvitationCode(text)).toBe('0123456789ABCDEF');
  });

  it('reads the letters that look like digits as the digits, as people mistype them', () => {
    expect(normalizeInvitationCode('OIL0-1234-5678-9ABC')).toBe('0110123456789ABC');
    expect(normalizeInvitationCode('oil0-1234-5678-9abc')).toBe('0110123456789ABC');
  });

  it.each([
    ['too short', '0123-4567-89AB-CDE'],
    ['too long', '0123-4567-89AB-CDEF-0'],
    ['empty', ''],
    ['only separators', ' - - '],
    ['the letter U, which the alphabet leaves out', '0123-4567-89AB-CDEU'],
    ['a symbol', '0123-4567-89AB-CDE!'],
    ['an accented letter', '0123-4567-89AB-CDÉF'],
  ])('refuses %s', (_label, text) => {
    expect(normalizeInvitationCode(text)).toBeUndefined();
  });

  it.each([undefined, null, 42, {}, ['0123456789ABCDEF']])(
    'refuses %j, which is not text',
    (value) => {
      expect(normalizeInvitationCode(value)).toBeUndefined();
    },
  );

  it('refuses a very long text', () => {
    expect(normalizeInvitationCode('A'.repeat(100_000))).toBeUndefined();
  });
});
