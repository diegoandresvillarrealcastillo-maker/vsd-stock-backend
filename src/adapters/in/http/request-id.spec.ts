import { describe, expect, it } from 'vitest';
import {
  REQUEST_ID_HEADER,
  requestIdMiddleware,
  resolveRequestId,
  type RequestLike,
  type ResponseLike,
} from './request-id.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('resolveRequestId', () => {
  it('keeps the identifier the caller sent, so that one id follows a request from the device to the log', () => {
    expect(resolveRequestId('3f0c9d58-8f6e-4f0a-9f0e-0d1d2a6b7c11')).toBe(
      '3f0c9d58-8f6e-4f0a-9f0e-0d1d2a6b7c11',
    );
    expect(resolveRequestId('device-AA_000142.try-2')).toBe('device-AA_000142.try-2');
  });

  it('makes a new UUID when the caller sent none', () => {
    expect(resolveRequestId(undefined)).toMatch(UUID);
    expect(resolveRequestId('')).toMatch(UUID);
  });

  it('never gives the same one twice', () => {
    expect(resolveRequestId(undefined)).not.toBe(resolveRequestId(undefined));
  });

  it.each([
    ['too short', 'abc'],
    ['too long', 'a'.repeat(65)],
    ['with a space', 'abc def ghi jkl'],
    ['with a line break (header injection)', 'abcdefgh\r\nSet-Cookie: x=1'],
    ['with a quote', 'abcdefgh"ij'],
    ['with a non-ASCII character', 'abcdefghñ'],
    ['with a slash', 'abcdefgh/ijk'],
  ])('replaces an identifier that is %s, because it ends up in the logs', (_label, received) => {
    const resolved = resolveRequestId(received);

    expect(resolved).not.toBe(received);
    expect(resolved).toMatch(UUID);
  });

  it('accepts exactly 8 and exactly 64 characters', () => {
    expect(resolveRequestId('a'.repeat(8))).toBe('a'.repeat(8));
    expect(resolveRequestId('a'.repeat(64))).toBe('a'.repeat(64));
  });
});

describe('requestIdMiddleware', () => {
  function run(header: string | undefined) {
    const sent: Record<string, string> = {};
    const req: RequestLike = {
      header: (name: string) => (name === REQUEST_ID_HEADER ? header : undefined),
    };
    const res: ResponseLike = {
      locals: {},
      setHeader: (name: string, value: string) => {
        sent[name] = value;
      },
    };
    let called = 0;
    const next = () => {
      called += 1;
    };
    requestIdMiddleware(req, res, next);
    return { sent, locals: res.locals, called };
  }

  it('answers with the identifier in the same header and leaves it for the rest of the request', () => {
    const { sent, locals } = run('device-request-0001');

    expect(sent[REQUEST_ID_HEADER]).toBe('device-request-0001');
    expect(locals['requestId']).toBe('device-request-0001');
  });

  it('makes one when the caller sent none', () => {
    const { sent, locals } = run(undefined);

    expect(sent[REQUEST_ID_HEADER]).toMatch(UUID);
    expect(locals['requestId']).toBe(sent[REQUEST_ID_HEADER]);
  });

  it('lets the request go on, exactly once', () => {
    expect(run(undefined).called).toBe(1);
  });
});
