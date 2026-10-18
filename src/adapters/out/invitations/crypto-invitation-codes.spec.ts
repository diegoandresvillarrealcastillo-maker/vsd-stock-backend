import { describe, expect, it } from 'vitest';
import { normalizeInvitationCode } from '../../../domain/model/invitation-code.js';
import { CryptoInvitationCodes } from './crypto-invitation-codes.js';

const KNOWN_HASH = '2125b2c332b1113aae9bfc5e9f7e3b4c91d828cb942c2df1eeb02502eccae9e9';
const BYTES_OF_KNOWN_CODE = Uint8Array.from([0, 68, 50, 20, 199, 66, 84, 182, 53, 207]);

describe('CryptoInvitationCodes', () => {
  it('turns the random bytes it is given into the code and the SHA-256 of that code', () => {
    const codes = new CryptoInvitationCodes(() => BYTES_OF_KNOWN_CODE);

    expect(codes.generate()).toEqual({ code: '0123456789ABCDEF', hash: KNOWN_HASH });
  });

  it('asks for ten random bytes: eighty bits', () => {
    const asked: number[] = [];
    const codes = new CryptoInvitationCodes((size) => {
      asked.push(size);
      return new Uint8Array(size);
    });

    codes.generate();

    expect(asked).toEqual([10]);
  });

  it('hashes a code the way it hashed the one it generated', () => {
    const codes = new CryptoInvitationCodes(() => BYTES_OF_KNOWN_CODE);

    expect(codes.hash('0123456789ABCDEF')).toBe(KNOWN_HASH);
    expect(codes.hash(codes.generate().code)).toBe(codes.generate().hash);
  });

  it('gives different hashes to different codes, in lower-case hex of sixty-four characters', () => {
    const codes = new CryptoInvitationCodes();

    expect(codes.hash('0123456789ABCDEF')).toMatch(/^[0-9a-f]{64}$/);
    expect(codes.hash('0123456789ABCDEG')).not.toBe(codes.hash('0123456789ABCDEF'));
  });

  it('uses real randomness by default: codes are valid, canonical and do not repeat', () => {
    const codes = new CryptoInvitationCodes();
    const seen = new Set<string>();

    for (let index = 0; index < 200; index += 1) {
      const { code, hash } = codes.generate();
      expect(normalizeInvitationCode(code)).toBe(code);
      expect(codes.hash(code)).toBe(hash);
      seen.add(code);
    }

    expect(seen.size).toBe(200);
  });
});
