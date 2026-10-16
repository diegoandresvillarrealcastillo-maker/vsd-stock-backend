import { describe, expect, it } from 'vitest';
import { createHealthReport } from './health-report.js';

describe('createHealthReport', () => {
  it('reports status ok with the given instant as an ISO 8601 string in UTC', () => {
    const report = createHealthReport(new Date('2026-10-16T15:30:00.000Z'));

    expect(report).toEqual({ status: 'ok', timestamp: '2026-10-16T15:30:00.000Z' });
  });

  it('rejects an invalid date instead of reporting a meaningless timestamp', () => {
    expect(() => createHealthReport(new Date('not a date'))).toThrow(RangeError);
  });
});
