import type { NewDevice } from '../../model/device-input.js';
import type { ListRequest } from './catalog.js';

/** Un dispositivo del negocio, tal como quedo guardado. */
export interface DeviceRecord {
  readonly id: string;
  /** El codigo corto que encabeza sus folios (ADR 0016): lo da el servidor y no se reutiliza. */
  readonly code: string;
  readonly name: string | null;
  readonly enrolledByUserId: string | null;
  readonly enrolledAt: Date;
  /** Cuando se dio de baja; `null` mientras siga activo. */
  readonly revokedAt: Date | null;
}

/** El listado va del mas antiguo al mas nuevo (el orden de los codigos); la posicion es (hora de alta en milisegundos, id). */
export interface DeviceListRequest extends Omit<ListRequest, 'after'> {
  readonly after?: readonly [string, string];
}

/** Lo que paso al registrar: si `created` es `false`, el dispositivo ya existia y no se escribio nada. */
export interface DeviceRegistration {
  readonly device: DeviceRecord;
  readonly created: boolean;
}

/**
 * Puerto de salida: los dispositivos del negocio de la unidad de trabajo (C3-01, ADR 0016). Ninguna operacion recibe el
 * negocio. Un dispositivo no se borra: se da de baja, y su codigo queda reservado para siempre.
 */
export interface DeviceRepository {
  list(request: DeviceListRequest): Promise<DeviceRecord[]>;
  find(id: string): Promise<DeviceRecord | null>;
  /**
   * Registra el dispositivo si no existe y le da el siguiente codigo del negocio; si ya existe, lo devuelve tal cual y NO
   * gasta un codigo. Los registros de un negocio se turnan: dos a la vez nunca reciben el mismo codigo. Lanza
   * `DeviceIdReusedError` si el `id` pertenece a un dispositivo de otro negocio.
   */
  register(device: NewDevice, enrolledByUserId: string): Promise<DeviceRegistration>;
  /** Da de baja; si ya lo estaba, lo devuelve igual y conserva la primera fecha. Lanza `DeviceNotFoundError`. */
  revoke(id: string, at: Date): Promise<DeviceRecord>;
}
