import { DeviceCode } from './device-code.js';

/** El serial mas alto de un dispositivo: mil millones de ventas. */
export const MAX_SERIAL = 999_999_999;

const PADDING = 6;
const FOLIO_TEXT = /^([A-Z0-9]{2,4})-(\d+)$/;

function shorten(text: string): string {
  return text.length > 30 ? `${text.slice(0, 30)}…` : text;
}

/**
 * El numero con que una persona identifica una venta: el codigo del dispositivo que la hizo, un guion y la
 * serie de ese dispositivo, como `K7-000142` (ADR 0016). Inmutable.
 *
 * Dos dispositivos de un negocio no pueden repetir un folio porque sus codigos son distintos, y un
 * dispositivo no lo repite porque su serie solo crece. No necesita red y no cambia al sincronizar. Tampoco es
 * una secuencia del negocio: no dice el orden entre dispositivos (para eso esta la hora) y puede tener
 * saltos.
 */
export class Folio {
  readonly device: DeviceCode;
  readonly serial: number;

  private constructor(device: DeviceCode, serial: number) {
    this.device = device;
    this.serial = serial;
    Object.freeze(this);
  }

  /** Lanza RangeError si el serial no es un entero de 1 a 999 999 999. */
  static of(device: DeviceCode, serial: number): Folio {
    if (!Number.isInteger(serial) || serial < 1 || serial > MAX_SERIAL) {
      throw new RangeError(
        `A folio serial is a whole number from 1 to ${MAX_SERIAL}: ${String(serial)}`,
      );
    }
    return new Folio(device, serial);
  }

  /** Lee `K7-000142`. Solo acepta la forma canonica: el serial con seis cifras como minimo y sin ceros de mas. */
  static parse(text: string): Folio {
    if (typeof text !== 'string') {
      throw new RangeError(`A folio is read from text: ${String(text)}`);
    }
    const normalized = text.trim().toUpperCase();
    const match = FOLIO_TEXT.exec(normalized);
    if (match === null) {
      throw new RangeError(
        `"${shorten(text)}" is not a folio: a device code, a dash and at least six digits`,
      );
    }
    const folio = Folio.of(DeviceCode.parse(match[1] ?? ''), Number(match[2]));
    if (folio.toString() !== normalized) {
      throw new RangeError(
        `"${shorten(text)}" is not written the way a folio is: ${folio.toString()}`,
      );
    }
    return folio;
  }

  equals(other: Folio): boolean {
    return this.serial === other.serial && this.device.equals(other.device);
  }

  toString(): string {
    return `${this.device.value}-${String(this.serial).padStart(PADDING, '0')}`;
  }
}

/** El folio que sigue al ultimo serial que uso un dispositivo (0 si todavia no vendio nada). */
export function nextFolio(device: DeviceCode, lastSerial: number): Folio {
  if (!Number.isInteger(lastSerial) || lastSerial < 0) {
    throw new RangeError(`The last serial is a whole number from 0: ${String(lastSerial)}`);
  }
  return Folio.of(device, lastSerial + 1);
}
