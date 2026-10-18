import { describe, expect, it } from 'vitest';
import { encodeCursor } from '../../domain/model/pagination.js';
import { ForbiddenError, NoMembershipError } from '../../domain/model/people-errors.js';
import { OperationIdReusedError } from '../../domain/model/purchase-errors.js';
import {
  ShiftAlreadyOpenError,
  ShiftClosedError,
  ShiftIdReusedError,
  ShiftNotFoundError,
} from '../../domain/model/shift-errors.js';
import { ValidationFailedError } from '../../domain/model/validation.js';
import { UserInactiveError, type Session } from '../../domain/ports/in/authenticate.js';
import type { Role } from '../../domain/model/role.js';
import type { Clock } from '../../domain/ports/out/clock.js';
import { FakeCash } from '../../../test/support/fake-cash.js';
import { FakeDevices } from '../../../test/support/fake-devices.js';
import { FakePeople, fakeUnitOfWork } from '../../../test/support/fake-people.js';
import { FakePurchasing } from '../../../test/support/fake-purchasing.js';
import {
  ACTOR_ID,
  BUSINESS_ID,
  loneSession,
  memberSession,
} from '../../../test/support/sessions.js';
import { ShiftsUseCase } from './shifts.usecase.js';

const NOW = new Date('2026-10-18T15:00:00.000Z');
const clock: Clock = { now: () => NOW };

const DEVICE = '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f';
const SHIFT = '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e';
const SHIFT_2 = '3d4e5f6a-7b8c-4d9e-8f0a-2b3c4d5e6f7a';
const OP_OPEN = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const OP_CLOSE = '4e5f6a7b-8c9d-4e0f-9a1b-3c4d5e6f7a8b';
const OP_OTHER = '5f6a7b8c-9d0e-4f1a-8b2c-4d5e6f7a8b9c';
const OP_THIRD = '6b7c8d9e-0f1a-4b2c-9d3e-5f6a7b8c9d0e';
const OTHER_USER = '77777777-7777-4777-8777-777777777777';
const UNKNOWN = '99999999-9999-4999-8999-999999999999';

/** La misma sesion de un negocio, pero de otra persona. */
const asPerson = (role: Role, userId: string): Session => {
  const base = memberSession(role);
  return { ...base, membership: { ...base.membership!, userId } };
};

const setup = async () => {
  const devices = new FakeDevices();
  await devices.register({ id: DEVICE, name: null }, ACTOR_ID);
  const purchasing = new FakePurchasing();
  const cash = new FakeCash();
  const work = fakeUnitOfWork(new FakePeople(), 'Tienda', undefined, purchasing, devices, cash);
  return { devices, purchasing, cash, work, useCase: new ShiftsUseCase(work, clock) };
};

const opening = (change: Record<string, unknown> = {}) => ({
  operationId: OP_OPEN,
  shiftId: SHIFT,
  deviceId: DEVICE,
  openingAmount: 50_000,
  deviceTime: '2026-10-18T14:59:50.000Z',
  clockOffsetMs: 4000,
  ...change,
});

const closing = (change: Record<string, unknown> = {}) => ({
  operationId: OP_CLOSE,
  countedAmount: 175_000,
  deviceTime: '2026-10-18T14:59:55.000Z',
  clockOffsetMs: 0,
  ...change,
});

const codes = (failure: unknown) =>
  (failure as ValidationFailedError).errors.map((e) => `${e.pointer}:${e.code}`);

describe('ShiftsUseCase', () => {
  describe('opening a shift', () => {
    it('opens it for the person who asks, on the device, with the cash they start with', async () => {
      const { useCase } = await setup();

      const { shift, replayed } = await useCase.open(memberSession('cashier'), opening());

      expect(replayed).toBe(false);
      expect(shift).toMatchObject({
        id: SHIFT,
        deviceId: DEVICE,
        userId: ACTOR_ID,
        openingAmount: 50_000,
        closedAt: null,
        closedByUserId: null,
        countedAmount: null,
      });
      expect(shift.summary).toMatchObject({
        openingAmount: 50_000,
        expectedAmount: 50_000,
        countedAmount: null,
        difference: null,
      });
    });

    it('is open to the three roles and works inside the business of the person', async () => {
      const { work, useCase } = await setup();

      await useCase.open(
        memberSession('owner'),
        opening({ operationId: OP_OTHER, shiftId: SHIFT_2 }),
      );
      await useCase.open(asPerson('admin', OTHER_USER), opening());

      expect(work.openedFor).toEqual([BUSINESS_ID, BUSINESS_ID]);
    });

    it('says it opened when the clock of the device, corrected, says it did', async () => {
      const { useCase } = await setup();

      const { shift } = await useCase.open(memberSession('cashier'), opening());

      expect(shift.openedAt).toEqual(new Date('2026-10-18T14:59:54.000Z'));
    });

    it('records the operation with its device and the times, so the clock can be reviewed later', async () => {
      const { purchasing, useCase } = await setup();

      await useCase.open(memberSession('cashier'), opening({ clockOffsetMs: null }));

      const claim = purchasing.operations.claims.get(OP_OPEN)?.request;
      expect(claim).toMatchObject({
        operationId: OP_OPEN,
        kind: 'shift_open',
        userId: ACTOR_ID,
        deviceId: DEVICE,
      });
      expect(claim?.times).toEqual({
        occurredAt: new Date('2026-10-18T14:59:50.000Z'),
        receivedAt: NOW,
        deviceTimeRaw: '2026-10-18T14:59:50.000Z',
        source: 'device',
        flags: ['clock-unverified'],
      });
    });

    it('answers a repeated opening with the same shift and opens nothing else', async () => {
      const { cash, useCase } = await setup();
      const first = await useCase.open(memberSession('cashier'), opening());

      const again = await useCase.open(memberSession('cashier'), opening({ clockOffsetMs: 100 }));

      expect(again.replayed).toBe(true);
      expect(again.shift).toEqual(first.shift);
      expect(cash.shifts.records).toHaveLength(1);
    });

    it('refuses the same operation id with another body, and opens nothing', async () => {
      const { cash, useCase } = await setup();
      await useCase.open(memberSession('cashier'), opening());

      await expect(
        useCase.open(memberSession('cashier'), opening({ openingAmount: 60_000 })),
      ).rejects.toBeInstanceOf(OperationIdReusedError);
      expect(cash.shifts.records).toHaveLength(1);
      expect(cash.shifts.records[0]?.openingAmount).toBe(50_000);
    });

    it('does not open a second shift for the same person on the same device', async () => {
      const { cash, useCase } = await setup();
      await useCase.open(memberSession('cashier'), opening());

      await expect(
        useCase.open(
          memberSession('cashier'),
          opening({ operationId: OP_OTHER, shiftId: SHIFT_2 }),
        ),
      ).rejects.toBeInstanceOf(ShiftAlreadyOpenError);
      expect(cash.shifts.records).toHaveLength(1);
    });

    it('lets two people take turns on a device: each has their own open shift', async () => {
      const { cash, useCase } = await setup();
      await useCase.open(memberSession('cashier'), opening());

      await useCase.open(
        asPerson('cashier', OTHER_USER),
        opening({ operationId: OP_OTHER, shiftId: SHIFT_2 }),
      );

      expect(cash.shifts.records.map((shift) => shift.userId)).toEqual([ACTOR_ID, OTHER_USER]);
    });

    it('lets the same person open another shift once the first one is closed', async () => {
      const { cash, useCase } = await setup();
      await useCase.open(memberSession('cashier'), opening());
      await useCase.close(memberSession('cashier'), SHIFT, closing());

      await useCase.open(
        memberSession('cashier'),
        opening({ operationId: OP_OTHER, shiftId: SHIFT_2 }),
      );

      expect(cash.shifts.records).toHaveLength(2);
    });

    it('does not reuse the id of another shift', async () => {
      const { useCase } = await setup();
      await useCase.open(asPerson('cashier', OTHER_USER), opening());

      await expect(
        useCase.open(memberSession('cashier'), opening({ operationId: OP_OTHER })),
      ).rejects.toBeInstanceOf(ShiftIdReusedError);
    });

    it('says the device does not exist, with the field, when it is not one of this business', async () => {
      const { cash, useCase } = await setup();

      const failure = await useCase
        .open(memberSession('cashier'), opening({ deviceId: UNKNOWN }))
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ValidationFailedError);
      expect(codes(failure)).toEqual(['/deviceId:unknown-device']);
      expect(cash.shifts.records).toEqual([]);
    });

    it('reports every problem and opens nothing', async () => {
      const { cash, useCase } = await setup();

      const failure = await useCase
        .open(memberSession('cashier'), { shiftId: 'turno', openingAmount: -1, extra: true })
        .catch((error: unknown) => error);

      expect(codes(failure)).toEqual([
        '/extra:unknown-field',
        '/operationId:required',
        '/shiftId:invalid-id',
        '/deviceId:required',
        '/openingAmount:out-of-range',
        '/deviceTime:required',
      ]);
      expect(cash.shifts.records).toEqual([]);
    });

    it('refuses a person with no business and a person who was let go', async () => {
      const { useCase } = await setup();

      await expect(useCase.open(loneSession(), opening())).rejects.toBeInstanceOf(
        NoMembershipError,
      );
      await expect(
        useCase.open(memberSession('owner', { active: false }), opening()),
      ).rejects.toBeInstanceOf(UserInactiveError);
    });
  });

  describe('closing a shift', () => {
    const opened = async (role: Role = 'cashier') => {
      const test = await setup();
      await test.useCase.open(memberSession(role), opening());
      return test;
    };

    it('closes it with the cash counted, at the time of the clock, and makes the count', async () => {
      const { cash, useCase } = await opened();
      cash.shifts.totalsOf.set(SHIFT, {
        cashSales: 100_000,
        cashIn: 20_000,
        cashOut: 5_000,
        late: { count: 0, cashAmount: 0 },
      });

      const { shift, replayed } = await useCase.close(memberSession('cashier'), SHIFT, closing());

      expect(replayed).toBe(false);
      expect(shift).toMatchObject({
        id: SHIFT,
        closedAt: new Date('2026-10-18T14:59:55.000Z'),
        closedByUserId: ACTOR_ID,
        countedAmount: 175_000,
      });
      expect(shift.summary).toMatchObject({
        expectedAmount: 165_000,
        countedAmount: 175_000,
        difference: 10_000,
      });
    });

    it('records the operation as a closing, with the times', async () => {
      const { purchasing, useCase } = await opened();

      await useCase.close(memberSession('cashier'), SHIFT, closing());

      expect(purchasing.operations.claims.get(OP_CLOSE)?.request).toMatchObject({
        kind: 'shift_close',
        userId: ACTOR_ID,
        times: { source: 'corrected', flags: [] },
      });
    });

    it('lets the management close the shift of another person, and a cashier not even theirs by another', async () => {
      const { cash, useCase } = await opened('cashier');

      await expect(
        useCase.close(asPerson('cashier', OTHER_USER), SHIFT, closing()),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(cash.shifts.records[0]?.closedAt).toBeNull();

      const { shift } = await useCase.close(asPerson('admin', OTHER_USER), SHIFT, closing());

      expect(shift.closedByUserId).toBe(OTHER_USER);
      expect(shift.userId).toBe(ACTOR_ID);
    });

    it('answers a repeated closing with the same shift, as it is now, and closes nothing again', async () => {
      const { useCase } = await opened();
      const first = await useCase.close(memberSession('cashier'), SHIFT, closing());

      const again = await useCase.close(
        memberSession('cashier'),
        SHIFT,
        closing({ clockOffsetMs: 250 }),
      );

      expect(again.replayed).toBe(true);
      expect(again.shift).toEqual(first.shift);
    });

    it('answers a repetition with the shift as the other request left it, even if it closed while this one waited for the operation', async () => {
      const { cash, purchasing, useCase } = await opened();
      // Dos peticiones iguales a la vez: la segunda espera en el reclamo a que la primera termine, y cuando le toca el
      // turno que habia leido ya cambio.
      const waiting = purchasing.operations.claim.bind(purchasing.operations);
      purchasing.operations.claim = async (request) => {
        if (request.kind === 'shift_close') {
          await cash.shifts.close(SHIFT, {
            closedAt: new Date('2026-10-18T14:59:55.000Z'),
            closedByUserId: ACTOR_ID,
            countedAmount: 175_000,
          });
          return 'replay';
        }
        return waiting(request);
      };

      const { shift, replayed } = await useCase.close(memberSession('cashier'), SHIFT, closing());

      expect(replayed).toBe(true);
      expect(shift.closedAt).toEqual(new Date('2026-10-18T14:59:55.000Z'));
      expect(shift.countedAmount).toBe(175_000);
    });

    it('refuses to close a shift that is already closed with another operation', async () => {
      const { useCase } = await opened();
      await useCase.close(memberSession('cashier'), SHIFT, closing());

      await expect(
        useCase.close(memberSession('cashier'), SHIFT, closing({ operationId: OP_OTHER })),
      ).rejects.toBeInstanceOf(ShiftClosedError);
    });

    it('refuses the same operation id with another body', async () => {
      const { cash, useCase } = await opened();
      await useCase.close(memberSession('cashier'), SHIFT, closing());

      await expect(
        useCase.close(memberSession('cashier'), SHIFT, closing({ countedAmount: 1 })),
      ).rejects.toBeInstanceOf(OperationIdReusedError);
      expect(cash.shifts.records[0]?.countedAmount).toBe(175_000);
    });

    it('never closes before it opened: a clock that goes back closes at the moment it opened', async () => {
      const { useCase } = await opened();

      const { shift } = await useCase.close(
        memberSession('cashier'),
        SHIFT,
        closing({ deviceTime: '2026-10-17T10:00:00.000Z', clockOffsetMs: 0 }),
      );

      expect(shift.closedAt).toEqual(new Date('2026-10-18T14:59:54.000Z'));
    });

    it('accepts the id of the shift written in capitals, as it may come in a web address', async () => {
      const { useCase } = await opened();

      const { shift } = await useCase.close(
        memberSession('cashier'),
        SHIFT.toUpperCase(),
        closing(),
      );

      expect(shift.id).toBe(SHIFT);
      await expect(
        useCase.get(memberSession('cashier'), SHIFT.toUpperCase()),
      ).resolves.toMatchObject({
        id: SHIFT,
      });
    });

    it('says there is no such shift, also for an id that is not a UUID, without asking the database', async () => {
      const { work, useCase } = await setup();

      await expect(
        useCase.close(memberSession('owner'), UNKNOWN, closing()),
      ).rejects.toBeInstanceOf(ShiftNotFoundError);
      work.openedFor.length = 0;
      await expect(
        useCase.close(memberSession('owner'), 'no-es-uuid', closing()),
      ).rejects.toBeInstanceOf(ShiftNotFoundError);
      expect(work.openedFor).toEqual([]);
    });

    it('reports every problem of the body and closes nothing', async () => {
      const { cash, useCase } = await opened();

      const failure = await useCase
        .close(memberSession('cashier'), SHIFT, { countedAmount: 'mucho', shiftId: SHIFT })
        .catch((error: unknown) => error);

      expect(codes(failure)).toEqual([
        '/shiftId:unknown-field',
        '/operationId:required',
        '/countedAmount:invalid-type',
        '/deviceTime:required',
      ]);
      expect(cash.shifts.records[0]?.closedAt).toBeNull();
    });

    it('refuses a person with no business and a person who was let go', async () => {
      const { useCase } = await opened();

      await expect(useCase.close(loneSession(), SHIFT, closing())).rejects.toBeInstanceOf(
        NoMembershipError,
      );
      await expect(
        useCase.close(memberSession('owner', { active: false }), SHIFT, closing()),
      ).rejects.toBeInstanceOf(UserInactiveError);
    });
  });

  describe('looking at shifts', () => {
    const withShifts = async () => {
      const test = await setup();
      // Tres turnos: dos de la cajera (uno cerrado) y uno de otra persona, cada uno una hora despues del anterior.
      const times = [
        '2026-10-18T10:00:00.000Z',
        '2026-10-18T11:00:00.000Z',
        '2026-10-18T12:00:00.000Z',
      ];
      const mine = '6a7b8c9d-0e1f-4a2b-8c3d-5e6f7a8b9c0d';
      const theirs = '7b8c9d0e-1f2a-4b3c-8d4e-6f7a8b9c0d1e';
      await test.useCase.open(
        memberSession('cashier'),
        opening({ operationId: OP_OPEN, shiftId: SHIFT, deviceTime: times[0], clockOffsetMs: 0 }),
      );
      await test.useCase.close(
        memberSession('cashier'),
        SHIFT,
        closing({ deviceTime: '2026-10-18T10:30:00.000Z' }),
      );
      await test.useCase.open(
        asPerson('cashier', OTHER_USER),
        opening({ operationId: OP_OTHER, shiftId: theirs, deviceTime: times[1], clockOffsetMs: 0 }),
      );
      await test.useCase.open(
        memberSession('cashier'),
        opening({ operationId: OP_THIRD, shiftId: mine, deviceTime: times[2], clockOffsetMs: 0 }),
      );
      return { ...test, mine, theirs };
    };

    it('shows a cashier only their own shifts, newest first, and the management all of them', async () => {
      const { mine, useCase } = await withShifts();

      const own = await useCase.list(memberSession('cashier'), {});
      const all = await useCase.list(memberSession('admin'), {});

      expect(own.items.map((shift) => shift.id)).toEqual([mine, SHIFT]);
      expect(all.items).toHaveLength(3);
      expect(all.items.map((shift) => shift.openedAt.toISOString())).toEqual([
        '2026-10-18T12:00:00.000Z',
        '2026-10-18T11:00:00.000Z',
        '2026-10-18T10:00:00.000Z',
      ]);
    });

    it('filters by open or closed', async () => {
      const { mine, theirs, useCase } = await withShifts();

      const open = await useCase.list(memberSession('owner'), { open: 'true' });
      const closed = await useCase.list(memberSession('owner'), { open: 'false' });

      expect(open.items.map((shift) => shift.id)).toEqual([mine, theirs]);
      expect(closed.items.map((shift) => shift.id)).toEqual([SHIFT]);
    });

    it('pages with a cursor that follows the position', async () => {
      const { useCase } = await withShifts();

      const first = await useCase.list(memberSession('owner'), { limit: '2' });
      const second = await useCase.list(memberSession('owner'), {
        limit: '2',
        cursor: first.nextCursor,
      });

      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();
      expect(second.items.map((shift) => shift.id)).toEqual([SHIFT]);
      expect(second.nextCursor).toBeNull();
    });

    it('refuses what it does not know: a parameter, an open that is not true or false, a cursor made up', async () => {
      const { useCase } = await withShifts();

      const unknown = await useCase
        .list(memberSession('owner'), { orden: 'x' })
        .catch((error: unknown) => error);
      const badOpen = await useCase
        .list(memberSession('owner'), { open: 'quizas' })
        .catch((error: unknown) => error);
      const badCursor = await useCase
        .list(memberSession('owner'), { cursor: encodeCursor(['ayer', 'no-es-un-uuid']) })
        .catch((error: unknown) => error);

      expect(codes(unknown)).toEqual(['/orden:unknown-field']);
      expect(codes(badOpen)).toEqual(['/open:invalid-value']);
      expect(codes(badCursor)).toEqual(['/cursor:invalid-cursor']);
    });

    it('shows a shift with its count, to its own person and to the management', async () => {
      const { cash, useCase } = await withShifts();
      cash.shifts.totalsOf.set(SHIFT, {
        cashSales: 90_000,
        cashIn: 0,
        cashOut: 0,
        late: { count: 1, cashAmount: 4_000 },
      });

      const own = await useCase.get(memberSession('cashier'), SHIFT);
      const seenByOwner = await useCase.get(memberSession('owner'), SHIFT);

      expect(own).toEqual(seenByOwner);
      expect(own.summary).toMatchObject({
        expectedAmount: 140_000,
        countedAmount: 175_000,
        difference: 35_000,
        lateSales: { count: 1, cashAmount: 4_000 },
      });
    });

    it('says a cashier has no such shift when it is of another person, as if it did not exist', async () => {
      const { theirs, useCase } = await withShifts();

      await expect(useCase.get(memberSession('cashier'), theirs)).rejects.toBeInstanceOf(
        ShiftNotFoundError,
      );
      await expect(useCase.get(memberSession('admin'), theirs)).resolves.toBeDefined();
    });

    it('says there is no such shift for an unknown id and for one that is not a UUID', async () => {
      const { work, useCase } = await withShifts();

      await expect(useCase.get(memberSession('owner'), UNKNOWN)).rejects.toBeInstanceOf(
        ShiftNotFoundError,
      );
      work.openedFor.length = 0;
      await expect(useCase.get(memberSession('owner'), 'no-es-uuid')).rejects.toBeInstanceOf(
        ShiftNotFoundError,
      );
      expect(work.openedFor).toEqual([]);
    });

    it('refuses a person with no business and a person who was let go', async () => {
      const { useCase } = await withShifts();

      await expect(useCase.list(loneSession(), {})).rejects.toBeInstanceOf(NoMembershipError);
      await expect(useCase.get(loneSession(), SHIFT)).rejects.toBeInstanceOf(NoMembershipError);
      await expect(
        useCase.list(memberSession('owner', { active: false }), {}),
      ).rejects.toBeInstanceOf(UserInactiveError);
    });
  });
});
