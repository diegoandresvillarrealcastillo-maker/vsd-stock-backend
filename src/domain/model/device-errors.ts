/** No existe ese dispositivo en este negocio (o es de otro: el cliente no distingue ambos casos). */
export class DeviceNotFoundError extends Error {
  constructor() {
    super('There is no such device in this business');
    this.name = 'DeviceNotFoundError';
  }
}

/** Ese identificador de dispositivo ya se registro con otro nombre, o es de otro negocio: dar por hecho el registro nuevo seria mentir. */
export class DeviceIdReusedError extends Error {
  constructor() {
    super('The device id was already registered with different data');
    this.name = 'DeviceIdReusedError';
  }
}
