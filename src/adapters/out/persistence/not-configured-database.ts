import { DatabaseNotConfiguredError } from '../../../domain/model/database-not-configured-error.js';
import type { DatabaseHealth, DatabaseStatus } from '../../../domain/ports/out/database-health.js';
import type {
  IdentityDirectory,
  Membership,
} from '../../../domain/ports/out/identity-directory.js';
import type { BusinessScope, UnitOfWork } from '../../../domain/ports/out/unit-of-work.js';

/**
 * La «base de datos» cuando no hay ninguna: deja arrancar la API (el contenedor se comprueba con /health sin base) y
 * dice con claridad que falta, en lugar de fallar con un error de conexion que nadie entiende.
 */
export class NotConfiguredDatabase implements DatabaseHealth, UnitOfWork, IdentityDirectory {
  check(): Promise<DatabaseStatus> {
    return Promise.resolve('not-configured');
  }

  inBusiness<T>(_businessId: string, _work: (scope: BusinessScope) => Promise<T>): Promise<T> {
    return Promise.reject(new DatabaseNotConfiguredError());
  }

  findMembership(_authUserId: string): Promise<Membership | null> {
    return Promise.reject(new DatabaseNotConfiguredError());
  }
}
