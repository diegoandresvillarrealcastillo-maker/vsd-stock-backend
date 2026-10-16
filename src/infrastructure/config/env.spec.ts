import { describe, expect, it } from 'vitest';
import { readConfig } from './env.js';

describe('readConfig', () => {
  it('uses port 3000 when PORT is not set', () => {
    expect(readConfig({})).toEqual({ port: 3000 });
  });

  it('reads PORT as an integer', () => {
    expect(readConfig({ PORT: '8080' })).toEqual({ port: 8080 });
  });

  it.each(['abc', '', '80.5', '0', '-1', '65536'])(
    'rejects PORT=%j with a message that names the variable',
    (value) => {
      expect(() => readConfig({ PORT: value })).toThrow(/PORT/);
    },
  );
});
