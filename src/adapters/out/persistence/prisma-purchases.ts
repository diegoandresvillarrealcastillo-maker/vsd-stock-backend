import type {
  NewPurchase,
  PurchaseLineRecord,
  PurchaseListRequest,
  PurchaseRecord,
  PurchaseRepository,
  PurchaseSummary,
} from '../../../domain/ports/out/purchases.js';
import { Prisma } from '../../../generated/prisma/client.js';
import type { PrismaTransaction } from './prisma-unit-of-work.js';

interface PurchaseRow {
  readonly id: string;
  readonly operationId: string;
  readonly warehouseId: string;
  readonly supplierId: string | null;
  readonly note: string | null;
  readonly createdByUserId: string | null;
  /** El instante de creacion truncado al milisegundo, escrito como lo escribe `toISOString()`. */
  readonly createdKey: string;
  readonly lineCount: bigint;
}

/**
 * Las compras se leen con SQL a mano por una razon: la base guarda el instante con microsegundos y un `Date` de
 * JavaScript solo llega al milisegundo. Si el listado ordenara por el instante exacto pero el cursor llevara el
 * truncado, una compra podria repetirse o saltarse entre paginas. Aqui se ordena, se compara y se entrega la MISMA clave:
 * el instante truncado al milisegundo, y el id desempata.
 */
const SELECT_PURCHASES = Prisma.sql`
  SELECT p.id, p.operation_id AS "operationId", p.warehouse_id AS "warehouseId", p.supplier_id AS "supplierId",
         p.note, p.created_by_user_id AS "createdByUserId",
         to_char(date_trunc('milliseconds', p.created_at) AT TIME ZONE 'UTC',
                 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdKey",
         (SELECT count(*) FROM purchase_line l
           WHERE l.id_negocio = p.id_negocio AND l.purchase_id = p.id) AS "lineCount"
    FROM purchase p`;

function summaryOf(row: PurchaseRow): PurchaseSummary {
  return {
    id: row.id,
    operationId: row.operationId,
    warehouseId: row.warehouseId,
    supplierId: row.supplierId,
    note: row.note,
    createdAt: new Date(row.createdKey),
    createdByUserId: row.createdByUserId,
    lineCount: Number(row.lineCount),
  };
}

/** Las compras del negocio de la transaccion, sobre Prisma. La seguridad por fila deja ver y escribir solo lo de ese negocio. */
export class PrismaPurchaseRepository implements PurchaseRepository {
  constructor(
    private readonly tx: PrismaTransaction,
    private readonly businessId: string,
  ) {}

  async create(purchase: NewPurchase): Promise<PurchaseRecord> {
    const created = await this.tx.purchase.create({
      data: {
        idNegocio: this.businessId,
        operationId: purchase.operationId,
        warehouseId: purchase.warehouseId,
        supplierId: purchase.supplierId,
        note: purchase.note,
        createdByUserId: purchase.userId,
      },
      select: { id: true },
    });
    await this.tx.purchaseLine.createMany({
      data: purchase.lines.map((line) => ({
        idNegocio: this.businessId,
        purchaseId: created.id,
        productId: line.productId,
        quantityMilli: BigInt(line.quantityMilli),
        unitCost: BigInt(line.unitCost),
      })),
    });
    const saved = await this.find(created.id);
    if (saved === null)
      throw new Error(`The purchase ${created.id} vanished inside its transaction`);
    return saved;
  }

  async find(id: string): Promise<PurchaseRecord | null> {
    const rows = await this.tx.$queryRaw<PurchaseRow[]>(
      Prisma.sql`${SELECT_PURCHASES} WHERE p.id = ${id}::uuid`,
    );
    return this.withLines(rows[0]);
  }

  async findByOperation(operationId: string): Promise<PurchaseRecord | null> {
    const rows = await this.tx.$queryRaw<PurchaseRow[]>(
      Prisma.sql`${SELECT_PURCHASES} WHERE p.operation_id = ${operationId}::uuid`,
    );
    return this.withLines(rows[0]);
  }

  async list(request: PurchaseListRequest): Promise<PurchaseSummary[]> {
    const after = request.after;
    const position =
      after === undefined
        ? Prisma.empty
        : Prisma.sql`WHERE (date_trunc('milliseconds', p.created_at), p.id)
                          < (${after[0]}::timestamptz, ${after[1]}::uuid)`;
    const rows = await this.tx.$queryRaw<PurchaseRow[]>(
      Prisma.sql`${SELECT_PURCHASES} ${position}
        ORDER BY date_trunc('milliseconds', p.created_at) DESC, p.id DESC
        LIMIT ${request.limit}`,
    );
    return rows.map(summaryOf);
  }

  private async withLines(row: PurchaseRow | undefined): Promise<PurchaseRecord | null> {
    if (row === undefined) return null;
    const lines = await this.tx.purchaseLine.findMany({
      where: { purchaseId: row.id },
      // Por producto, siempre: asi la misma compra se entrega igual la primera vez y en cada repeticion.
      orderBy: { productId: 'asc' },
      select: { productId: true, quantityMilli: true, unitCost: true },
    });
    const { lineCount: _lineCount, ...summary } = summaryOf(row);
    return {
      ...summary,
      lines: lines.map((line): PurchaseLineRecord => ({
        productId: line.productId,
        // La base los limita (mil millones de milesimas y un billon de pesos): un `number` no pierde nada.
        quantityMilli: Number(line.quantityMilli),
        unitCost: Number(line.unitCost),
      })),
    };
  }
}
