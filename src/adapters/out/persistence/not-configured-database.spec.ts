import { describe, expect, it } from 'vitest';
import { DatabaseNotConfiguredError } from '../../../domain/model/database-not-configured-error.js';
import { NotConfiguredDatabase } from './not-configured-database.js';

describe('NotConfiguredDatabase', () => {
  it('says that there is no database, instead of pretending to be one', async () => {
    expect(await new NotConfiguredDatabase().check()).toBe('not-configured');
  });

  it('refuses any work in a business, and says what is missing', async () => {
    const attempt = new NotConfiguredDatabase().inBusiness(
      '11111111-1111-4111-8111-111111111111',
      () => Promise.resolve('trabajo hecho'),
    );

    await expect(attempt).rejects.toBeInstanceOf(DatabaseNotConfiguredError);
    await expect(attempt).rejects.toThrow('DATABASE_URL');
  });

  it('never runs the work it was given', async () => {
    let ran = false;

    await new NotConfiguredDatabase()
      .inBusiness('11111111-1111-4111-8111-111111111111', () => {
        ran = true;
        return Promise.resolve();
      })
      .catch(() => undefined);

    expect(ran).toBe(false);
  });

  it('has nobody to look up: asking who a person is also says that the database is missing', async () => {
    const attempt = new NotConfiguredDatabase().findMembership(
      '11111111-1111-4111-8111-111111111111',
    );

    await expect(attempt).rejects.toBeInstanceOf(DatabaseNotConfiguredError);
  });
});
