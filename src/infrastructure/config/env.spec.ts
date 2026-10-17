import { describe, expect, it } from 'vitest';
import { readConfig } from './env.js';

describe('readConfig', () => {
  it('uses port 3000 when PORT is not set', () => {
    expect(readConfig({}).port).toBe(3000);
  });

  it('reads PORT as an integer', () => {
    expect(readConfig({ PORT: '8080' }).port).toBe(8080);
  });

  it.each(['abc', '', '80.5', '0', '-1', '65536'])(
    'rejects PORT=%j with a message that names the variable',
    (value) => {
      expect(() => readConfig({ PORT: value })).toThrow(/PORT/);
    },
  );
});

describe('readConfig: CORS_ORIGINS', () => {
  it('allows no origin when CORS_ORIGINS is not set', () => {
    expect(readConfig({}).corsOrigins).toEqual([]);
  });

  it('allows no origin when CORS_ORIGINS is empty', () => {
    expect(readConfig({ CORS_ORIGINS: '' }).corsOrigins).toEqual([]);
  });

  it('reads one origin', () => {
    expect(readConfig({ CORS_ORIGINS: 'http://localhost:5173' }).corsOrigins).toEqual([
      'http://localhost:5173',
    ]);
  });

  it('reads a comma separated list and trims the spaces around each origin', () => {
    const config = readConfig({
      CORS_ORIGINS: ' http://localhost:5173 , https://stock.example.com ',
    });

    expect(config.corsOrigins).toEqual(['http://localhost:5173', 'https://stock.example.com']);
  });

  it('ignores empty entries such as a trailing comma', () => {
    const config = readConfig({ CORS_ORIGINS: 'https://stock.example.com,' });

    expect(config.corsOrigins).toEqual(['https://stock.example.com']);
  });

  it('rejects the wildcard and says why', () => {
    expect(() => readConfig({ CORS_ORIGINS: '*' })).toThrow(/CORS_ORIGINS.*comodin/);
  });

  it.each([
    ['a host without scheme', 'localhost:5173'],
    ['a trailing slash', 'http://localhost:5173/'],
    ['a path', 'https://stock.example.com/app'],
    ['a scheme that is not http or https', 'ftp://stock.example.com'],
    ['a scheme without host', 'https://'],
    ['uppercase letters', 'HTTPS://Stock.Example.com'],
    ['the default port written out', 'https://stock.example.com:443'],
    ['plain text', 'not an origin'],
  ])('rejects %s and names the variable and the value', (_label, value) => {
    expect(() => readConfig({ CORS_ORIGINS: value })).toThrow(
      new RegExp(`CORS_ORIGINS.*${JSON.stringify(value).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`),
    );
  });

  it('rejects the whole list when one origin is wrong', () => {
    expect(() =>
      readConfig({ CORS_ORIGINS: 'http://localhost:5173,https://stock.example.com/' }),
    ).toThrow(/CORS_ORIGINS/);
  });
});
