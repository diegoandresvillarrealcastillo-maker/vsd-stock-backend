import { DeviceIdReusedError, DeviceNotFoundError } from '../../domain/model/device-errors.js';
import { NEW_DEVICE_FIELDS, readNewDevice } from '../../domain/model/device-input.js';
import { pageOf, readPageRequest, timeThenUuid, type Page } from '../../domain/model/pagination.js';
import { isUuid } from '../../domain/model/uuid.js';
import { InputReader } from '../../domain/model/validation.js';
import type { Session } from '../../domain/ports/in/authenticate.js';
import type { DeviceOutcome, DeviceView, Devices } from '../../domain/ports/in/devices.js';
import type { Clock } from '../../domain/ports/out/clock.js';
import type { UnitOfWork } from '../../domain/ports/out/unit-of-work.js';
import { ensureCan, requireMember } from '../session-guards.js';

/**
 * Casos de uso de los dispositivos (C3-01, ADR 0016 y 0017). Registrar lo puede hacer cualquier persona del negocio: es
 * el telefono con el que va a vender. Ver la lista y dar de baja es de la gerencia. Todo exige conexion: el codigo del
 * dispositivo lo reparte el servidor y por eso un dispositivo no puede inventarselo sin red.
 */
export class DevicesUseCase implements Devices {
  constructor(
    private readonly work: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  async register(session: Session, body: unknown): Promise<DeviceOutcome> {
    const actor = requireMember(session);
    ensureCan(actor, 'device:enroll');

    const reader = new InputReader(body, NEW_DEVICE_FIELDS);
    const device = readNewDevice(reader);
    reader.finish();

    return this.work.inBusiness(actor.businessId, async (scope) => {
      const registration = await scope.devices.register(device, actor.userId);
      // Repetida con el mismo cuerpo es la misma peticion; con otro nombre es otro dispositivo que quiere el mismo
      // identificador. No se escribio nada: lanzar aqui no deshace nada que importe.
      if (!registration.created && registration.device.name !== device.name) {
        throw new DeviceIdReusedError();
      }
      return { device: registration.device, replayed: !registration.created };
    });
  }

  async list(session: Session, query: unknown): Promise<Page<DeviceView>> {
    const actor = requireMember(session);
    ensureCan(actor, 'device:revoke');

    const reader = new InputReader(query, ['limit', 'cursor']);
    const request = readPageRequest(reader, 2, timeThenUuid);
    reader.finish();

    const [afterAt, afterId] = request.after ?? [];
    const rows = await this.work.inBusiness(actor.businessId, (scope) =>
      scope.devices.list({
        // Una de mas: si llega, hay otra pagina.
        limit: request.limit + 1,
        ...(afterAt !== undefined && afterId !== undefined
          ? { after: [afterAt, afterId] as const }
          : {}),
      }),
    );
    return pageOf(rows, request.limit, (device) => [device.enrolledAt.toISOString(), device.id]);
  }

  async revoke(session: Session, deviceId: string): Promise<DeviceView> {
    const actor = requireMember(session);
    ensureCan(actor, 'device:revoke');
    // Un identificador que no es un UUID no es de nadie: no se le pregunta nada a la base.
    if (!isUuid(deviceId)) throw new DeviceNotFoundError();

    // El repositorio lanza `DeviceNotFoundError` si no existe en este negocio.
    return this.work.inBusiness(actor.businessId, (scope) =>
      scope.devices.revoke(deviceId.toLowerCase(), this.clock.now()),
    );
  }
}
