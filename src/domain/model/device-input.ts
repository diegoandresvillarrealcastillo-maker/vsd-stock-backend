import type { InputReader } from './validation.js';

/** Los campos al registrar un dispositivo: el identificador que el propio dispositivo se inventa y un nombre opcional. */
export const NEW_DEVICE_FIELDS = ['id', 'name'] as const;

/** `device_name_shape` (ADR 0021): de 1 a 80 caracteres, sin caracteres de control. */
const MAX_NAME_LENGTH = 80;

/**
 * Un dispositivo por registrar. El `id` lo crea el dispositivo antes de hablar con el servidor y es la llave de la
 * idempotencia: registrar dos veces el mismo `id` no gasta otro codigo (ADR 0019). El codigo corto (`AA`, `AB`...) lo da
 * el servidor, nunca el cliente (ADR 0016).
 */
export interface NewDevice {
  readonly id: string;
  readonly name: string | null;
}

/** Lee un dispositivo nuevo. Los problemas quedan en el lector; el llamador llama a `finish()` antes de usar el resultado. */
export function readNewDevice(reader: InputReader): NewDevice {
  const id = reader.uuid('id', { label: 'El identificador del dispositivo' });
  const name = reader.isNull('name')
    ? null
    : reader.text('name', { label: 'El nombre', max: MAX_NAME_LENGTH, optional: true });
  return { id: id.toLowerCase(), name: name === undefined ? null : name };
}
