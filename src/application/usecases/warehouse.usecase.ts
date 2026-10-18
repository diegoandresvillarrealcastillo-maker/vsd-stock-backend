import type { Session } from '../../domain/ports/in/authenticate.js';
import type { WarehouseView, Warehouses } from '../../domain/ports/in/purchasing.js';
import type { UnitOfWork } from '../../domain/ports/out/unit-of-work.js';
import { ensureCan, requireMember } from '../session-guards.js';

/**
 * La bodega del negocio (C2-06): en v2 hay una sola, creada junto con el negocio. La ven los tres roles porque
 * consultar la existencia es del mostrador (`stock:view`, ADR 0017).
 */
export class WarehouseUseCase implements Warehouses {
  constructor(private readonly work: UnitOfWork) {}

  async get(session: Session): Promise<WarehouseView> {
    const actor = requireMember(session);
    ensureCan(actor, 'stock:view');
    return this.work.inBusiness(actor.businessId, (scope) => scope.stock.warehouse());
  }
}
