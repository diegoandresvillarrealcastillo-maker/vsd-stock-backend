/** No existe ese turno en este negocio (o es de otro, o la persona no puede verlo: el cliente no distingue los casos). */
export class ShiftNotFoundError extends Error {
  constructor() {
    super('There is no such shift in this business');
    this.name = 'ShiftNotFoundError';
  }
}

/** La persona ya tiene un turno abierto en ese dispositivo: hay que cerrarlo antes de abrir otro (ADR 0026). */
export class ShiftAlreadyOpenError extends Error {
  constructor() {
    super('The person already has an open shift on this device');
    this.name = 'ShiftAlreadyOpenError';
  }
}

/** Ese identificador de turno ya es de otro turno, o de un turno de otro negocio. */
export class ShiftIdReusedError extends Error {
  constructor() {
    super('The shift id already belongs to another shift');
    this.name = 'ShiftIdReusedError';
  }
}

/** El turno ya se cerro: no se cierra otra vez ni se le mueve efectivo (el arqueo ya se hizo). */
export class ShiftClosedError extends Error {
  constructor() {
    super('The shift is already closed');
    this.name = 'ShiftClosedError';
  }
}

/**
 * Devolver efectivo pide un turno ABIERTO de quien lo devuelve (ADR 0027, punto 15): no se saca efectivo de una caja que nadie
 * esta contando. Sirve igual si no se nombro turno, si no existe, si es de otra persona o si ya se cerro.
 */
export class ShiftRequiredError extends Error {
  constructor() {
    super('Giving cash back needs an open shift of the person');
    this.name = 'ShiftRequiredError';
  }
}
