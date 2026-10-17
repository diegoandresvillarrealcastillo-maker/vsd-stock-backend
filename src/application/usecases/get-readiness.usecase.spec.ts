import { describe, expect, it } from 'vitest';
import type { Clock } from '../../domain/ports/out/clock.js';
import type { DatabaseHealth, DatabaseStatus } from '../../domain/ports/out/database-health.js';
import { GetReadinessUseCase } from './get-readiness.usecase.js';

const clock: Clock = { now: () => new Date('2026-10-17T15:30:00.000Z') };

const databaseThatSays = (status: DatabaseStatus): DatabaseHealth => ({
  check: () => Promise.resolve(status),
});

describe('GetReadinessUseCase', () => {
  it('reports ok when the database answers', async () => {
    const useCase = new GetReadinessUseCase(clock, databaseThatSays('up'));

    expect(await useCase.execute()).toEqual({
      status: 'ok',
      database: 'up',
      timestamp: '2026-10-17T15:30:00.000Z',
    });
  });

  it.each<DatabaseStatus>(['down', 'not-configured'])(
    'reports unavailable when the database is %s',
    async (status) => {
      const report = await new GetReadinessUseCase(clock, databaseThatSays(status)).execute();

      expect(report).toMatchObject({ status: 'unavailable', database: status });
    },
  );

  it('asks the database on every call', async () => {
    let asked = 0;
    const database: DatabaseHealth = {
      check: () => {
        asked += 1;
        return Promise.resolve('up');
      },
    };
    const useCase = new GetReadinessUseCase(clock, database);

    await useCase.execute();
    await useCase.execute();

    expect(asked).toBe(2);
  });

  it('reports a database that throws as down: a failing check is never ready', async () => {
    const broken: DatabaseHealth = { check: () => Promise.reject(new Error('boom')) };

    const report = await new GetReadinessUseCase(clock, broken).execute();

    expect(report).toMatchObject({ status: 'unavailable', database: 'down' });
  });
});
