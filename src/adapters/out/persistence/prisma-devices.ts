import { DeviceCode } from '../../../domain/model/device-code.js';
import { DeviceIdReusedError, DeviceNotFoundError } from '../../../domain/model/device-errors.js';
import type { NewDevice } from '../../../domain/model/device-input.js';
import type {
  DeviceListRequest,
  DeviceRecord,
  DeviceRegistration,
  DeviceRepository,
} from '../../../domain/ports/out/devices.js';
import type { PrismaTransaction } from './prisma-unit-of-work.js';

const DEVICE_SELECT = {
  id: true,
  deviceCode: true,
  name: true,
  enrolledByUserId: true,
  enrolledAt: true,
  revokedAt: true,
} as const;

interface DeviceRow {
  readonly id: string;
  readonly deviceCode: string;
  readonly name: string | null;
  readonly enrolledByUserId: string | null;
  readonly enrolledAt: Date;
  readonly revokedAt: Date | null;
}

function recordOf(row: DeviceRow): DeviceRecord {
  return {
    id: row.id,
    code: row.deviceCode,
    name: row.name,
    enrolledByUserId: row.enrolledByUserId,
    enrolledAt: row.enrolledAt,
    revokedAt: row.revokedAt,
  };
}

/** El codigo con que Prisma dice «la fila no existe» o «ya hay una fila con esa llave». */
function codeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null
    ? (error as { code?: unknown }).code
    : undefined;
}

/**
 * Los dispositivos del negocio de la transaccion, sobre Prisma. La seguridad por fila deja ver y escribir solo lo de ese
 * negocio.
 *
 * Los registros de un negocio se turnan con un candado de la transaccion: mientras uno corre, otro espera, y cuando le
 * toca ya ve lo que el primero dejo. Asi dos registros del mismo dispositivo no gastan dos codigos y dos dispositivos
 * distintos nunca reciben el mismo (ADR 0016).
 */
export class PrismaDeviceRepository implements DeviceRepository {
  constructor(
    private readonly tx: PrismaTransaction,
    private readonly businessId: string,
  ) {}

  async list(request: DeviceListRequest): Promise<DeviceRecord[]> {
    const after = request.after;
    const rows = await this.tx.device.findMany({
      // Por hora de alta y luego por id: la misma posicion que el cursor, que no cambia si alguien se suma.
      where:
        after === undefined
          ? {}
          : {
              OR: [
                { enrolledAt: { gt: new Date(after[0]) } },
                { enrolledAt: new Date(after[0]), id: { gt: after[1] } },
              ],
            },
      orderBy: [{ enrolledAt: 'asc' }, { id: 'asc' }],
      take: request.limit,
      select: DEVICE_SELECT,
    });
    return rows.map(recordOf);
  }

  async find(id: string): Promise<DeviceRecord | null> {
    const row = await this.tx.device.findFirst({ where: { id }, select: DEVICE_SELECT });
    return row === null ? null : recordOf(row);
  }

  async register(device: NewDevice, enrolledByUserId: string): Promise<DeviceRegistration> {
    // `$executeRaw` y no `$queryRaw`: la funcion devuelve `void`, que Prisma no sabe leer como columna.
    await this.tx
      .$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`device-registration:${this.businessId}`}))`;

    const existing = await this.find(device.id);
    if (existing !== null) return { device: existing, created: false };

    // El primer registro del negocio crea el contador en 1 y recibe el indice 0; cada otro lo sube y recibe el anterior.
    const [counter] = await this.tx.$queryRaw<{ index: number | bigint }[]>`
      INSERT INTO device_counter (id_negocio, next_index) VALUES (${this.businessId}::uuid, 1)
      ON CONFLICT (id_negocio) DO UPDATE SET next_index = device_counter.next_index + 1
      RETURNING next_index - 1 AS index`;
    if (counter === undefined) throw new Error('The device counter did not answer');
    const code = DeviceCode.forIndex(Number(counter.index));

    // La hora del reloj de la base, tomada con el candado puesto: los registros que se turnan quedan en el orden de
    // sus codigos. Llega como `Date`, que solo guarda milisegundos, y asi se escribe: es lo que el cursor del listado compara.
    const [clock] = await this.tx.$queryRaw<{ at: Date }[]>`SELECT clock_timestamp() AS at`;
    if (clock === undefined) throw new Error('The database clock did not answer');

    try {
      const row = await this.tx.device.create({
        data: {
          id: device.id,
          idNegocio: this.businessId,
          deviceCode: code.value,
          name: device.name,
          enrolledByUserId,
          enrolledAt: clock.at,
        },
        select: DEVICE_SELECT,
      });
      return { device: recordOf(row), created: true };
    } catch (error) {
      // El candado y la lectura de arriba descartan un dispositivo de este negocio: la llave que choca es la de otro.
      if (codeOf(error) === 'P2002') throw new DeviceIdReusedError();
      throw error;
    }
  }

  async revoke(id: string, at: Date): Promise<DeviceRecord> {
    const current = await this.find(id);
    if (current === null) throw new DeviceNotFoundError();
    if (current.revokedAt !== null) return current;
    try {
      const row = await this.tx.device.update({
        where: { id },
        data: { revokedAt: at },
        select: DEVICE_SELECT,
      });
      return recordOf(row);
    } catch (error) {
      if (codeOf(error) === 'P2025') throw new DeviceNotFoundError();
      throw error;
    }
  }
}
