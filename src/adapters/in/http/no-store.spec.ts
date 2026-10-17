import { describe, expect, it } from 'vitest';
import { noStoreMiddleware } from './no-store.js';

describe('noStoreMiddleware', () => {
  function run() {
    const headers: Record<string, string> = {};
    let called = 0;
    noStoreMiddleware(
      {},
      {
        setHeader: (name: string, value: string) => {
          headers[name] = value;
        },
      },
      () => {
        called += 1;
      },
    );
    return { headers, called };
  }

  it('forbids every cache from keeping the answer: a stale answer is a wrong one (ADR 0019)', () => {
    expect(run().headers['Cache-Control']).toBe('no-store');
  });

  it('lets the request go on, exactly once', () => {
    expect(run().called).toBe(1);
  });
});
