import { describe, expect, it } from 'vitest';
import {
  assertDisposableDatabase,
  describeDatabaseTarget,
  formatDatabaseTarget,
  isConfirmed,
  isLocalHost,
  requiresConfirmation,
} from '../../scripts/database-target.ts';

// Lo que una persona ve antes de aplicar una migracion y lo que impide que una prueba borre una base real
// (ADR 0010 y 0021). Ninguno de estos textos puede llevar una contrasena.

const PASSWORD = 'S3cretoLargo123';

describe('describeDatabaseTarget', () => {
  it('reads host, port, database and user', () => {
    const target = describeDatabaseTarget(
      `postgresql://postgres.abcdef:${PASSWORD}@aws-0-sa-east-1.pooler.supabase.com:5432/postgres`,
    );

    expect(target).toEqual({
      host: 'aws-0-sa-east-1.pooler.supabase.com',
      port: '5432',
      database: 'postgres',
      user: 'postgres.abcdef',
    });
  });

  it('uses 5432 when the string has no port', () => {
    expect(describeDatabaseTarget('postgresql://stock@localhost/stock_test').port).toBe('5432');
  });

  it('accepts the postgres:// scheme as well', () => {
    expect(describeDatabaseTarget('postgres://stock@localhost:5433/stock_test').host).toBe(
      'localhost',
    );
  });

  it('decodes a user or database name with percent-encoding', () => {
    const target = describeDatabaseTarget('postgresql://mi%20rol@localhost/mi%20base');

    expect(target.user).toBe('mi rol');
    expect(target.database).toBe('mi base');
  });

  it('rejects text that is not a URL without repeating it', () => {
    const attempt = () => describeDatabaseTarget(`esto-no-es-una-url-${PASSWORD}`);

    expect(attempt).toThrow('not a valid URL');
    expect(attempt).not.toThrow(PASSWORD);
  });

  it('rejects another scheme', () => {
    expect(() => describeDatabaseTarget('mysql://u@localhost/db')).toThrow('postgresql://');
  });
});

describe('formatDatabaseTarget', () => {
  it('never shows the password', () => {
    const text = formatDatabaseTarget(
      describeDatabaseTarget(
        `postgresql://stock_app.abcdef:${PASSWORD}@host.example.com:6543/postgres`,
      ),
    );

    expect(text).toBe('stock_app.abcdef@host.example.com:6543/postgres');
    expect(text).not.toContain(PASSWORD);
  });
});

describe('isLocalHost', () => {
  it.each(['localhost', 'LOCALHOST', '127.0.0.1', '[::1]'])('%s is local', (host) => {
    expect(isLocalHost(host)).toBe(true);
  });

  it.each(['db.abcdef.supabase.co', '10.0.0.5', 'localhost.evil.com', '127.0.0.1.nip.io'])(
    '%s is not local',
    (host) => {
      expect(isLocalHost(host)).toBe(false);
    },
  );
});

describe('assertDisposableDatabase', () => {
  it('accepts a local database whose name ends in _test', () => {
    expect(assertDisposableDatabase('postgresql://stock@127.0.0.1:5433/stock_test').database).toBe(
      'stock_test',
    );
  });

  it('refuses a remote host even if the name ends in _test', () => {
    expect(() => assertDisposableDatabase('postgresql://u@db.example.com/stock_test')).toThrow(
      'Refusing to reset',
    );
  });

  it('refuses a local database that is not a test database', () => {
    expect(() => assertDisposableDatabase('postgresql://u@localhost/postgres')).toThrow(
      'Refusing to reset',
    );
  });

  it('does not leak the password when it refuses', () => {
    const attempt = () =>
      assertDisposableDatabase(`postgresql://postgres:${PASSWORD}@db.example.com:5432/postgres`);

    expect(attempt).toThrow('Refusing to reset');
    expect(attempt).not.toThrow(PASSWORD);
  });
});

describe('confirming a migration (ADR 0010: an applied migration is not undone by itself)', () => {
  const remote = describeDatabaseTarget(
    'postgresql://postgres.abcdef@aws-0-sa-east-1.pooler.supabase.com:5432/postgres',
  );
  const local = describeDatabaseTarget('postgresql://stock@127.0.0.1:5433/stock_test');

  it('asks for confirmation when the database is not on this machine', () => {
    expect(requiresConfirmation(remote)).toBe(true);
  });

  it('does not ask when the database is local', () => {
    expect(requiresConfirmation(local)).toBe(false);
  });

  it('accepts the host typed back, in any case and with spaces around it', () => {
    expect(isConfirmed('  AWS-0-sa-east-1.pooler.supabase.com  ', remote)).toBe(true);
  });

  it.each(['', 'si', 'y', 'postgres', 'abcdef', 'aws-0-sa-east-1.pooler.supabase.co'])(
    'does not accept %j',
    (typed) => {
      expect(isConfirmed(typed, remote)).toBe(false);
    },
  );
});
