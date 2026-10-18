import type { Page } from '../../model/pagination.js';
import type { DeviceRecord } from '../out/devices.js';
import type { Session } from './authenticate.js';

export type DeviceView = DeviceRecord;

/** El resultado de registrar un dispositivo: si `replayed`, ya existia (mismo `id`, mismo nombre) y no se hizo nada. */
export interface DeviceOutcome {
  readonly device: DeviceView;
  readonly replayed: boolean;
}

/**
 * Puertos de entrada de los dispositivos (C3-01). Cada metodo recibe la sesion de quien llama y lo que mando SIN validar
 * (`unknown`). Registrar es de los tres roles (`device:enroll`); ver la lista y dar de baja son de la gerencia
 * (`device:revoke`). Todo exige conexion (ADR 0017).
 */
export interface Devices {
  register(session: Session, body: unknown): Promise<DeviceOutcome>;
  list(session: Session, query: unknown): Promise<Page<DeviceView>>;
  revoke(session: Session, deviceId: string): Promise<DeviceView>;
}
