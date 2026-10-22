import { describe, expect, it } from 'vitest';
import { SystemClock } from './system-clock.js';

describe('SystemClock', () => {
  it('returns the current instant of the machine', () => {
    const before = Date.now();

    const instant = new SystemClock().now().getTime();

    expect(instant).toBeGreaterThanOrEqual(before);
    expect(instant).toBeLessThanOrEqual(Date.now());
  });
});
