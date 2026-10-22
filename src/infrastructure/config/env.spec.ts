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

describe('readConfig: DATABASE_URL', () => {
  const PASSWORD = 'ContrasenaLarga123';
  const url = `postgresql://stock_app.abcdef:${PASSWORD}@aws-0-sa-east-1.pooler.supabase.com:5432/postgres`;

  it('has no database when DATABASE_URL is not set', () => {
    expect(readConfig({}).database).toBeUndefined();
  });

  it('has no database when DATABASE_URL is empty (a copied .env.example)', () => {
    expect(readConfig({ DATABASE_URL: '' }).database).toBeUndefined();
  });

  it('reads the connection string and describes where it goes without the password', () => {
    const database = readConfig({ DATABASE_URL: url }).database;

    expect(database?.url).toBe(url);
    expect(database?.target).toBe(
      'stock_app.abcdef@aws-0-sa-east-1.pooler.supabase.com:5432/postgres',
    );
    expect(database?.target).not.toContain(PASSWORD);
  });

  it('accepts the postgres:// scheme and defaults the port', () => {
    expect(
      readConfig({ DATABASE_URL: 'postgres://stock_app@localhost/stock_test' }).database?.target,
    ).toBe('stock_app@localhost:5432/stock_test');
  });

  it.each(['esto no es una url', 'mysql://u:p@localhost/db', 'http://localhost'])(
    'rejects DATABASE_URL=%j with a message that names the variable',
    (value) => {
      expect(() => readConfig({ DATABASE_URL: value })).toThrow(/DATABASE_URL/);
    },
  );

  it('never repeats a malformed connection string either, because it still carries the password', () => {
    const attempt = () =>
      readConfig({ DATABASE_URL: `postgresql://stock_app:${PASSWORD}@host:no-es-un-puerto/base` });

    expect(attempt).toThrow(/DATABASE_URL/);
    expect(attempt).not.toThrow(PASSWORD);
  });

  it('never repeats the connection string in the error, because it carries the password', () => {
    const attempt = () => readConfig({ DATABASE_URL: `mysql://u:${PASSWORD}@localhost/db` });

    expect(attempt).toThrow(/DATABASE_URL/);
    expect(attempt).not.toThrow(PASSWORD);
  });
});

describe('readConfig: identity (AUTH_*)', () => {
  const issuer = 'https://abcdef.supabase.co/auth/v1';
  const jwksUrl = 'https://abcdef.supabase.co/auth/v1/.well-known/jwks.json';

  it('has no identity service when nothing is set', () => {
    expect(readConfig({}).auth).toBeUndefined();
  });

  it('has none when the variables are empty (a copied .env.example)', () => {
    expect(
      readConfig({ AUTH_ISSUER: '', AUTH_JWKS_URL: '', AUTH_AUDIENCE: '' }).auth,
    ).toBeUndefined();
  });

  it('reads the issuer, the key set and the audience', () => {
    expect(
      readConfig({ AUTH_ISSUER: issuer, AUTH_JWKS_URL: jwksUrl, AUTH_AUDIENCE: 'authenticated' })
        .auth,
    ).toEqual({ issuer, jwksUrl, audience: 'authenticated' });
  });

  it('defaults the audience to authenticated, which is what Supabase puts in a signed-in person token', () => {
    expect(readConfig({ AUTH_ISSUER: issuer, AUTH_JWKS_URL: jwksUrl }).auth?.audience).toBe(
      'authenticated',
    );
  });

  it('allows a plain http address for a service on this machine, such as the test one', () => {
    const local = readConfig({
      AUTH_ISSUER: 'http://127.0.0.1:54321/auth/v1',
      AUTH_JWKS_URL: 'http://127.0.0.1:54321/auth/v1/.well-known/jwks.json',
    });

    expect(local.auth?.issuer).toBe('http://127.0.0.1:54321/auth/v1');
  });

  it('refuses a set of keys fetched over plain http from another machine: anyone on the way could swap it', () => {
    expect(() =>
      readConfig({
        AUTH_ISSUER: issuer,
        AUTH_JWKS_URL: 'http://abcdef.supabase.co/auth/v1/.well-known/jwks.json',
      }),
    ).toThrow(/AUTH_JWKS_URL/);
  });

  it.each([
    [{ AUTH_ISSUER: issuer }, 'AUTH_JWKS_URL'],
    [{ AUTH_JWKS_URL: jwksUrl }, 'AUTH_ISSUER'],
    [{ AUTH_AUDIENCE: 'authenticated' }, 'AUTH_ISSUER'],
  ])('refuses a half-configured identity service %j, naming what is missing', (env, missing) => {
    expect(() => readConfig(env)).toThrow(missing);
  });

  it.each(['no es una url', 'ftp://x.example.com/auth/v1', 'https://x.example.com/auth/v1?a=b'])(
    'refuses AUTH_ISSUER=%j',
    (value) => {
      expect(() => readConfig({ AUTH_ISSUER: value, AUTH_JWKS_URL: jwksUrl })).toThrow(
        /AUTH_ISSUER/,
      );
    },
  );

  it.each(['no es una url', 'ftp://x.example.com/keys'])('refuses AUTH_JWKS_URL=%j', (value) => {
    expect(() => readConfig({ AUTH_ISSUER: issuer, AUTH_JWKS_URL: value })).toThrow(
      /AUTH_JWKS_URL/,
    );
  });

  it('refuses a blank audience', () => {
    expect(() =>
      readConfig({ AUTH_ISSUER: issuer, AUTH_JWKS_URL: jwksUrl, AUTH_AUDIENCE: '  ' }),
    ).toThrow(/AUTH_AUDIENCE/);
  });
});
