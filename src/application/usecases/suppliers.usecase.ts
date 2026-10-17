import { endsInUuid, pageOf, readPageRequest, type Page } from '../../domain/model/pagination.js';
import { SupplierNotFoundError } from '../../domain/model/purchase-errors.js';
import {
  NEW_SUPPLIER_FIELDS,
  SUPPLIER_CHANGE_FIELDS,
  readNewSupplier,
  readSupplierChange,
} from '../../domain/model/supplier-input.js';
import { isUuid } from '../../domain/model/uuid.js';
import { InputReader } from '../../domain/model/validation.js';
import type { Session } from '../../domain/ports/in/authenticate.js';
import type { SupplierView, Suppliers } from '../../domain/ports/in/purchasing.js';
import type { UnitOfWork } from '../../domain/ports/out/unit-of-work.js';
import { ensureCan, requireMember } from '../session-guards.js';

/**
 * Casos de uso de los proveedores (C2-06). Son de la gerencia: quien puede registrar una compra (`purchase:create`,
 * ADR 0017) puede llevar su lista de proveedores. Solo tienen nombre y un contacto; no hay unicidad.
 */
export class SuppliersUseCase implements Suppliers {
  constructor(private readonly work: UnitOfWork) {}

  async list(session: Session, query: unknown): Promise<Page<SupplierView>> {
    const actor = requireMember(session);
    ensureCan(actor, 'purchase:create');

    const reader = new InputReader(query, ['limit', 'cursor']);
    const request = readPageRequest(reader, 2, endsInUuid);
    reader.finish();

    const [afterName, afterId] = request.after ?? [];
    const rows = await this.work.inBusiness(actor.businessId, (scope) =>
      scope.suppliers.list({
        // Una de mas: si llega, hay otra pagina.
        limit: request.limit + 1,
        ...(afterName !== undefined && afterId !== undefined
          ? { after: [afterName, afterId] as const }
          : {}),
      }),
    );
    return pageOf(rows, request.limit, (supplier) => [supplier.name, supplier.id]);
  }

  async create(session: Session, body: unknown): Promise<SupplierView> {
    const actor = requireMember(session);
    ensureCan(actor, 'purchase:create');

    const reader = new InputReader(body, NEW_SUPPLIER_FIELDS);
    const supplier = readNewSupplier(reader);
    reader.finish();

    return this.work.inBusiness(actor.businessId, (scope) => scope.suppliers.create(supplier));
  }

  async update(session: Session, supplierId: string, body: unknown): Promise<SupplierView> {
    const actor = requireMember(session);
    ensureCan(actor, 'purchase:create');

    const reader = new InputReader(body, SUPPLIER_CHANGE_FIELDS);
    const change = readSupplierChange(reader);
    reader.finish();
    // Un identificador que no es un UUID no es de nadie: no se le pregunta nada a la base.
    if (!isUuid(supplierId)) throw new SupplierNotFoundError();

    return this.work.inBusiness(actor.businessId, async (scope) => {
      if ((await scope.suppliers.find(supplierId)) === null) throw new SupplierNotFoundError();
      return scope.suppliers.update(supplierId, change);
    });
  }

  async remove(session: Session, supplierId: string): Promise<void> {
    const actor = requireMember(session);
    ensureCan(actor, 'purchase:create');
    if (!isUuid(supplierId)) throw new SupplierNotFoundError();

    await this.work.inBusiness(actor.businessId, async (scope) => {
      if ((await scope.suppliers.find(supplierId)) === null) throw new SupplierNotFoundError();
      await scope.suppliers.remove(supplierId);
    });
  }
}
