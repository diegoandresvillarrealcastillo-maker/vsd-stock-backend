import type { DatabaseHealth, DatabaseStatus } from '../../../domain/ports/out/database-health.js';
import type { BusinessScope, UnitOfWork } from '../../../domain/ports/out/unit-of-work.js';

/** Se lanza cuando algo pide la base de datos y `DATABASE_URL` nunca se definio. */
export class DatabaseNotConfiguredError extends Error {
  constructor() {
    super('The database is not configured: set DATABASE_URL (see docs/ambientes.md)');
    this.name = 'DatabaseNotConfiguredError';
  }
}

/**
 * La «base de datos» cuando no hay ninguna: deja arrancar la API (el contenedor se comprueba con /health sin base) y
 * dice con claridad que falta, en lugar de fallar con un error de conexion que nadie entiende.
 */
export class NotConfiguredDatabase implements DatabaseHealth, UnitOfWork {
  check(): Promise<DatabaseStatus> {
    return Promise.resolve('not-configured');
  }

  inBusiness<T>(_businessId: string, _work: (scope: BusinessScope) => Promise<T>): Promise<T> {
    return Promise.reject(new DatabaseNotConfiguredError());
  }
}
