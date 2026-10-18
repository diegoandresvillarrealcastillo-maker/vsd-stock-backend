import { describe, expect, it } from 'vitest';
import { DeviceIdReusedError, DeviceNotFoundError } from '../../domain/model/device-errors.js';
import { encodeCursor } from '../../domain/model/pagination.js';
import { ForbiddenError, NoMembershipError } from '../../domain/model/people-errors.js';
import { ValidationFailedError } from '../../domain/model/validation.js';
import { UserInactiveError } from '../../domain/ports/in/authenticate.js';
import type { Clock } from '../../domain/ports/out/clock.js';
import { FakeDevices } from '../../../test/support/fake-devices.js';
import { FakePeople, fakeUnitOfWork } from '../../../test/support/fake-people.js';
import {
  ACTOR_ID,
  BUSINESS_ID,
  loneSession,
  memberSession,
} from '../../../test/support/sessions.js';
import { DevicesUseCase } from './devices.usecase.js';

const NOW = new Date('2026-10-18T15:00:00.000Z');
const clock: Clock = { now: () => NOW };

const FIRST = '3f6c2d1e-8a4b-4c7d-9e1f-5a2b3c4d5e6f';
const SECOND = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const THIRD = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e';
const OTHER = '99999999-9999-4999-8999-999999999999';

const setup = () => {
  const devices = new FakeDevices();
  const work = fakeUnitOfWork(new FakePeople(), 'Tienda', undefined, undefined, devices);
  return { devices, work, useCase: new DevicesUseCase(work, clock) };
};

describe('DevicesUseCase', () => {
  describe('registering', () => {
    it('gives each new device the next code of the business: AA, AB, AC', async () => {
      const { useCase } = setup();

      const first = await useCase.register(memberSession('owner'), { id: FIRST });
      const second = await useCase.register(memberSession('cashier'), {
        id: SECOND,
        name: 'Caja 2',
      });

      expect(first.device).toMatchObject({ id: FIRST, code: 'AA', name: null, revokedAt: null });
      expect(second.device).toMatchObject({ id: SECOND, code: 'AB', name: 'Caja 2' });
      expect(first.replayed).toBe(false);
      expect(second.replayed).toBe(false);
    });

    it('remembers who enrolled it and works inside the business of that person', async () => {
      const { devices, work, useCase } = setup();

      await useCase.register(memberSession('admin'), { id: FIRST });

      expect(devices.records[0]?.enrolledByUserId).toBe(ACTOR_ID);
      expect(work.openedFor).toEqual([BUSINESS_ID]);
    });

    it('is open to the three roles: a cashier enrolls the phone they sell with', async () => {
      const { devices, useCase } = setup();

      await useCase.register(memberSession('owner'), { id: FIRST });
      await useCase.register(memberSession('admin'), { id: SECOND });
      await useCase.register(memberSession('cashier'), { id: THIRD });

      expect(devices.records.map((device) => device.code)).toEqual(['AA', 'AB', 'AC']);
    });

    it('answers a repeated registration with the same device and does not spend another code', async () => {
      const { devices, useCase } = setup();
      const first = await useCase.register(memberSession('cashier'), { id: FIRST, name: 'Caja' });

      const again = await useCase.register(memberSession('cashier'), { id: FIRST, name: 'Caja' });
      const next = await useCase.register(memberSession('cashier'), { id: SECOND });

      expect(again.replayed).toBe(true);
      expect(again.device).toEqual(first.device);
      expect(devices.records).toHaveLength(2);
      expect(next.device.code).toBe('AB');
    });

    it('hands back a device that was let go, so the device finds out', async () => {
      const { useCase } = setup();
      await useCase.register(memberSession('cashier'), { id: FIRST });
      await useCase.revoke(memberSession('owner'), FIRST);

      const again = await useCase.register(memberSession('cashier'), { id: FIRST });

      expect(again.replayed).toBe(true);
      expect(again.device.revokedAt).toEqual(NOW);
    });

    it('refuses the same id with another name: that would be a different device', async () => {
      const { devices, useCase } = setup();
      await useCase.register(memberSession('owner'), { id: FIRST, name: 'Caja' });

      await expect(
        useCase.register(memberSession('owner'), { id: FIRST, name: 'Otra caja' }),
      ).rejects.toBeInstanceOf(DeviceIdReusedError);
      await expect(useCase.register(memberSession('owner'), { id: FIRST })).rejects.toBeInstanceOf(
        DeviceIdReusedError,
      );
      expect(devices.records).toHaveLength(1);
      expect(devices.records[0]?.name).toBe('Caja');
    });

    it('reports every problem and registers nothing', async () => {
      const { devices, useCase } = setup();

      const failure = await useCase
        .register(memberSession('owner'), { id: 'caja', name: '', code: 'AA' })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ValidationFailedError);
      expect(
        (failure as ValidationFailedError).errors.map((e) => `${e.pointer}:${e.code}`),
      ).toEqual(['/code:unknown-field', '/id:invalid-id', '/name:blank']);
      expect(devices.records).toEqual([]);
    });

    it('refuses a person with no business and a person who was let go', async () => {
      const { useCase } = setup();

      await expect(useCase.register(loneSession(), { id: FIRST })).rejects.toBeInstanceOf(
        NoMembershipError,
      );
      await expect(
        useCase.register(memberSession('owner', { active: false }), { id: FIRST }),
      ).rejects.toBeInstanceOf(UserInactiveError);
    });
  });

  describe('listing', () => {
    it('lists the devices in the order they were enrolled, in pages, with the ones let go', async () => {
      const { useCase } = setup();
      for (const id of [FIRST, SECOND, THIRD]) {
        await useCase.register(memberSession('cashier'), { id });
      }
      await useCase.revoke(memberSession('admin'), SECOND);

      const first = await useCase.list(memberSession('admin'), { limit: '2' });
      expect(first.items.map((device) => device.code)).toEqual(['AA', 'AB']);
      expect(first.items[1]?.revokedAt).toEqual(NOW);
      const second = await useCase.list(memberSession('owner'), {
        limit: '2',
        cursor: first.nextCursor,
      });
      expect(second.items.map((device) => device.code)).toEqual(['AC']);
      expect(second.nextCursor).toBeNull();
    });

    it('is for the management only', async () => {
      const { useCase } = setup();

      await expect(useCase.list(memberSession('cashier'), {})).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    });

    it('refuses a parameter it does not know', async () => {
      const { useCase } = setup();

      const failure = await useCase
        .list(memberSession('owner'), { orden: 'codigo' })
        .catch((error: unknown) => error);

      expect(
        (failure as ValidationFailedError).errors.map((e) => `${e.pointer}:${e.code}`),
      ).toEqual(['/orden:unknown-field']);
    });

    it('refuses a cursor that is not a time and an id, which the database could not compare', async () => {
      const { useCase } = setup();

      const failure = await useCase
        .list(memberSession('owner'), { cursor: encodeCursor(['ayer', 'no-es-un-uuid']) })
        .catch((error: unknown) => error);

      expect((failure as ValidationFailedError).errors.map((e) => e.code)).toEqual([
        'invalid-cursor',
      ]);
    });
  });

  describe('letting a device go', () => {
    it('marks the device as let go at the time of the clock; the code stays reserved', async () => {
      const { devices, useCase } = setup();
      await useCase.register(memberSession('cashier'), { id: FIRST });

      const revoked = await useCase.revoke(memberSession('admin'), FIRST);
      const next = await useCase.register(memberSession('cashier'), { id: SECOND });

      expect(revoked).toMatchObject({ id: FIRST, code: 'AA', revokedAt: NOW });
      expect(next.device.code).toBe('AB');
      expect(devices.records).toHaveLength(2);
    });

    it('accepts the id written in capitals, as it may come in a web address', async () => {
      const { useCase } = setup();
      await useCase.register(memberSession('cashier'), { id: FIRST });

      const revoked = await useCase.revoke(memberSession('owner'), FIRST.toUpperCase());

      expect(revoked).toMatchObject({ id: FIRST, revokedAt: NOW });
    });

    it('can be repeated: it keeps the first date', async () => {
      const { devices, useCase } = setup();
      await useCase.register(memberSession('cashier'), { id: FIRST });
      const earlier = new Date('2026-10-18T14:00:00.000Z');
      await devices.revoke(FIRST, earlier);

      const again = await useCase.revoke(memberSession('owner'), FIRST);

      expect(again.revokedAt).toEqual(earlier);
    });

    it('says there is no such device, also for an id that is not a UUID, without asking the database', async () => {
      const { work, useCase } = setup();

      await expect(useCase.revoke(memberSession('owner'), OTHER)).rejects.toBeInstanceOf(
        DeviceNotFoundError,
      );
      work.openedFor.length = 0;
      await expect(useCase.revoke(memberSession('owner'), 'no-es-uuid')).rejects.toBeInstanceOf(
        DeviceNotFoundError,
      );
      expect(work.openedFor).toEqual([]);
    });

    it('is for the management: a cashier can not let a device go, not even their own', async () => {
      const { devices, useCase } = setup();
      await useCase.register(memberSession('cashier'), { id: FIRST });

      await expect(useCase.revoke(memberSession('cashier'), FIRST)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      expect(devices.records[0]?.revokedAt).toBeNull();
    });
  });
});
