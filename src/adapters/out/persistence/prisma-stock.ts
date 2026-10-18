import { WarehouseMissingError } from '../../../domain/model/purchase-errors.js';
import type { StockChange, StockLedger, WarehouseRecord } from '../../../domain/ports/out/stock.js';
import type { PrismaTransaction } from './prisma-unit-of-work.js';

/**
 * El libro de existencias del negocio de la transaccion, sobre Prisma (ADR 0013). Aqui solo se agregan movimientos: el
 * saldo lo sube el disparador `apply_stock_movement` en la misma transaccion, y la aplicacion no puede escribirlo.
 */
export class PrismaStockLedger implements StockLedger {
  constructor(
    private readonly tx: PrismaTransaction,
    private readonly businessId: string,
  ) {}

  async warehouse(): Promise<WarehouseRecord> {
    // En v2 hay una sola por negocio; si algun dia hay mas, la mas antigua es la principal.
    const row = await this.tx.warehouse.findFirst({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true },
    });
    if (row === null) throw new WarehouseMissingError();
    return row;
  }

  async addMovements(operationId: string, changes: readonly StockChange[]): Promise<void> {
    if (changes.length === 0) return;
    const warehouse = await this.warehouse();
    // Siempre por producto: el disparador bloquea el saldo de cada uno en el orden en que llegan, y si todas las
    // transacciones piden los mismos productos en el mismo orden no se abrazan (ADR 0013).
    const ordered = [...changes].sort((a, b) =>
      a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0,
    );
    await this.tx.stockMovement.createMany({
      data: ordered.map((change) => ({
        idNegocio: this.businessId,
        operationId,
        warehouseId: warehouse.id,
        productId: change.productId,
        delta: BigInt(change.delta),
        reason: change.reason,
        note: change.note,
      })),
    });
  }
}
