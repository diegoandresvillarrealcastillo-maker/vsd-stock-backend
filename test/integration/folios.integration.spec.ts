import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asApplication, createAdminPool } from './support/database.js';
import { enrollDevice, recordSale, type SaleArrival } from './support/folio-support.js';
import { BUSINESS_A, BUSINESS_B, resetData, seedBusiness } from './support/seed.js';

/**
 * Demuestra, contra un PostgreSQL real, lo que el ADR 0016 pide al servidor: dar a cada dispositivo de un
 * negocio un codigo distinto aunque se registren a la vez, aceptar siempre la venta que llega (tambien con un
 * folio repetido o con una hora ilegible) y fechar el dia del negocio con la hora de Colombia.
 */
describe('device codes, folios and operation time in the database (ADR 0016)', () => {
  let admin: pg.Pool;
  const RECEIVED = '2026-10-20T15:00:00.000Z';

  beforeAll(() => {
    admin = createAdminPool(16);
  });

  beforeEach(async () => {
    await resetData(admin);
    await seedBusiness(admin, BUSINESS_A);
    await seedBusiness(admin, BUSINESS_B);
  });

  afterAll(async () => {
    await admin.end();
  });

  const arrival = (overrides: Partial<SaleArrival> = {}): SaleArrival => ({
    businessId: BUSINESS_A,
    operationId: randomUUID(),
    folio: 'AA-000001',
    deviceTime: '2026-10-20T14:00:00.000Z',
    clockOffsetMs: 0,
    receivedAt: RECEIVED,
    ...overrides,
  });

  const salesOf = async (businessId = BUSINESS_A) =>
    (
      await admin.query<{ folio: string; folio_conflict: boolean }>(
        `SELECT folio, folio_conflict FROM sale WHERE id_negocio = $1 ORDER BY folio`,
        [businessId],
      )
    ).rows;

  describe('enrolling devices', () => {
    it('gives the first devices of a business AA, AB, AC...', async () => {
      const codes = [];
      for (let device = 0; device < 3; device += 1) {
        codes.push((await enrollDevice(admin, BUSINESS_A)).value);
      }

      expect(codes).toEqual(['AA', 'AB', 'AC']);
    });

    it('gives twenty-five devices that enroll at the same moment twenty-five different codes, without gaps', async () => {
      const codes = await Promise.all(
        Array.from({ length: 25 }, () => enrollDevice(admin, BUSINESS_A)),
      );

      const values = codes.map((code) => code.value);
      expect(new Set(values).size).toBe(25);
      expect([...values].sort()).toEqual(
        [
          'AA',
          'AB',
          'AC',
          'AD',
          'AE',
          'AF',
          'AG',
          'AH',
          'AJ',
          'AK',
          'AM',
          'AN',
          'AP',
          'AQ',
          'AR',
          'AS',
          'AT',
          'AV',
          'AW',
          'AX',
          'AY',
          'AZ',
          'A2',
          'A3',
          'A4',
        ].sort(),
      );
    });

    it('counts each business on its own, so two businesses may both have a device AA', async () => {
      expect((await enrollDevice(admin, BUSINESS_A)).value).toBe('AA');
      expect((await enrollDevice(admin, BUSINESS_B)).value).toBe('AA');
      expect((await enrollDevice(admin, BUSINESS_A)).value).toBe('AB');
    });

    it('never reuses a code, even when the database is asked to hand out the same one twice', async () => {
      await enrollDevice(admin, BUSINESS_A);

      await expect(
        asApplication(admin, BUSINESS_A, (client) =>
          client.query(`INSERT INTO device (id_negocio, device_code) VALUES ($1, 'AA')`, [
            BUSINESS_A,
          ]),
        ),
      ).rejects.toMatchObject({ code: '23505' });
    });
  });

  describe('receiving a sale', () => {
    it('stores the folio the device brought and the time resolved from its clock', async () => {
      const recorded = await recordSale(
        admin,
        arrival({
          deviceTime: '2026-10-20T13:00:00.000Z',
          clockOffsetMs: 3_600_000,
        }),
      );

      expect(recorded).toMatchObject({
        replayed: false,
        folio: 'AA-000001',
        folioConflict: false,
        occurredAt: '2026-10-20T14:00:00.000Z',
        timeFlags: ['clock-skew'],
      });
    });

    it('keeps the raw device time next to the one it resolved, so nothing is lost by correcting', async () => {
      await recordSale(
        admin,
        arrival({ deviceTime: '2026-10-20T13:00:00.000Z', clockOffsetMs: 3_600_000 }),
      );

      const { rows } = await admin.query<{ device_time_raw: string; time_source: string }>(
        `SELECT device_time_raw, time_source FROM operation`,
      );
      expect(rows).toEqual([
        { device_time_raw: '2026-10-20T13:00:00.000Z', time_source: 'corrected' },
      ]);
    });

    it('answers a resent sale with what it stored the first time, and stores nothing new', async () => {
      // Una venta con banderas de hora: lo que se guardo debe volver igual, banderas incluidas.
      const input = arrival({ deviceTime: '2026-10-20T20:00:00.000Z', clockOffsetMs: 1_800_000 });

      const first = await recordSale(admin, input);
      const again = await recordSale(admin, input);

      expect(first.timeFlags).toEqual(['clock-skew', 'future']);
      expect(again).toEqual({ ...first, replayed: true });
      expect(await salesOf()).toHaveLength(1);
    });

    it('accepts a sale whose folio belongs to another sale, under a folio that does not collide, and marks it', async () => {
      const original = arrival({ folio: 'AA-000142' });
      const clone = arrival({ folio: 'AA-000142' });

      const first = await recordSale(admin, original);
      const second = await recordSale(admin, clone);

      expect(first.folioConflict).toBe(false);
      expect(second.folioConflict).toBe(true);
      expect(second.folio).toBe(`AA-000142~${clone.operationId.slice(0, 8)}`);
      expect((await salesOf()).map((row) => row.folio).sort()).toEqual(
        ['AA-000142', second.folio].sort(),
      );
    });

    it('keeps the folio the device reported when it had to change it', async () => {
      await recordSale(admin, arrival({ folio: 'AA-000142' }));
      await recordSale(admin, arrival({ folio: 'AA-000142' }));

      const { rows } = await admin.query<{ folio_reported: string }>(
        `SELECT folio_reported FROM sale WHERE folio_conflict`,
      );
      expect(rows).toEqual([{ folio_reported: 'AA-000142' }]);
    });

    it('lets another business use the same folio without a conflict', async () => {
      await recordSale(admin, arrival({ businessId: BUSINESS_A, folio: 'AA-000001' }));
      const other = await recordSale(
        admin,
        arrival({ businessId: BUSINESS_B, folio: 'AA-000001' }),
      );

      expect(other.folioConflict).toBe(false);
      expect(other.folio).toBe('AA-000001');
    });

    it('accepts a sale whose device time cannot be read and dates it when the server heard of it', async () => {
      const recorded = await recordSale(admin, arrival({ deviceTime: 'ayer por la tarde' }));

      expect(recorded.occurredAt).toBe(RECEIVED);
      expect(recorded.timeFlags).toEqual(['unreadable']);
      expect(await salesOf()).toHaveLength(1);
    });

    it('accepts a sale dated in the future, clamps it to the moment the server heard of it and marks it', async () => {
      const recorded = await recordSale(
        admin,
        arrival({ deviceTime: '2026-10-21T09:00:00.000Z', clockOffsetMs: null }),
      );

      expect(recorded.occurredAt).toBe(RECEIVED);
      expect(recorded.timeFlags).toEqual(['clock-unverified', 'future']);
    });

    it('accepts a sale that waited for weeks and marks it as stale', async () => {
      const recorded = await recordSale(
        admin,
        arrival({ deviceTime: '2026-09-20T10:00:00.000Z', clockOffsetMs: 0 }),
      );

      expect(recorded.occurredAt).toBe('2026-09-20T10:00:00.000Z');
      expect(recorded.timeFlags).toEqual(['stale']);
    });
  });

  describe('the business day', () => {
    const dayOf = async (instant: string): Promise<string> => {
      const { rows } = await admin.query<{ day: string }>(
        `SELECT to_char((timestamptz '${instant}' AT TIME ZONE 'America/Bogota')::date, 'YYYY-MM-DD') AS day`,
      );
      return rows[0]!.day;
    };

    it('is the Colombian one: a sale at 22:30 in Bogota belongs to that day, though it is already tomorrow in UTC', async () => {
      expect(await dayOf('2026-10-21T03:30:00Z')).toBe('2026-10-20');
    });

    it('turns over at midnight in Bogota, five hours after UTC', async () => {
      expect(await dayOf('2026-10-21T04:59:59Z')).toBe('2026-10-20');
      expect(await dayOf('2026-10-21T05:00:00Z')).toBe('2026-10-21');
    });

    it('has no daylight saving time to move it during the year', async () => {
      expect(await dayOf('2026-01-15T04:59:59Z')).toBe('2026-01-14');
      expect(await dayOf('2026-07-15T04:59:59Z')).toBe('2026-07-14');
    });

    it('places a stored sale on the day of its resolved time, not of its arrival', async () => {
      await recordSale(
        admin,
        arrival({
          deviceTime: '2026-10-20T03:30:00.000Z',
          clockOffsetMs: 0,
          receivedAt: '2026-10-21T15:00:00.000Z',
        }),
      );

      const { rows } = await admin.query<{ day: string }>(
        `SELECT to_char((occurred_at AT TIME ZONE 'America/Bogota')::date, 'YYYY-MM-DD') AS day
           FROM operation`,
      );
      expect(rows).toEqual([{ day: '2026-10-19' }]);
    });
  });

  it('shows a business only its own sales', async () => {
    await recordSale(admin, arrival({ businessId: BUSINESS_A, folio: 'AA-000001' }));
    await recordSale(admin, arrival({ businessId: BUSINESS_B, folio: 'AB-000001' }));

    const seenByA = await asApplication(admin, BUSINESS_A, (client) =>
      client.query<{ folio: string }>(`SELECT folio FROM sale`),
    );

    expect(seenByA.rows.map((row) => row.folio)).toEqual(['AA-000001']);
  });
});
