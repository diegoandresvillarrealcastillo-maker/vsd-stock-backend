import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applicationUrlOf } from '../../scripts/prepare-database.ts';
import { createPrismaClient } from '../../src/adapters/out/persistence/create-prisma-client.js';
import { PrismaUnitOfWork } from '../../src/adapters/out/persistence/prisma-unit-of-work.js';
import {
  ShiftAlreadyOpenError,
  ShiftClosedError,
  ShiftIdReusedError,
  ShiftNotFoundError,
} from '../../src/domain/model/shift-errors.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { createAdminPool } from './support/database.js';
import { BUSINESS_A, BUSINESS_B, resetData, seedBusiness } from './support/seed.js';
import { select } from './support/sql.js';

/**
 * Turnos y efectivo contra PostgreSQL (C3-02), con el rol real de la aplicacion: un turno abierto por dispositivo y por
 * persona, el cierre que pone todo de una vez, el arqueo que suma lo que la base tiene y el efectivo que entra y sale.
 */
describe('shifts and cash against PostgreSQL (C3-02)', () => {
  let admin: pg.Pool;
  let prisma: PrismaClient;
  let unitOfWork: PrismaUnitOfWork;
  let a: Awaited<ReturnType<typeof seedBusiness>>;
  let b: Awaited<ReturnType<typeof seedBusiness>>;
  let secondUser: string;

  beforeAll(() => {
    admin = createAdminPool(3);
    prisma = createPrismaClient(applicationUrlOf(process.env['TEST_DATABASE_URL']!), { max: 6 });
    unitOfWork = new PrismaUnitOfWork(prisma);
  });

  beforeEach(async () => {
    await resetData(admin);
    a = await seedBusiness(admin, BUSINESS_A);
    b = await seedBusiness(admin, BUSINESS_B);
    secondUser = randomUUID();
    await admin.query(
      `INSERT INTO app_user (id, id_negocio, auth_user_id, full_name, role)
       VALUES ($1, $2, $3, 'Cajera', 'cashier')`,
      [secondUser, BUSINESS_A, randomUUID()],
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await admin.end();
  });

  const shiftOf = (userId: string, deviceId: string, at = '2026-10-18T10:00:00.000Z') => ({
    id: randomUUID(),
    deviceId,
    userId,
    openedAt: new Date(at),
    openingAmount: 50_000,
  });

  const open = (businessId: string, shift: ReturnType<typeof shiftOf>) =>
    unitOfWork.inBusiness(businessId, (s) => s.shifts.open(shift));

  const close = (businessId: string, id: string, userId: string, at = '2026-10-18T14:00:00.000Z') =>
    unitOfWork.inBusiness(businessId, (s) =>
      s.shifts.close(id, {
        closedAt: new Date(at),
        closedByUserId: userId,
        countedAmount: 187_500,
      }),
    );

  describe('opening and closing', () => {
    it('opens a shift at the time it is given and finds it again', async () => {
      const shift = shiftOf(a.ownerId, a.deviceId);

      const opened = await open(BUSINESS_A, shift);

      expect(opened).toEqual({
        id: shift.id,
        deviceId: a.deviceId,
        userId: a.ownerId,
        openedAt: new Date('2026-10-18T10:00:00.000Z'),
        closedAt: null,
        closedByUserId: null,
        openingAmount: 50_000,
        countedAmount: null,
      });
      expect(await unitOfWork.inBusiness(BUSINESS_A, (s) => s.shifts.find(shift.id))).toEqual(
        opened,
      );
    });

    it('keeps the money as whole pesos, up to what the database accepts', async () => {
      const shift = { ...shiftOf(a.ownerId, a.deviceId), openingAmount: 1_000_000_000_000 };

      const opened = await open(BUSINESS_A, shift);

      expect(opened.openingAmount).toBe(1_000_000_000_000);
    });

    it('does not let a person open two shifts on the same device', async () => {
      await open(BUSINESS_A, shiftOf(a.ownerId, a.deviceId));

      await expect(open(BUSINESS_A, shiftOf(a.ownerId, a.deviceId))).rejects.toBeInstanceOf(
        ShiftAlreadyOpenError,
      );
      const rows = await select(admin, 'SELECT 1 FROM cash_shift WHERE id_negocio = $1', [
        BUSINESS_A,
      ]);
      expect(rows).toHaveLength(1);
    });

    it('lets two people take turns on a device, and one person use another device', async () => {
      const otherDevice = randomUUID();
      await admin.query(
        `INSERT INTO device (id, id_negocio, device_code, enrolled_by_user_id) VALUES ($1, $2, 'YY', $3)`,
        [otherDevice, BUSINESS_A, a.ownerId],
      );

      await open(BUSINESS_A, shiftOf(a.ownerId, a.deviceId));
      await open(BUSINESS_A, shiftOf(secondUser, a.deviceId));
      await open(BUSINESS_A, shiftOf(a.ownerId, otherDevice));

      const rows = await select(admin, 'SELECT 1 FROM cash_shift WHERE id_negocio = $1', [
        BUSINESS_A,
      ]);
      expect(rows).toHaveLength(3);
    });

    it('lets the same person open another one once the first is closed', async () => {
      const first = shiftOf(a.ownerId, a.deviceId);
      await open(BUSINESS_A, first);
      await close(BUSINESS_A, first.id, a.ownerId);

      await expect(
        open(BUSINESS_A, shiftOf(a.ownerId, a.deviceId, '2026-10-18T15:00:00.000Z')),
      ).resolves.toBeDefined();
    });

    it('lets only one of two opened at the same time win, and the other is told why', async () => {
      const results = await Promise.allSettled([
        open(BUSINESS_A, shiftOf(a.ownerId, a.deviceId)),
        open(BUSINESS_A, shiftOf(a.ownerId, a.deviceId)),
        open(BUSINESS_A, shiftOf(a.ownerId, a.deviceId)),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const result of results) {
        if (result.status === 'rejected') {
          expect(result.reason).toBeInstanceOf(ShiftAlreadyOpenError);
        }
      }
    });

    it('does not reuse the id of a shift, not even one of another business', async () => {
      const shift = shiftOf(a.ownerId, a.deviceId);
      await open(BUSINESS_A, shift);

      await expect(
        open(BUSINESS_A, { ...shiftOf(secondUser, a.deviceId), id: shift.id }),
      ).rejects.toBeInstanceOf(ShiftIdReusedError);
      await expect(
        open(BUSINESS_B, { ...shiftOf(b.ownerId, b.deviceId), id: shift.id }),
      ).rejects.toBeInstanceOf(ShiftIdReusedError);
    });

    it('closes it all at once: when, how much was counted and who closed it', async () => {
      const shift = shiftOf(a.ownerId, a.deviceId);
      await open(BUSINESS_A, shift);

      const closed = await close(BUSINESS_A, shift.id, secondUser);

      expect(closed).toMatchObject({
        id: shift.id,
        closedAt: new Date('2026-10-18T14:00:00.000Z'),
        closedByUserId: secondUser,
        countedAmount: 187_500,
      });
    });

    it('does not close it twice, and says so, without touching what the first closing wrote', async () => {
      const shift = shiftOf(a.ownerId, a.deviceId);
      await open(BUSINESS_A, shift);
      await close(BUSINESS_A, shift.id, a.ownerId);

      await expect(
        unitOfWork.inBusiness(BUSINESS_A, (s) =>
          s.shifts.close(shift.id, {
            closedAt: new Date('2026-10-18T16:00:00.000Z'),
            closedByUserId: secondUser,
            countedAmount: 1,
          }),
        ),
      ).rejects.toBeInstanceOf(ShiftClosedError);
      const found = await unitOfWork.inBusiness(BUSINESS_A, (s) => s.shifts.find(shift.id));
      expect(found).toMatchObject({ closedByUserId: a.ownerId, countedAmount: 187_500 });
    });

    it('does not close a shift that does not exist or is of another business', async () => {
      const shift = shiftOf(a.ownerId, a.deviceId);
      await open(BUSINESS_A, shift);

      await expect(close(BUSINESS_A, randomUUID(), a.ownerId)).rejects.toBeInstanceOf(
        ShiftNotFoundError,
      );
      await expect(close(BUSINESS_B, shift.id, b.ownerId)).rejects.toBeInstanceOf(
        ShiftNotFoundError,
      );
      expect(
        (await unitOfWork.inBusiness(BUSINESS_A, (s) => s.shifts.find(shift.id)))?.closedAt,
      ).toBeNull();
    });

    it('is protected by the database too: it can not be closed before it was opened, or half closed', async () => {
      const shift = shiftOf(a.ownerId, a.deviceId);
      await open(BUSINESS_A, shift);

      await expect(
        close(BUSINESS_A, shift.id, a.ownerId, '2026-10-18T09:00:00.000Z'),
      ).rejects.toThrow();
      await expect(
        admin.query('UPDATE cash_shift SET closed_at = now() WHERE id = $1', [shift.id]),
      ).rejects.toThrow(/cash_shift_closing_complete/);
    });
  });

  describe('listing and finding', () => {
    it('lists the newest first, in pages that follow the position, and keeps the businesses apart', async () => {
      const ids: string[] = [];
      for (const hour of ['09', '10', '11', '12', '13']) {
        // Una persona abre su turno y lo cierra antes de que otra abra el suyo: nunca hay dos abiertos de la misma.
        const person = hour === '10' || hour === '12' ? secondUser : a.ownerId;
        const shift = shiftOf(person, a.deviceId, `2026-10-18T${hour}:00:00.000Z`);
        await open(BUSINESS_A, shift);
        if (hour !== '13')
          await close(BUSINESS_A, shift.id, person, `2026-10-18T${hour}:30:00.000Z`);
        ids.push(shift.id);
      }
      await open(BUSINESS_B, shiftOf(b.ownerId, b.deviceId));

      const seen: string[] = [];
      let after: readonly [string, string] | undefined;
      for (;;) {
        const page = await unitOfWork.inBusiness(BUSINESS_A, (s) =>
          s.shifts.list({ limit: 2, ...(after === undefined ? {} : { after }) }),
        );
        expect(page.length).toBeLessThanOrEqual(2);
        seen.push(...page.map((shift) => shift.id));
        const last = page[page.length - 1];
        if (page.length < 2 || last === undefined) break;
        after = [last.openedAt.toISOString(), last.id];
      }

      expect(seen).toEqual([...ids].reverse());
    });

    it('filters by person and by open or closed', async () => {
      const mine = shiftOf(a.ownerId, a.deviceId, '2026-10-18T09:00:00.000Z');
      const theirs = shiftOf(secondUser, a.deviceId, '2026-10-18T10:00:00.000Z');
      await open(BUSINESS_A, mine);
      await open(BUSINESS_A, theirs);
      await close(BUSINESS_A, mine.id, a.ownerId, '2026-10-18T09:30:00.000Z');

      const list = (request: { userId?: string; open?: boolean }) =>
        unitOfWork.inBusiness(BUSINESS_A, async (s) =>
          (await s.shifts.list({ limit: 10, ...request })).map((shift) => shift.id),
        );

      expect(await list({ userId: secondUser })).toEqual([theirs.id]);
      expect(await list({ open: true })).toEqual([theirs.id]);
      expect(await list({ open: false })).toEqual([mine.id]);
      expect(await list({ userId: a.ownerId, open: true })).toEqual([]);
    });

    it('does not show the shifts of another business', async () => {
      const shift = shiftOf(a.ownerId, a.deviceId);
      await open(BUSINESS_A, shift);

      expect(await unitOfWork.inBusiness(BUSINESS_B, (s) => s.shifts.find(shift.id))).toBeNull();
      expect(await unitOfWork.inBusiness(BUSINESS_B, (s) => s.shifts.list({ limit: 10 }))).toEqual(
        [],
      );
    });
  });

  describe('the cash count', () => {
    /** Una venta ya hecha, con su operacion y sus cobros, escrita con la conexion de administracion. */
    const sell = async (
      shiftId: string,
      payments: { method: 'cash' | 'card' | 'transfer'; amount: number }[],
      occurredAt: string,
    ) => {
      const operationId = randomUUID();
      const saleId = randomUUID();
      await admin.query(
        `INSERT INTO operation (id_negocio, operation_id, kind, user_id, occurred_at)
         VALUES ($1, $2, 'sale', $3, $4)`,
        [BUSINESS_A, operationId, a.ownerId, occurredAt],
      );
      const total = payments.reduce((sum, payment) => sum + payment.amount, 0);
      await admin.query(
        `INSERT INTO sale (id, id_negocio, operation_id, shift_id, folio, folio_reported, total, needs_adjustment)
         VALUES ($1, $2, $3, $4, $5, $5, $6, false)`,
        [saleId, BUSINESS_A, operationId, shiftId, `ZZ-${randomUUID().slice(0, 6)}`, total],
      );
      for (const payment of payments) {
        await admin.query(
          'INSERT INTO payment (id_negocio, sale_id, method, amount) VALUES ($1, $2, $3, $4)',
          [BUSINESS_A, saleId, payment.method, payment.amount],
        );
      }
    };

    const move = (shiftId: string, direction: 'in' | 'out', amount: number) =>
      unitOfWork.inBusiness(BUSINESS_A, async (s) => {
        const operationId = randomUUID();
        await s.operations.claim({
          operationId,
          kind: 'cash_movement',
          userId: a.ownerId,
          fingerprint: operationId,
        });
        return s.cashMovements.create({
          operationId,
          shiftId,
          direction,
          amount,
          reason: 'Prueba',
        });
      });

    const totals = (shiftId: string) =>
      unitOfWork.inBusiness(BUSINESS_A, (s) => s.shifts.totals(shiftId));

    it('is all zeros for a shift that sold and moved nothing', async () => {
      const shift = shiftOf(a.ownerId, a.deviceId);
      await open(BUSINESS_A, shift);

      expect(await totals(shift.id)).toEqual({
        cashSales: 0,
        cashIn: 0,
        cashOut: 0,
        late: { count: 0, cashAmount: 0 },
      });
    });

    it('adds the cash of the sales only: a card or a transfer is not in the drawer', async () => {
      const shift = shiftOf(a.ownerId, a.deviceId);
      await open(BUSINESS_A, shift);
      await sell(shift.id, [{ method: 'cash', amount: 30_000 }], '2026-10-18T11:00:00.000Z');
      await sell(
        shift.id,
        [
          { method: 'cash', amount: 10_000 },
          { method: 'card', amount: 25_000 },
        ],
        '2026-10-18T12:00:00.000Z',
      );
      await sell(shift.id, [{ method: 'transfer', amount: 99_000 }], '2026-10-18T12:30:00.000Z');

      expect((await totals(shift.id)).cashSales).toBe(40_000);
    });

    it('adds what went in and out of the drawer apart from the sales', async () => {
      const shift = shiftOf(a.ownerId, a.deviceId);
      await open(BUSINESS_A, shift);
      await move(shift.id, 'in', 15_000);
      await move(shift.id, 'in', 5_000);
      await move(shift.id, 'out', 8_000);

      expect(await totals(shift.id)).toMatchObject({ cashIn: 20_000, cashOut: 8_000 });
    });

    it('keeps the sales that happened after the shift was closed apart, as late', async () => {
      const shift = shiftOf(a.ownerId, a.deviceId);
      await open(BUSINESS_A, shift);
      await sell(shift.id, [{ method: 'cash', amount: 30_000 }], '2026-10-18T11:00:00.000Z');
      await close(BUSINESS_A, shift.id, a.ownerId, '2026-10-18T14:00:00.000Z');
      await sell(shift.id, [{ method: 'cash', amount: 7_000 }], '2026-10-18T14:30:00.000Z');
      await sell(shift.id, [{ method: 'card', amount: 9_000 }], '2026-10-18T14:45:00.000Z');

      expect(await totals(shift.id)).toMatchObject({
        cashSales: 30_000,
        late: { count: 2, cashAmount: 7_000 },
      });
    });

    it('does not call late a sale made at the very moment the shift was closed', async () => {
      const shift = shiftOf(a.ownerId, a.deviceId);
      await open(BUSINESS_A, shift);
      await close(BUSINESS_A, shift.id, a.ownerId, '2026-10-18T14:00:00.000Z');
      await sell(shift.id, [{ method: 'cash', amount: 8_000 }], '2026-10-18T14:00:00.000Z');

      expect(await totals(shift.id)).toMatchObject({
        cashSales: 8_000,
        late: { count: 0, cashAmount: 0 },
      });
    });

    it('counts a late sale that was paid with nothing in the drawer, and a sale with no payment at all', async () => {
      const shift = shiftOf(a.ownerId, a.deviceId);
      await open(BUSINESS_A, shift);
      await sell(shift.id, [{ method: 'cash', amount: 5_000 }], '2026-10-18T11:00:00.000Z');
      await sell(shift.id, [], '2026-10-18T11:30:00.000Z');
      await close(BUSINESS_A, shift.id, a.ownerId, '2026-10-18T14:00:00.000Z');
      await sell(shift.id, [], '2026-10-18T15:00:00.000Z');

      expect(await totals(shift.id)).toMatchObject({
        cashSales: 5_000,
        late: { count: 1, cashAmount: 0 },
      });
    });

    it('counts a sale made before closing even if it only arrived afterwards', async () => {
      const shift = shiftOf(a.ownerId, a.deviceId);
      await open(BUSINESS_A, shift);
      await close(BUSINESS_A, shift.id, a.ownerId, '2026-10-18T14:00:00.000Z');
      await sell(shift.id, [{ method: 'cash', amount: 12_000 }], '2026-10-18T13:59:59.000Z');

      expect(await totals(shift.id)).toMatchObject({
        cashSales: 12_000,
        late: { count: 0, cashAmount: 0 },
      });
    });

    it('counts a shift only with its own sales and movements, never those of another shift', async () => {
      const mine = shiftOf(a.ownerId, a.deviceId);
      const theirs = shiftOf(secondUser, a.deviceId);
      await open(BUSINESS_A, mine);
      await open(BUSINESS_A, theirs);
      await sell(theirs.id, [{ method: 'cash', amount: 50_000 }], '2026-10-18T11:00:00.000Z');
      await move(theirs.id, 'out', 3_000);

      expect(await totals(mine.id)).toEqual({
        cashSales: 0,
        cashIn: 0,
        cashOut: 0,
        late: { count: 0, cashAmount: 0 },
      });
    });
  });

  describe('moving cash', () => {
    it('writes a movement and finds it again by its operation', async () => {
      const shift = shiftOf(a.ownerId, a.deviceId);
      await open(BUSINESS_A, shift);
      const operationId = randomUUID();

      const created = await unitOfWork.inBusiness(BUSINESS_A, async (s) => {
        await s.operations.claim({
          operationId,
          kind: 'cash_movement',
          userId: a.ownerId,
          fingerprint: 'x',
        });
        return s.cashMovements.create({
          operationId,
          shiftId: shift.id,
          direction: 'out',
          amount: 20_000,
          reason: 'Pago al proveedor',
        });
      });

      expect(created).toMatchObject({
        operationId,
        shiftId: shift.id,
        direction: 'out',
        amount: 20_000,
        reason: 'Pago al proveedor',
      });
      expect(
        await unitOfWork.inBusiness(BUSINESS_A, (s) =>
          s.cashMovements.findByOperation(operationId),
        ),
      ).toEqual(created);
      expect(
        await unitOfWork.inBusiness(BUSINESS_A, (s) =>
          s.cashMovements.findByOperation(randomUUID()),
        ),
      ).toBeNull();
    });

    it('does not show a movement to another business', async () => {
      const shift = shiftOf(a.ownerId, a.deviceId);
      await open(BUSINESS_A, shift);
      const operationId = randomUUID();
      await unitOfWork.inBusiness(BUSINESS_A, async (s) => {
        await s.operations.claim({
          operationId,
          kind: 'cash_movement',
          userId: a.ownerId,
          fingerprint: 'x',
        });
        await s.cashMovements.create({
          operationId,
          shiftId: shift.id,
          direction: 'in',
          amount: 1,
          reason: 'x',
        });
      });

      expect(
        await unitOfWork.inBusiness(BUSINESS_B, (s) =>
          s.cashMovements.findByOperation(operationId),
        ),
      ).toBeNull();
    });
  });

  describe('the operation behind a shift', () => {
    it('keeps the device, the effective time, the arrival time, what the device said and the flags', async () => {
      const operationId = randomUUID();

      await unitOfWork.inBusiness(BUSINESS_A, (s) =>
        s.operations.claim({
          operationId,
          kind: 'shift_open',
          userId: a.ownerId,
          fingerprint: 'x',
          deviceId: a.deviceId,
          times: {
            occurredAt: new Date('2026-10-18T14:59:54.000Z'),
            receivedAt: new Date('2026-10-18T15:00:00.000Z'),
            deviceTimeRaw: '2026-10-18T14:59:50.000Z',
            source: 'corrected',
            flags: ['clock-skew'],
          },
        }),
      );

      const [row] = await select(
        admin,
        `SELECT device_id, occurred_at, received_at, device_time_raw, time_source, time_flags
           FROM operation WHERE operation_id = $1`,
        [operationId],
      );
      expect(row).toMatchObject({
        device_id: a.deviceId,
        device_time_raw: '2026-10-18T14:59:50.000Z',
        time_source: 'corrected',
        time_flags: ['clock-skew'],
      });
      expect(new Date(row?.['occurred_at'] as string).toISOString()).toBe(
        '2026-10-18T14:59:54.000Z',
      );
      expect(new Date(row?.['received_at'] as string).toISOString()).toBe(
        '2026-10-18T15:00:00.000Z',
      );
    });

    it('keeps the defaults when nothing is said about the time or the device: the moment it arrived', async () => {
      const operationId = randomUUID();

      await unitOfWork.inBusiness(BUSINESS_A, (s) =>
        s.operations.claim({
          operationId,
          kind: 'adjustment',
          userId: a.ownerId,
          fingerprint: 'x',
        }),
      );

      const [row] = await select(
        admin,
        'SELECT device_id, device_time_raw, time_source, time_flags FROM operation WHERE operation_id = $1',
        [operationId],
      );
      expect(row).toEqual({
        device_id: null,
        device_time_raw: null,
        time_source: 'received',
        time_flags: [],
      });
    });
  });
});
