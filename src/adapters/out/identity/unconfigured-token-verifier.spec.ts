import { describe, expect, it } from 'vitest';
import { InvalidTokenError } from '../../../domain/ports/out/token-verifier.js';
import { UnconfiguredTokenVerifier } from './unconfigured-token-verifier.js';

describe('UnconfiguredTokenVerifier', () => {
  it('refuses every token, saying the identity service was never configured rather than that the token is bad', async () => {
    const attempt = new UnconfiguredTokenVerifier().verify('cualquier.token.valido');

    await expect(attempt).rejects.toBeInstanceOf(InvalidTokenError);
    await expect(attempt).rejects.toMatchObject({ reason: 'not-configured' });
  });

  it('does not repeat the token in the error: it is a credential', async () => {
    const attempt = new UnconfiguredTokenVerifier().verify('secreto.en.el.token');

    await expect(attempt).rejects.not.toThrow('secreto');
  });
});
