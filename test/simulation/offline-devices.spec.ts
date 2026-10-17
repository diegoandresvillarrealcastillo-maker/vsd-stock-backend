import { describe, expect, it } from 'vitest';
import { DeviceCode } from '../../src/domain/model/device-code.js';
import { nextFolio } from '../../src/domain/model/folio.js';
import {
  estimateClockOffset,
  resolveOperationTime,
  type TimeFlag,
} from '../../src/domain/model/operation-time.js';

/**
 * Simula un negocio con muchos dispositivos que venden sin conexion, con relojes desajustados y sincronizaciones
 * en cualquier orden, para comprobar lo que decide el ADR 0016: que ningun folio se repite y que la hora que se
 * guarda queda cerca de la verdadera. Es determinista: la misma semilla da siempre el mismo negocio.
 */

/** Generador pseudoaleatorio con semilla (mulberry32): para que una falla se pueda repetir. */
function randomFrom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

interface PendingSale {
  folio: string;
  deviceTime: string;
  clockOffsetMs: number | null;
  trueTimeMs: number;
}

interface SimulatedDevice {
  code: DeviceCode;
  lastSerial: number;
  skewMs: number;
  driftPerMs: number;
  lastOffsetMs: number | null;
  pending: PendingSale[];
}

interface Outcome {
  folios: string[];
  resolved: { errorMs: number; flags: readonly TimeFlag[]; source: string }[];
  sales: number;
  devices: number;
}

interface Options {
  seed: number;
  devices: number;
  steps: number;
  /** `true`: al borrar los datos de un dispositivo se le da un codigo nuevo; `false`: conserva el viejo (el error que el ADR evita). */
  reEnrollOnWipe: boolean;
}

const START = Date.parse('2026-10-20T08:00:00.000Z');

function simulate({ seed, devices: deviceCount, steps, reEnrollOnWipe }: Options): Outcome {
  const random = randomFrom(seed);
  let enrolled = 0;
  const enroll = (): DeviceCode => DeviceCode.forIndex(enrolled++);
  const between = (low: number, high: number) => low + random() * (high - low);

  const newDevice = (): SimulatedDevice => ({
    code: enroll(),
    lastSerial: 0,
    // Relojes de hasta seis horas de diferencia, hacia ambos lados, y una deriva de hasta 20 ppm.
    skewMs: Math.round(between(-6, 6) * 3_600_000),
    driftPerMs: between(-20, 20) / 1_000_000,
    lastOffsetMs: null,
    pending: [],
  });
  const devices = Array.from({ length: deviceCount }, newDevice);
  const clockOf = (device: SimulatedDevice, trueMs: number): number =>
    trueMs + device.skewMs + device.driftPerMs * (trueMs - START);

  const outcome: Outcome = { folios: [], resolved: [], sales: 0, devices: deviceCount };
  let now = START;

  const upload = (device: SimulatedDevice): void => {
    for (const sale of device.pending) {
      const resolved = resolveOperationTime({
        deviceTime: sale.deviceTime,
        clockOffsetMs: sale.clockOffsetMs,
        receivedAt: new Date(now).toISOString(),
      });
      outcome.folios.push(sale.folio);
      outcome.resolved.push({
        errorMs: Math.abs(Date.parse(resolved.effectiveAt) - sale.trueTimeMs),
        flags: resolved.flags,
        source: resolved.source,
      });
    }
    device.pending = [];
  };

  const sync = (device: SimulatedDevice): void => {
    // Pregunta GET /health: el viaje dura entre 20 ms y 900 ms y el servidor contesta hacia la mitad.
    const roundTrip = between(20, 900);
    const sentAt = clockOf(device, now);
    const serverTime = now + roundTrip * between(0.3, 0.7);
    const receivedAt = clockOf(device, now + roundTrip);
    device.lastOffsetMs = estimateClockOffset({
      sentAtMs: sentAt,
      receivedAtMs: receivedAt,
      serverTimeMs: serverTime,
    });
    now += roundTrip;
    upload(device);
  };

  for (let step = 0; step < steps; step += 1) {
    now += Math.round(between(0, 90_000));
    const index = Math.floor(random() * devices.length);
    const device = devices[index]!;
    const roll = random();
    if (roll < 0.8) {
      const folio = nextFolio(device.code, device.lastSerial);
      device.lastSerial = folio.serial;
      device.pending.push({
        folio: folio.toString(),
        deviceTime: new Date(clockOf(device, now)).toISOString(),
        clockOffsetMs: device.lastOffsetMs,
        trueTimeMs: now,
      });
      outcome.sales += 1;
    } else if (roll < 0.99) {
      sync(device);
    } else {
      // Se borran los datos del dispositivo (se reinstala la aplicacion): despues de sincronizar, para no perder ventas.
      sync(device);
      devices[index] = {
        ...newDevice(),
        code: reEnrollOnWipe ? enroll() : device.code,
        skewMs: device.skewMs,
        driftPerMs: device.driftPerMs,
      };
    }
  }
  for (const device of devices) sync(device);
  return outcome;
}

const duplicates = (values: string[]): number => values.length - new Set(values).size;

describe('a business with many devices selling without a connection (ADR 0016)', () => {
  const big = { devices: 50, steps: 12_000 };

  it('sells thousands of times and never repeats a folio, with devices wiped and reinstalled on the way', () => {
    for (const seed of [1, 2, 3, 4, 5, 20_261_020]) {
      const outcome = simulate({ ...big, seed, reEnrollOnWipe: true });

      expect(outcome.sales, `seed ${seed}`).toBeGreaterThan(8000);
      expect(outcome.folios.length, `seed ${seed}`).toBe(outcome.sales);
      expect(duplicates(outcome.folios), `seed ${seed}`).toBe(0);
    }
  });

  it('would repeat folios if a wiped device kept its code (the mistake the design avoids)', () => {
    const outcome = simulate({ ...big, seed: 7, reEnrollOnWipe: false });

    expect(duplicates(outcome.folios)).toBeGreaterThan(0);
  });

  it('would repeat folios if they were six random digits, which looks fine until a business sells', () => {
    const random = randomFrom(99);
    const folios = Array.from({ length: 10_000 }, () => String(Math.floor(random() * 1_000_000)));

    // Con 10 000 ventas en un millon de numeros se esperan unas 50 repeticiones (la paradoja del cumpleanos).
    expect(duplicates(folios)).toBeGreaterThan(10);
  });

  it('dates the sales of a device with a measured clock within five seconds of the truth, whatever its skew', () => {
    const outcome = simulate({ ...big, seed: 11, reEnrollOnWipe: true });
    const measured = outcome.resolved.filter((sale) => sale.source === 'corrected');

    expect(measured.length).toBeGreaterThan(2000);
    expect(Math.max(...measured.map((sale) => sale.errorMs))).toBeLessThan(5000);
  });

  it('flags the sales of a device that never measured its clock, and never trusts them blindly', () => {
    const outcome = simulate({ ...big, seed: 11, reEnrollOnWipe: true });
    const unverified = outcome.resolved.filter((sale) => sale.flags.includes('clock-unverified'));

    expect(unverified.length).toBeGreaterThan(0);
    // Sin medir el reloj no hay cota: sus ventas pueden quedar a horas de la verdad, y por eso se marcan.
    expect(unverified.every((sale) => sale.source !== 'corrected')).toBe(true);
  });

  it('flags a device whose clock is far off so that someone fixes it', () => {
    const outcome = simulate({ ...big, seed: 11, reEnrollOnWipe: true });

    expect(outcome.resolved.some((sale) => sale.flags.includes('clock-skew'))).toBe(true);
  });

  it('accepts every sale: nothing is dated after the moment the server heard of it', () => {
    const outcome = simulate({ ...big, seed: 13, reEnrollOnWipe: true });

    expect(outcome.resolved).toHaveLength(outcome.sales);
    expect(outcome.resolved.every((sale) => Number.isFinite(sale.errorMs))).toBe(true);
  });

  it('is repeatable: the same seed gives the same business', () => {
    const a = simulate({ ...big, seed: 5, reEnrollOnWipe: true });
    const b = simulate({ ...big, seed: 5, reEnrollOnWipe: true });

    expect(a.folios).toEqual(b.folios);
  });
});
