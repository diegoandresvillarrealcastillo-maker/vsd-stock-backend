import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applicationUrlOf } from '../../scripts/prepare-database.ts';
import { createPrismaClient } from '../../src/adapters/out/persistence/create-prisma-client.js';
import { PrismaUnitOfWork } from '../../src/adapters/out/persistence/prisma-unit-of-work.js';
import { DeviceIdReusedError, DeviceNotFoundError } from '../../src/domain/model/device-errors.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { createAdminPool } from './support/database.js';
import { BUSINESS_A, BUSINESS_B, resetData, seedBusiness } from './support/seed.js';
import { select } from './support/sql.js';

/**
 * Los dispositivos contra PostgreSQL (C3-01), con el rol real de la aplicacion: cada negocio reparte sus codigos desde su
 * propio contador, dos registros a la vez nunca reciben el mismo, y repetir un registro no gasta un codigo.
 */
describe('devices against PostgreSQL (C3-01)', () => {
  let admin: pg.Pool;
  let prisma: PrismaClient;
  let unitOfWork: PrismaUnitOfWork;
  let a: Awaited<ReturnType<typeof seedBusiness>>;
  let b: Awaited<ReturnType<typeof seedBusiness>>;

  beforeAll(() => {
    admin = createAdminPool(3);
    // Mas conexiones que registros simultaneos: una transaccion que espera el turno sigue ocupando la suya.
    prisma = createPrismaClient(applicationUrlOf(process.env['TEST_DATABASE_URL']!), { max: 14 });
    unitOfWork = new PrismaUnitOfWork(prisma);
  });

  beforeEach(async () => {
    await resetData(admin);
    a = await seedBusiness(admin, BUSINESS_A);
    b = await seedBusiness(admin, BUSINESS_B);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await admin.end();
  });

  const register = (
    businessId: string,
    userId: string,
    id: string = randomUUID(),
    name: string | null = null,
  ) => unitOfWork.inBusiness(businessId, (s) => s.devices.register({ id, name }, userId));

  const counterOf = async (businessId: string) =>
    (
      await select(admin, 'SELECT next_index FROM device_counter WHERE id_negocio = $1', [
        businessId,
      ])
    )[0]?.['next_index'];

  it('gives each business its own sequence: AA, AB, AC...', async () => {
    const first = await register(BUSINESS_A, a.ownerId);
    const second = await register(BUSINESS_A, a.ownerId, randomUUID(), 'Caja 2');
    const third = await register(BUSINESS_A, a.ownerId);
    const other = await register(BUSINESS_B, b.ownerId);

    expect([first, second, third].map((r) => r.device.code)).toEqual(['AA', 'AB', 'AC']);
    expect([first, second, third].map((r) => r.created)).toEqual([true, true, true]);
    expect(other.device.code).toBe('AA');
    expect(second.device).toMatchObject({
      name: 'Caja 2',
      enrolledByUserId: a.ownerId,
      revokedAt: null,
    });
    expect(second.device.enrolledAt).toBeInstanceOf(Date);
    expect(await counterOf(BUSINESS_A)).toBe(3);
    expect(await counterOf(BUSINESS_B)).toBe(1);
  });

  it('answers a repeated registration with the same device and does not spend a code', async () => {
    const id = randomUUID();
    const first = await register(BUSINESS_A, a.ownerId, id, 'Caja');

    const again = await register(BUSINESS_A, a.ownerId, id, 'Caja');
    const next = await register(BUSINESS_A, a.ownerId);

    expect(again).toEqual({ device: first.device, created: false });
    expect(next.device.code).toBe('AB');
    expect(await counterOf(BUSINESS_A)).toBe(2);
  });

  it('never gives the same code to devices registered at the same time', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, () => register(BUSINESS_A, a.ownerId)),
    );

    const codes = results.map((r) => r.device.code).sort();
    expect(new Set(codes).size).toBe(12);
    expect(codes).toEqual(['AA', 'AB', 'AC', 'AD', 'AE', 'AF', 'AG', 'AH', 'AJ', 'AK', 'AM', 'AN']);
    expect(await counterOf(BUSINESS_A)).toBe(12);
  });

  it('creates one device and spends one code when the same registration arrives five times at once', async () => {
    const id = randomUUID();

    const results = await Promise.all(
      Array.from({ length: 5 }, () => register(BUSINESS_A, a.ownerId, id, 'Caja')),
    );

    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.device.code))).toEqual(new Set(['AA']));
    expect(await counterOf(BUSINESS_A)).toBe(1);
    const rows = await select(admin, 'SELECT 1 FROM device WHERE id = $1', [id]);
    expect(rows).toHaveLength(1);
  });

  it('keeps the businesses apart: the other one does not see it and can not take its id', async () => {
    const mine = await register(BUSINESS_A, a.ownerId);

    expect(
      await unitOfWork.inBusiness(BUSINESS_B, (s) => s.devices.find(mine.device.id)),
    ).toBeNull();
    // Lo unico que el otro negocio ve es su propio dispositivo de las semillas.
    const theirs = await unitOfWork.inBusiness(BUSINESS_B, (s) => s.devices.list({ limit: 10 }));
    expect(theirs.map((device) => device.code)).toEqual(['ZZ']);
    await expect(register(BUSINESS_B, b.ownerId, mine.device.id)).rejects.toBeInstanceOf(
      DeviceIdReusedError,
    );
    // El intento fallido no gasto un codigo del otro negocio.
    expect(await counterOf(BUSINESS_B)).toBeUndefined();
  });

  it('lists the devices in the order they were enrolled, in pages that follow the position', async () => {
    for (let index = 0; index < 5; index += 1) {
      await register(BUSINESS_A, a.ownerId);
    }
    // El dispositivo de las semillas (ZZ) tambien es del negocio: se ve en la lista, con su hora de alta.
    const seen: string[] = [];
    let after: readonly [string, string] | undefined;
    for (;;) {
      const page = await unitOfWork.inBusiness(BUSINESS_A, (s) =>
        s.devices.list({ limit: 2, ...(after === undefined ? {} : { after }) }),
      );
      // El limite lo respeta la base: nunca llegan mas filas de las pedidas.
      expect(page.length).toBeLessThanOrEqual(2);
      seen.push(...page.map((device) => device.code));
      const last = page[page.length - 1];
      if (page.length < 2 || last === undefined) break;
      after = [last.enrolledAt.toISOString(), last.id];
    }

    expect(seen.filter((code) => code !== 'ZZ')).toEqual(['AA', 'AB', 'AC', 'AD', 'AE']);
    expect(new Set(seen).size).toBe(6);
  });

  it('lets a device go: it keeps its code and the first date, and the code is not given again', async () => {
    const first = await register(BUSINESS_A, a.ownerId);
    const at = new Date('2026-10-18T15:00:00.000Z');

    const revoked = await unitOfWork.inBusiness(BUSINESS_A, (s) =>
      s.devices.revoke(first.device.id, at),
    );
    const again = await unitOfWork.inBusiness(BUSINESS_A, (s) =>
      s.devices.revoke(first.device.id, new Date('2026-10-19T15:00:00.000Z')),
    );
    const next = await register(BUSINESS_A, a.ownerId);

    expect(revoked).toMatchObject({ code: 'AA', revokedAt: at });
    expect(again.revokedAt).toEqual(at);
    expect(next.device.code).toBe('AB');
    expect(await unitOfWork.inBusiness(BUSINESS_A, (s) => s.devices.find(first.device.id))).toEqual(
      revoked,
    );
  });

  it('does not let go of a device that does not exist or belongs to another business', async () => {
    const mine = await register(BUSINESS_A, a.ownerId);

    await expect(
      unitOfWork.inBusiness(BUSINESS_B, (s) => s.devices.revoke(mine.device.id, new Date())),
    ).rejects.toBeInstanceOf(DeviceNotFoundError);
    await expect(
      unitOfWork.inBusiness(BUSINESS_A, (s) => s.devices.revoke(randomUUID(), new Date())),
    ).rejects.toBeInstanceOf(DeviceNotFoundError);
    expect(
      (await unitOfWork.inBusiness(BUSINESS_A, (s) => s.devices.find(mine.device.id)))?.revokedAt,
    ).toBeNull();
  });
});
