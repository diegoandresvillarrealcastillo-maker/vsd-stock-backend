import type { TimeFlag } from '../../../domain/model/operation-time.js';
import type { SaleFlag } from '../../../domain/model/sale-flags.js';
import type { PaymentMethod } from '../../../domain/model/sale-input.js';
import type { NewSale, SaleRecord, SaleRepository } from '../../../domain/ports/out/sales.js';
import type { PrismaTransaction } from './prisma-unit-of-work.js';

/** El orden en que el dispositivo vendio las lineas y cobro los pagos; el identificador desempata. */
const IN_ORDER = [{ position: 'asc' }, { id: 'asc' }] as const;

/** Las ventas del negocio de la transaccion, sobre Prisma. La seguridad por fila deja ver y escribir solo lo de ese negocio. */
export class PrismaSaleRepository implements SaleRepository {
  constructor(
    private readonly tx: PrismaTransaction,
    private readonly businessId: string,
  ) {}

  async create(sale: NewSale): Promise<SaleRecord> {
    await this.insertSale(sale);
    const saleId = await this.idOfOperation(sale.operationId);
    await this.tx.saleLine.createMany({
      data: sale.lines.map((line, position) => ({
        idNegocio: this.businessId,
        saleId,
        productId: line.productId,
        quantityMilli: BigInt(line.quantityMilli),
        unitPrice: BigInt(line.unitPrice),
        taxRateBp: line.taxRateBp,
        discount: BigInt(line.discount),
        position,
      })),
    });
    if (sale.payments.length > 0) {
      await this.tx.payment.createMany({
        data: sale.payments.map((payment, position) => ({
          idNegocio: this.businessId,
          saleId,
          method: payment.method,
          amount: BigInt(payment.amount),
          reference: payment.reference,
          position,
        })),
      });
    }
    const created = await this.findByOperation(sale.operationId);
    if (created === null)
      throw new Error(`The sale of ${sale.operationId} vanished inside its transaction`);
    return created;
  }

  async findByOperation(operationId: string): Promise<SaleRecord | null> {
    // Una consulta tras otra: con `include`, Prisma lanza varias a la vez por la misma conexion de la transaccion, y `pg`
    // ya avisa que eso dejara de funcionar.
    const row = await this.tx.sale.findFirst({ where: { operationId } });
    if (row === null) return null;
    const operation = await this.tx.operation.findFirst({
      where: { operationId },
      select: { userId: true, deviceId: true, occurredAt: true, receivedAt: true, timeFlags: true },
    });
    if (operation === null) throw new Error(`The sale ${row.id} has no operation ${operationId}`);
    const lines = await this.tx.saleLine.findMany({
      where: { saleId: row.id },
      orderBy: [...IN_ORDER],
    });
    const payments = await this.tx.payment.findMany({
      where: { saleId: row.id },
      orderBy: [...IN_ORDER],
    });
    return {
      id: row.id,
      operationId: row.operationId,
      shiftId: row.shiftId,
      deviceId: operation.deviceId,
      userId: operation.userId,
      folio: row.folio,
      folioReported: row.folioReported,
      folioConflict: row.folioConflict,
      total: Number(row.total),
      needsAdjustment: row.needsAdjustment,
      // La base solo deja guardar marcas conocidas (`sale_flags_known`), y la hora, las de su propia lista.
      flags: row.flags as SaleFlag[],
      timeFlags: operation.timeFlags as TimeFlag[],
      occurredAt: operation.occurredAt,
      receivedAt: operation.receivedAt,
      lines: lines.map((line) => ({
        productId: line.productId,
        quantityMilli: Number(line.quantityMilli),
        unitPrice: Number(line.unitPrice),
        discount: Number(line.discount),
        taxRateBp: line.taxRateBp,
      })),
      payments: payments.map((payment) => ({
        method: payment.method as PaymentMethod,
        amount: Number(payment.amount),
        reference: payment.reference,
      })),
    };
  }

  private async idOfOperation(operationId: string): Promise<string> {
    const row = await this.tx.sale.findFirst({ where: { operationId }, select: { id: true } });
    if (row === null) throw new Error(`The sale of ${operationId} was not written`);
    return row.id;
  }

  /**
   * Escribe la venta con el folio que trajo. Si ya es de otra venta (un dispositivo clonado o un disco copiado), la guarda
   * con `~` y ocho caracteres de su operacion, marcada como conflicto, y conserva el folio que trajo (ADR 0016): una venta
   * que ya ocurrio en el mostrador nunca se rechaza. `ON CONFLICT DO NOTHING` espera si otra transaccion esta escribiendo
   * ese mismo folio, y decide con lo que ella deje al confirmar o deshacerse.
   */
  private async insertSale(sale: NewSale): Promise<void> {
    const attempts = [
      sale.folio,
      `${sale.folio}~${sale.operationId.slice(0, 8)}`,
      // Si hasta eso estuviera tomado (dos operaciones con los mismos ocho caracteres), la operacion entera no se repite.
      `${sale.folio}~${sale.operationId}`,
    ];
    for (const [index, folio] of attempts.entries()) {
      const { count } = await this.tx.sale.createMany({
        data: [
          {
            idNegocio: this.businessId,
            operationId: sale.operationId,
            shiftId: sale.shiftId,
            folio,
            folioReported: sale.folio,
            folioConflict: index > 0,
            total: BigInt(sale.total),
            needsAdjustment: sale.needsAdjustment,
            flags: [...sale.flags],
          },
        ],
        skipDuplicates: true,
      });
      if (count === 1) return;
    }
    throw new Error(`No folio was left for the sale of ${sale.operationId}`);
  }
}
