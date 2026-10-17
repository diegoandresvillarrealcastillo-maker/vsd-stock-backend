import { describe, expect, it } from 'vitest';
import { createReadinessReport } from './readiness-report.js';

describe('createReadinessReport', () => {
  const now = new Date('2026-10-17T15:30:00.000Z');

  it('is ok only when the database answers', () => {
    expect(createReadinessReport(now, 'up')).toEqual({
      status: 'ok',
      database: 'up',
      timestamp: '2026-10-17T15:30:00.000Z',
    });
  });

  it('is unavailable when the database does not answer', () => {
    expect(createReadinessReport(now, 'down')).toEqual({
      status: 'unavailable',
      database: 'down',
      timestamp: '2026-10-17T15:30:00.000Z',
    });
  });

  it('is unavailable when no database was configured, and says so', () => {
    expect(createReadinessReport(now, 'not-configured')).toMatchObject({
      status: 'unavailable',
      database: 'not-configured',
    });
  });

  it('rejects an invalid date instead of reporting a meaningless timestamp', () => {
    expect(() => createReadinessReport(new Date('not a date'), 'up')).toThrow(RangeError);
  });
});
