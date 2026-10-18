import {
  SupplierInUseError,
  SupplierNotFoundError,
  WarehouseMissingError,
} from '../../src/domain/model/purchase-errors.js';
import type { NewSupplier, SupplierChange } from '../../src/domain/model/supplier-input.js';
import type { ListRequest } from '../../src/domain/ports/out/catalog.js';
import type { FakeCatalog } from './fake-catalog.js';
import type {
  OperationClaim,
  OperationClaimRequest,
  OperationRegistry,
} from '../../src/domain/ports/out/operations.js';
import type {
  NewPurchase,
  PurchaseListRequest,
  PurchaseRecord,
  PurchaseRepository,
  PurchaseSummary,
} from '../../src/domain/ports/out/purchases.js';
import type {
  MovementListRequest,
  StockChange,
  StockFilter,
  StockLedger,
  StockMovementRecord,
  StockRecord,
  WarehouseRecord,
} from '../../src/domain/ports/out/stock.js';
import type { SupplierRecord, SupplierRepository } from '../../src/domain/ports/out/suppliers.js';

export const WAREHOUSE_ID = 'aaaa0000-0000-4000-8000-000000000001';

const byNameThenId = (a: SupplierRecord, b: SupplierRecord): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** Los proveedores de un negocio en memoria. Hace lo mismo que el adaptador de Prisma, sin base. */
export class FakeSuppliers implements SupplierRepository {
  readonly records: SupplierRecord[] = [];
  private counter = 0;

  constructor(private readonly purchases: FakePurchases) {}

  list(request: ListRequest): Promise<SupplierRecord[]> {
    const sorted = [...this.records].sort(byNameThenId);
    const after = request.after;
    const rest =
      after === undefined
        ? sorted
        : sorted.filter(
            (supplier) =>
              supplier.name > after[0] || (supplier.name === after[0] && supplier.id > after[1]),
          );
    return Promise.resolve(rest.slice(0, request.limit));
  }

  find(id: string): Promise<SupplierRecord | null> {
    return Promise.resolve(this.records.find((supplier) => supplier.id === id) ?? null);
  }

  create(supplier: NewSupplier): Promise<SupplierRecord> {
    this.counter += 1;
    const record: SupplierRecord = {
      id: `5e000000-0000-4000-8000-${String(this.counter).padStart(12, '0')}`,
      name: supplier.name,
      contact: supplier.contact,
      createdAt: new Date('2026-10-17T12:00:00.000Z'),
    };
    this.records.push(record);
    return Promise.resolve(record);
  }

  update(id: string, change: SupplierChange): Promise<SupplierRecord> {
    const index = this.records.findIndex((supplier) => supplier.id === id);
    const current = this.records[index];
    if (current === undefined) return Promise.reject(new SupplierNotFoundError());
    const updated: SupplierRecord = {
      ...current,
      name: change.name ?? current.name,
      contact: change.contact === undefined ? current.contact : change.contact,
    };
    this.records[index] = updated;
    return Promise.resolve(updated);
  }

  remove(id: string): Promise<void> {
    const index = this.records.findIndex((supplier) => supplier.id === id);
    if (index < 0) return Promise.reject(new SupplierNotFoundError());
    if (this.purchases.records.some((purchase) => purchase.supplierId === id)) {
      return Promise.reject(new SupplierInUseError());
    }
    this.records.splice(index, 1);
    return Promise.resolve();
  }
}

/** Las compras de un negocio en memoria. Cada una nace un minuto despues de la anterior. */
export class FakePurchases implements PurchaseRepository {
  readonly records: PurchaseRecord[] = [];
  private counter = 0;

  create(purchase: NewPurchase): Promise<PurchaseRecord> {
    this.counter += 1;
    const record: PurchaseRecord = {
      id: `b0000000-0000-4000-8000-${String(this.counter).padStart(12, '0')}`,
      operationId: purchase.operationId,
      warehouseId: purchase.warehouseId,
      supplierId: purchase.supplierId,
      note: purchase.note,
      createdAt: new Date(Date.UTC(2026, 9, 17, 12, this.counter)),
      createdByUserId: purchase.userId,
      // Como el adaptador: las lineas salen por producto, no en el orden en que llegaron.
      lines: purchase.lines
        .map((line) => ({ ...line }))
        .sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0)),
    };
    this.records.push(record);
    return Promise.resolve(record);
  }

  find(id: string): Promise<PurchaseRecord | null> {
    return Promise.resolve(this.records.find((purchase) => purchase.id === id) ?? null);
  }

  findByOperation(operationId: string): Promise<PurchaseRecord | null> {
    return Promise.resolve(
      this.records.find((purchase) => purchase.operationId === operationId) ?? null,
    );
  }

  list(request: PurchaseListRequest): Promise<PurchaseSummary[]> {
    const newestFirst = [...this.records].sort((a, b) => {
      const byTime = b.createdAt.getTime() - a.createdAt.getTime();
      return byTime !== 0 ? byTime : a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    });
    const after = request.after;
    const rest =
      after === undefined
        ? newestFirst
        : newestFirst.filter((purchase) => {
            const at = purchase.createdAt.toISOString();
            return at < after[0] || (at === after[0] && purchase.id < after[1]);
          });
    return Promise.resolve(
      rest.slice(0, request.limit).map(({ lines, ...purchase }) => ({
        ...purchase,
        lineCount: lines.length,
      })),
    );
  }
}

/** El libro de existencias en memoria: cada llamada a `addMovements` queda anotada, y los saldos se suman. */
export class FakeStock implements StockLedger {
  /** Lo que cada llamada recibio, en el orden en que el libro lo aplico. */
  readonly applied: { operationId: string; changes: StockChange[] }[] = [];
  readonly balances = new Map<string, number>();
  /** El libro: cada movimiento que se agrego, en orden. */
  readonly book: StockMovementRecord[] = [];
  /** El catalogo del que salen los productos de la lista de existencias. */
  catalog: FakeCatalog | undefined;
  warehouseRecord: WarehouseRecord | null = { id: WAREHOUSE_ID, name: 'Principal' };
  private counter = 0;

  warehouse(): Promise<WarehouseRecord> {
    return this.warehouseRecord === null
      ? Promise.reject(new WarehouseMissingError())
      : Promise.resolve(this.warehouseRecord);
  }

  addMovements(operationId: string, changes: readonly StockChange[]): Promise<void> {
    const ordered = [...changes].sort((a, b) =>
      a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0,
    );
    this.applied.push({ operationId, changes: ordered });
    for (const change of ordered) {
      this.counter += 1;
      this.book.push({
        id: `d0000000-0000-4000-8000-${String(this.counter).padStart(12, '0')}`,
        operationId,
        productId: change.productId,
        kind: change.reason,
        deltaMilli: change.delta,
        reason: change.note,
        createdAt: new Date(Date.UTC(2026, 9, 17, 13, this.counter)),
      });
      this.balances.set(
        change.productId,
        (this.balances.get(change.productId) ?? 0) + change.delta,
      );
    }
    return Promise.resolve();
  }

  list(request: ListRequest & { filter: StockFilter }): Promise<StockRecord[]> {
    const { search, categoryId, active, belowMinimum } = request.filter;
    const rows: StockRecord[] = (this.catalog?.products ?? [])
      .map((product) => {
        const quantityMilli = this.balances.get(product.id) ?? 0;
        return {
          productId: product.id,
          name: product.name,
          sku: product.sku,
          unit: product.unit,
          active: product.active,
          quantityMilli,
          minStockMilli: product.minStockMilli,
          belowMinimum: product.minStockMilli !== null && quantityMilli < product.minStockMilli,
          categoryId: product.categoryId,
          barcode: product.barcode,
        };
      })
      .filter((row) => {
        if (search !== undefined) {
          const needle = search.toLowerCase();
          const hit =
            row.name.toLowerCase().includes(needle) ||
            row.sku.toLowerCase().includes(needle) ||
            row.barcode === search;
          if (!hit) return false;
        }
        if (categoryId !== undefined && row.categoryId !== categoryId) return false;
        if (active !== undefined && row.active !== active) return false;
        if (belowMinimum === true && !row.belowMinimum) return false;
        return true;
      })
      .map(({ categoryId: _category, barcode: _barcode, ...row }) => row)
      .sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : a.productId < b.productId ? -1 : 1,
      );
    const after = request.after;
    const rest =
      after === undefined
        ? rows
        : rows.filter(
            (row) => row.name > after[0] || (row.name === after[0] && row.productId > after[1]),
          );
    return Promise.resolve(rest.slice(0, request.limit));
  }

  movements(productId: string, request: MovementListRequest): Promise<StockMovementRecord[]> {
    const newestFirst = this.book
      .filter((movement) => movement.productId === productId)
      .sort((a, b) => {
        const byTime = b.createdAt.getTime() - a.createdAt.getTime();
        return byTime !== 0 ? byTime : a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
      });
    const after = request.after;
    const rest =
      after === undefined
        ? newestFirst
        : newestFirst.filter((movement) => {
            const at = movement.createdAt.toISOString();
            return at < after[0] || (at === after[0] && movement.id < after[1]);
          });
    return Promise.resolve(rest.slice(0, request.limit));
  }

  movementOfOperation(operationId: string): Promise<StockMovementRecord | null> {
    return Promise.resolve(
      this.book.find((movement) => movement.operationId === operationId) ?? null,
    );
  }
}

/** El registro de operaciones en memoria: la primera vez reclama, la misma operacion con el mismo cuerpo repite. */
export class FakeOperations implements OperationRegistry {
  readonly claims = new Map<
    string,
    { kind: string; fingerprint: string; userId: string; request: OperationClaimRequest }
  >();

  claim(request: OperationClaimRequest): Promise<OperationClaim> {
    const known = this.claims.get(request.operationId);
    if (known === undefined) {
      this.claims.set(request.operationId, {
        kind: request.kind,
        fingerprint: request.fingerprint,
        userId: request.userId,
        request,
      });
      return Promise.resolve('claimed');
    }
    return Promise.resolve(
      known.kind === request.kind && known.fingerprint === request.fingerprint
        ? 'replay'
        : 'conflict',
    );
  }
}

/** Todo lo de compras de un negocio de mentira, ya conectado entre si. */
export class FakePurchasing {
  readonly purchases = new FakePurchases();
  readonly suppliers = new FakeSuppliers(this.purchases);
  readonly stock = new FakeStock();
  readonly operations = new FakeOperations();
}
