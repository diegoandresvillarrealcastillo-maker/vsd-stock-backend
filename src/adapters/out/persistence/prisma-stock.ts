import { WarehouseMissingError } from '../../../domain/model/purchase-errors.js';
import { isUnitOfMeasure } from '../../../domain/model/unit-of-measure.js';
import type { ListRequest } from '../../../domain/ports/out/catalog.js';
import type {
  ChangedStockRequest,
  MovementListRequest,
  StockChange,
  StockFilter,
  StockLedger,
  StockLevel,
  StockMovementKind,
  StockMovementRecord,
  StockRecord,
  WarehouseRecord,
} from '../../../domain/ports/out/stock.js';
import { Prisma } from '../../../generated/prisma/client.js';
import { literal } from './like-literal.js';
import type { PrismaTransaction } from './prisma-unit-of-work.js';

interface StockRow {
  readonly id: string;
  readonly name: string;
  readonly sku: string;
  readonly unit: string;
  readonly active: boolean;
  readonly minStockMilli: bigint | null;
  readonly quantity: bigint;
}

interface MovementRow {
  readonly id: string;
  readonly operationId: string;
  readonly productId: string;
  readonly kind: string;
  readonly delta: bigint;
  readonly note: string | null;
  /** El instante truncado al milisegundo, escrito como lo escribe `toISOString()`. */
  readonly createdKey: string;
}

const KINDS: readonly string[] = ['sale', 'purchase', 'adjustment', 'void'];

/**
 * Los movimientos se leen con SQL a mano por la misma razon que las compras: la base guarda el instante con microsegundos
 * y un `Date` solo llega al milisegundo, asi que el orden, la posicion del cursor y lo que se entrega usan la MISMA clave.
 */
const SELECT_MOVEMENTS = Prisma.sql`
  SELECT m.id, m.operation_id AS "operationId", m.product_id AS "productId", m.reason AS kind, m.delta, m.note,
         to_char(date_trunc('milliseconds', m.created_at) AT TIME ZONE 'UTC',
                 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdKey"
    FROM stock_movement m`;

function stockOf(row: StockRow): StockRecord {
  if (!isUnitOfMeasure(row.unit)) {
    // La base lo impide con una restriccion; si llegara aqui, mejor caer que dar una unidad que no existe.
    throw new Error(`The product ${row.id} has a unit that does not exist`);
  }
  // La base los limita (mil millones de milesimas): un `number` no pierde nada.
  const quantityMilli = Number(row.quantity);
  const minStockMilli = row.minStockMilli === null ? null : Number(row.minStockMilli);
  return {
    productId: row.id,
    name: row.name,
    sku: row.sku,
    unit: row.unit,
    active: row.active,
    quantityMilli,
    minStockMilli,
    belowMinimum: minStockMilli !== null && quantityMilli < minStockMilli,
  };
}

function movementOf(row: MovementRow): StockMovementRecord {
  if (!KINDS.includes(row.kind)) {
    throw new Error(`The movement ${row.id} has a kind that does not exist`);
  }
  return {
    id: row.id,
    operationId: row.operationId,
    productId: row.productId,
    kind: row.kind as StockMovementKind,
    deltaMilli: Number(row.delta),
    reason: row.note,
    createdAt: new Date(row.createdKey),
  };
}

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

  async quantitiesOf(productIds: readonly string[]): Promise<ReadonlyMap<string, number>> {
    const rows = await this.tx.stockBalance.findMany({
      where: { productId: { in: [...productIds] } },
      select: { productId: true, quantity: true },
    });
    const found = new Map(rows.map((row) => [row.productId, Number(row.quantity)]));
    return new Map(productIds.map((productId) => [productId, found.get(productId) ?? 0]));
  }

  async list(request: ListRequest & { filter: StockFilter }): Promise<StockRecord[]> {
    const { search, categoryId, active, belowMinimum } = request.filter;
    const after = request.after;
    const conditions: Prisma.Sql[] = [];
    // Por nombre y luego por id: la misma posicion que el cursor, que no cambia si alguien se suma.
    if (after !== undefined) {
      conditions.push(Prisma.sql`(p.name, p.id) > (${after[0]}, ${after[1]}::uuid)`);
    }
    if (search !== undefined) {
      const like = `%${literal(search)}%`;
      conditions.push(
        Prisma.sql`(p.name ILIKE ${like} OR p.sku ILIKE ${like} OR p.barcode = ${search})`,
      );
    }
    if (categoryId !== undefined) conditions.push(Prisma.sql`p.category_id = ${categoryId}::uuid`);
    if (active !== undefined) conditions.push(Prisma.sql`p.active = ${active}`);
    if (belowMinimum === true) {
      conditions.push(
        Prisma.sql`(p.min_stock_milli IS NOT NULL AND s.quantity < p.min_stock_milli)`,
      );
    }
    const where =
      conditions.length === 0
        ? Prisma.empty
        : Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`;

    // La existencia es la suma de los saldos del producto: un producto sin movimientos tiene cero.
    const rows = await this.tx.$queryRaw<StockRow[]>(Prisma.sql`
      SELECT p.id, p.name, p.sku, p.unit, p.active, p.min_stock_milli AS "minStockMilli", s.quantity
        FROM product p
        CROSS JOIN LATERAL (
          SELECT COALESCE(sum(b.quantity), 0)::bigint AS quantity
            FROM stock_balance b
           WHERE b.id_negocio = p.id_negocio AND b.product_id = p.id
        ) s
        ${where}
       ORDER BY p.name, p.id
       LIMIT ${request.limit}`);
    return rows.map(stockOf);
  }

  async listStockChanged(request: ChangedStockRequest): Promise<StockLevel[]> {
    const conditions: Prisma.Sql[] = [];
    if (request.after !== undefined)
      conditions.push(Prisma.sql`b.product_id > ${request.after}::uuid`);
    if (request.since !== undefined) {
      // Se movio despues de `since`: el libro lo dice (no hace falta una hora en el saldo). Al milisegundo, como el resto.
      conditions.push(
        Prisma.sql`EXISTS (
          SELECT 1 FROM stock_movement m
           WHERE m.id_negocio = b.id_negocio AND m.product_id = b.product_id
             AND date_trunc('milliseconds', m.created_at) > ${request.since.toISOString()}::timestamptz
        )`,
      );
    }
    const where =
      conditions.length === 0
        ? Prisma.empty
        : Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`;
    const rows = await this.tx.$queryRaw<{ product_id: string; quantity: bigint }[]>(Prisma.sql`
      SELECT b.product_id, sum(b.quantity)::bigint AS quantity
        FROM stock_balance b
        ${where}
       GROUP BY b.product_id
       ORDER BY b.product_id
       LIMIT ${request.limit}`);
    return rows.map((row) => ({ productId: row.product_id, quantityMilli: Number(row.quantity) }));
  }

  async movements(productId: string, request: MovementListRequest): Promise<StockMovementRecord[]> {
    const after = request.after;
    const position =
      after === undefined
        ? Prisma.empty
        : Prisma.sql`AND (date_trunc('milliseconds', m.created_at), m.id)
                          < (${after[0]}::timestamptz, ${after[1]}::uuid)`;
    const rows = await this.tx.$queryRaw<MovementRow[]>(
      Prisma.sql`${SELECT_MOVEMENTS}
        WHERE m.product_id = ${productId}::uuid ${position}
        ORDER BY date_trunc('milliseconds', m.created_at) DESC, m.id DESC
        LIMIT ${request.limit}`,
    );
    return rows.map(movementOf);
  }

  async movementOfOperation(operationId: string): Promise<StockMovementRecord | null> {
    const rows = await this.tx.$queryRaw<MovementRow[]>(
      Prisma.sql`${SELECT_MOVEMENTS}
        WHERE m.operation_id = ${operationId}::uuid
        ORDER BY m.created_at ASC, m.id ASC
        LIMIT 1`,
    );
    const row = rows[0];
    return row === undefined ? null : movementOf(row);
  }
}
