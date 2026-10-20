import { DeviceCode } from '../../src/domain/model/device-code.js';
import { DeviceNotFoundError } from '../../src/domain/model/device-errors.js';
import type { NewDevice } from '../../src/domain/model/device-input.js';
import type {
  DeviceListRequest,
  DeviceRecord,
  DeviceRegistration,
  DeviceRepository,
} from '../../src/domain/ports/out/devices.js';

const byEnrollmentThenId = (a: DeviceRecord, b: DeviceRecord): number =>
  a.enrolledAt.getTime() - b.enrolledAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Los dispositivos de un negocio en memoria. Hace lo mismo que el adaptador de Prisma, sin base. */
export class FakeDevices implements DeviceRepository {
  readonly records: DeviceRecord[] = [];
  /** Cuantos codigos se han repartido: el siguiente dispositivo recibe `DeviceCode.forIndex(allocated)`. */
  allocated = 0;

  list(request: DeviceListRequest): Promise<DeviceRecord[]> {
    const sorted = [...this.records].sort(byEnrollmentThenId);
    const after = request.after;
    const rest =
      after === undefined
        ? sorted
        : sorted.filter(
            (device) =>
              device.enrolledAt.toISOString() > after[0] ||
              (device.enrolledAt.toISOString() === after[0] && device.id > after[1]),
          );
    return Promise.resolve(rest.slice(0, request.limit));
  }

  find(id: string): Promise<DeviceRecord | null> {
    return Promise.resolve(this.records.find((device) => device.id === id) ?? null);
  }

  register(device: NewDevice, enrolledByUserId: string): Promise<DeviceRegistration> {
    const existing = this.records.find((record) => record.id === device.id);
    if (existing !== undefined) return Promise.resolve({ device: existing, created: false });
    const record: DeviceRecord = {
      id: device.id,
      code: DeviceCode.forIndex(this.allocated).value,
      name: device.name,
      enrolledByUserId,
      // Un minuto despues del anterior: el orden del listado se ve en las pruebas.
      enrolledAt: new Date(Date.UTC(2026, 9, 18, 12, this.allocated)),
      revokedAt: null,
    };
    this.allocated += 1;
    this.records.push(record);
    return Promise.resolve({ device: record, created: true });
  }

  revoke(id: string, at: Date): Promise<DeviceRecord> {
    const index = this.records.findIndex((device) => device.id === id);
    const current = this.records[index];
    if (current === undefined) return Promise.reject(new DeviceNotFoundError());
    if (current.revokedAt !== null) return Promise.resolve(current);
    const revoked: DeviceRecord = { ...current, revokedAt: at };
    this.records[index] = revoked;
    return Promise.resolve(revoked);
  }
}
