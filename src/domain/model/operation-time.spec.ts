import { describe, expect, it } from 'vitest';
import {
  MAX_ROUND_TRIP_MS,
  SKEW_WARNING_MS,
  STALE_AFTER_MS,
  estimateClockOffset,
  resolveOperationTime,
} from './operation-time.js';

const SERVER = '2026-10-20T15:00:00.000Z';
const at = (iso: string): number => Date.parse(iso);

describe('estimateClockOffset', () => {
  it('is how far the server clock is ahead of the device clock, taken at the middle of the round trip', () => {
    // El dispositivo preguntó a las 10:00:00.000 y oyó la respuesta a las 10:00:00.200;
    // el servidor dijo 10:05:00.100. A mitad del viaje (10:00:00.100) el servidor iba 5 minutos adelante.
    const offset = estimateClockOffset({
      sentAtMs: at('2026-10-20T10:00:00.000Z'),
      receivedAtMs: at('2026-10-20T10:00:00.200Z'),
      serverTimeMs: at('2026-10-20T10:05:00.100Z'),
    });

    expect(offset).toBe(300_000);
  });

  it('is negative when the device clock is ahead', () => {
    const offset = estimateClockOffset({
      sentAtMs: at('2026-10-20T10:00:00.000Z'),
      receivedAtMs: at('2026-10-20T10:00:00.100Z'),
      serverTimeMs: at('2026-10-20T09:00:00.050Z'),
    });

    expect(offset).toBe(-3_600_000);
  });

  it('is zero when both clocks agree', () => {
    expect(estimateClockOffset({ sentAtMs: 1000, receivedAtMs: 1200, serverTimeMs: 1100 })).toBe(0);
  });

  it('rounds to a whole millisecond', () => {
    const offset = estimateClockOffset({ sentAtMs: 1000, receivedAtMs: 1001, serverTimeMs: 1001 });

    expect(Number.isInteger(offset)).toBe(true);
  });

  it('is unknown when the round trip was too slow to trust', () => {
    expect(
      estimateClockOffset({
        sentAtMs: 0,
        receivedAtMs: MAX_ROUND_TRIP_MS + 1,
        serverTimeMs: 1000,
      }),
    ).toBeNull();
  });

  it('trusts a round trip of exactly the limit', () => {
    expect(
      estimateClockOffset({
        sentAtMs: 0,
        receivedAtMs: MAX_ROUND_TRIP_MS,
        serverTimeMs: MAX_ROUND_TRIP_MS / 2,
      }),
    ).toBe(0);
  });

  it('is unknown when the response seems to arrive before the request left', () => {
    expect(
      estimateClockOffset({ sentAtMs: 2000, receivedAtMs: 1000, serverTimeMs: 1500 }),
    ).toBeNull();
  });

  it('is unknown when a measurement is not a finite number', () => {
    expect(
      estimateClockOffset({ sentAtMs: Number.NaN, receivedAtMs: 1, serverTimeMs: 1 }),
    ).toBeNull();
    expect(
      estimateClockOffset({ sentAtMs: 0, receivedAtMs: 1, serverTimeMs: Number.POSITIVE_INFINITY }),
    ).toBeNull();
  });
});

describe('resolveOperationTime', () => {
  it('moves the device time by the measured offset', () => {
    // El reloj del dispositivo atrasa una hora; el servidor lo mide: +1 h.
    const resolved = resolveOperationTime({
      deviceTime: '2026-10-20T13:50:00.000Z',
      clockOffsetMs: 3_600_000,
      receivedAt: SERVER,
    });

    expect(resolved.effectiveAt).toBe('2026-10-20T14:50:00.000Z');
    expect(resolved.source).toBe('corrected');
  });

  it('corrects by a small offset too: there is no tolerance to hide behind', () => {
    const resolved = resolveOperationTime({
      deviceTime: '2026-10-20T14:00:00.000Z',
      clockOffsetMs: 750,
      receivedAt: SERVER,
    });

    expect(resolved.effectiveAt).toBe('2026-10-20T14:00:00.750Z');
    expect(resolved.flags).toEqual([]);
  });

  it('keeps the device time when both clocks agree', () => {
    const resolved = resolveOperationTime({
      deviceTime: '2026-10-20T14:00:00.000Z',
      clockOffsetMs: 0,
      receivedAt: SERVER,
    });

    expect(resolved).toEqual({
      effectiveAt: '2026-10-20T14:00:00.000Z',
      source: 'corrected',
      flags: [],
    });
  });

  it('flags a device whose clock is off by more than five minutes, so someone fixes it', () => {
    const resolved = resolveOperationTime({
      deviceTime: '2026-10-20T13:00:00.000Z',
      clockOffsetMs: SKEW_WARNING_MS + 1,
      receivedAt: SERVER,
    });

    expect(resolved.flags).toEqual(['clock-skew']);
  });

  it('does not flag an offset of exactly five minutes, in either direction', () => {
    for (const clockOffsetMs of [SKEW_WARNING_MS, -SKEW_WARNING_MS]) {
      const resolved = resolveOperationTime({
        deviceTime: '2026-10-20T14:00:00.000Z',
        clockOffsetMs,
        receivedAt: SERVER,
      });

      expect(resolved.flags, String(clockOffsetMs)).toEqual([]);
    }
  });

  it('flags a device clock that is ahead as well', () => {
    const resolved = resolveOperationTime({
      // El reloj del dispositivo va 10 minutos adelantado: dice 14:50 cuando son las 14:40.
      deviceTime: '2026-10-20T14:50:00.000Z',
      clockOffsetMs: -10 * 60 * 1000,
      receivedAt: SERVER,
    });

    expect(resolved.effectiveAt).toBe('2026-10-20T14:40:00.000Z');
    expect(resolved.flags).toEqual(['clock-skew']);
  });

  it('keeps the device time and says so when the offset was never measured', () => {
    const resolved = resolveOperationTime({
      deviceTime: '2026-10-20T14:00:00.000Z',
      clockOffsetMs: null,
      receivedAt: SERVER,
    });

    expect(resolved).toEqual({
      effectiveAt: '2026-10-20T14:00:00.000Z',
      source: 'device',
      flags: ['clock-unverified'],
    });
  });

  it('never dates an operation after the moment the server heard of it', () => {
    const resolved = resolveOperationTime({
      deviceTime: '2026-10-20T18:00:00.000Z',
      clockOffsetMs: null,
      receivedAt: SERVER,
    });

    expect(resolved.effectiveAt).toBe(SERVER);
    expect(resolved.source).toBe('received');
    expect(resolved.flags).toEqual(['clock-unverified', 'future']);
  });

  it('accepts an operation dated exactly when the server heard of it', () => {
    const resolved = resolveOperationTime({
      deviceTime: SERVER,
      clockOffsetMs: 0,
      receivedAt: SERVER,
    });

    expect(resolved.effectiveAt).toBe(SERVER);
    expect(resolved.source).toBe('corrected');
    expect(resolved.flags).toEqual([]);
  });

  it('flags an operation that waited more than three days, and keeps it', () => {
    const old = new Date(at(SERVER) - STALE_AFTER_MS - 1000).toISOString();

    const resolved = resolveOperationTime({
      deviceTime: old,
      clockOffsetMs: 0,
      receivedAt: SERVER,
    });

    expect(resolved.effectiveAt).toBe(old);
    expect(resolved.flags).toEqual(['stale']);
  });

  it('does not flag an operation that waited exactly three days', () => {
    const old = new Date(at(SERVER) - STALE_AFTER_MS).toISOString();

    expect(
      resolveOperationTime({ deviceTime: old, clockOffsetMs: 0, receivedAt: SERVER }).flags,
    ).toEqual([]);
  });

  it('falls back to the moment the server heard of it, and says so, when the device time is unreadable', () => {
    for (const deviceTime of [
      '',
      'ayer',
      '2026-13-45T99:99:99Z',
      'null',
      // Formatos que Date.parse adivina y aqui no se aceptan: el dispositivo manda ISO 8601 UTC con Z.
      '2026-10-20',
      '2026-10-20T14:00:00',
      '2026-10-20T14:00:00+05:00',
      'Tue, 20 Oct 2026 14:00:00 GMT',
      'October 20, 2026 14:00',
      '1792504800000',
    ]) {
      const resolved = resolveOperationTime({ deviceTime, clockOffsetMs: 0, receivedAt: SERVER });

      expect(resolved, deviceTime).toEqual({
        effectiveAt: SERVER,
        source: 'received',
        flags: ['unreadable'],
      });
    }
  });

  it('never rejects: an operation is always given a time', () => {
    const inputs = [
      { deviceTime: 'basura', clockOffsetMs: null },
      { deviceTime: '1970-01-01T00:00:00.000Z', clockOffsetMs: null },
      { deviceTime: '2999-01-01T00:00:00.000Z', clockOffsetMs: 5 },
      { deviceTime: '2026-10-20T14:00:00.000Z', clockOffsetMs: Number.NaN },
      { deviceTime: '2026-10-20T14:00:00.000Z', clockOffsetMs: Number.POSITIVE_INFINITY },
    ];
    for (const input of inputs) {
      const resolved = resolveOperationTime({ ...input, receivedAt: SERVER });

      expect(Number.isNaN(Date.parse(resolved.effectiveAt)), input.deviceTime).toBe(false);
      expect(Date.parse(resolved.effectiveAt)).toBeLessThanOrEqual(at(SERVER));
    }
  });

  it('treats an offset that is not a finite number as unknown', () => {
    const resolved = resolveOperationTime({
      deviceTime: '2026-10-20T14:00:00.000Z',
      clockOffsetMs: Number.NaN,
      receivedAt: SERVER,
    });

    expect(resolved.source).toBe('device');
    expect(resolved.flags).toEqual(['clock-unverified']);
  });

  it('lists several flags in alphabetical order', () => {
    const resolved = resolveOperationTime({
      deviceTime: '2026-10-20T20:00:00.000Z',
      clockOffsetMs: 3 * SKEW_WARNING_MS,
      receivedAt: SERVER,
    });

    expect(resolved.flags).toEqual(['clock-skew', 'future']);
  });

  it('works when the server time itself cannot be read: it refuses, because there is nothing to compare', () => {
    expect(() =>
      resolveOperationTime({
        deviceTime: '2026-10-20T14:00:00.000Z',
        clockOffsetMs: 0,
        receivedAt: 'no es una fecha',
      }),
    ).toThrow(RangeError);
  });
});
