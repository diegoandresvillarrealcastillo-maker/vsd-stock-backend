/** Identificador de inyeccion del reloj (puerto de salida Clock). */
export const CLOCK = Symbol('CLOCK');

/** Identificador de inyeccion del cliente de Prisma (solo existe si hay base de datos). */
export const PRISMA_CLIENT = Symbol('PRISMA_CLIENT');

/** Identificador de inyeccion del puerto de salida DatabaseHealth. */
export const DATABASE_HEALTH = Symbol('DATABASE_HEALTH');

/** Identificador de inyeccion del puerto de salida UnitOfWork. */
export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');

/** Identificador de inyeccion del puerto de salida TokenVerifier. */
export const TOKEN_VERIFIER = Symbol('TOKEN_VERIFIER');

/** Identificador de inyeccion del puerto de salida IdentityDirectory. */
export const IDENTITY_DIRECTORY = Symbol('IDENTITY_DIRECTORY');
