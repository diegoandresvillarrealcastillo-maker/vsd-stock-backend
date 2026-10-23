import type { TimeFlag } from '../../../domain/model/operation-time.js';
import { SaleVoidedError } from '../../../domain/model/sale-errors.js';
import type { SaleFlag } from '../../../domain/model/sale-flags.js';
import type { PaymentMethod } from '../../../domain/model/sale-input.js';
import type { TaxKind } from '../../../domain/model/tax.js';
import type {
  NewSale,
  NewSaleVoid,
  SaleHeader,
  SaleListRequest,
  SaleRecord,
  SaleRepository,
  SaleReviewRecord,
} from '../../../domain/ports/out/sales.js';
import { Prisma, type Sale } from '../../../generated/prisma/client.js';
import type { PrismaTransaction } from './prisma-unit-of-work.js';

/** El orden en que el dispositivo vendio las lineas y cobro los pagos; el identificador desempata. */
const IN_ORDER = [{ position: 'asc' }, { id: 'asc' }] as const;

/** Lo que una venta de la lista trae de la consulta: la venta, su operacion, su turno y su revision, en una sola fila. */
interface ListRow {
  readonly id: string;
  readonly operation_id: string;
  readonly shift_id: string;
  readonly folio: string;
  readonly folio_reported: string;
  readonly folio_conflict: boolean;
  readonly total: bigint;
  readonly needs_adjustment: boolean;
  readonly flags: string[];
  readonly user_id: string;
  readonly device_id: string | null;
  readonly occurred_at: Date;
  readonly received_at: Date;
  readonly time_flags: string[];
  readonly reviewed_at: Date | null;
  readonly reviewed_by: string | null;
  readonly review_note: string | null;
  readonly voided_at: Date | null;
  readonly voided_by: string | null;
  readonly void_operation_id: string | null;
  readonly void_reason: string | null;
}

/**
 * La condicion de la bandeja «Requiere atencion» (ADR 0027): existencia en negativo, folio repetido, una marca del servidor o
 * una hora de la que no se puede fiar, y que nadie la haya revisado. Dice lo mismo que `requiresAttention` del dominio, y una
 * prueba contra la base real comprueba que no se separen.
 */
const IN_TRAY = Prisma.sql`(
  (s.needs_adjustment
    OR s.folio_conflict
    OR cardinality(s.flags) > 0
    OR o.time_flags && ARRAY['clock-skew', 'future', 'unreadable']::text[])
  AND r.id IS NULL
)`;

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
        taxKind: line.taxKind,
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
    const row = await this.tx.sale.findFirst({ where: { operationId } });
    return row === null ? null : this.hydrate(row);
  }

  async find(id: string): Promise<SaleRecord | null> {
    const row = await this.tx.sale.findFirst({ where: { id } });
    return row === null ? null : this.hydrate(row);
  }

  async findByVoid(operationId: string): Promise<SaleRecord | null> {
    const voided = await this.tx.saleVoid.findFirst({ where: { operationId } });
    return voided === null ? null : this.find(voided.saleId);
  }

  async list(request: SaleListRequest): Promise<SaleHeader[]> {
    const conditions: Prisma.Sql[] = [];
    // Del mas reciente al mas viejo, por la hora efectiva al milisegundo: es la posicion que lleva el cursor.
    if (request.after !== undefined) {
      conditions.push(
        Prisma.sql`(date_trunc('milliseconds', o.occurred_at), s.id) < (${request.after[0]}::timestamptz, ${request.after[1]}::uuid)`,
      );
    }
    if (request.shiftOwnerId !== undefined) {
      conditions.push(Prisma.sql`sh.user_id = ${request.shiftOwnerId}::uuid`);
    }
    if (request.shiftId !== undefined) {
      conditions.push(Prisma.sql`s.shift_id = ${request.shiftId}::uuid`);
    }
    if (request.folio !== undefined) {
      conditions.push(
        Prisma.sql`(s.folio = ${request.folio} OR s.folio_reported = ${request.folio})`,
      );
    }
    if (request.attention !== undefined) {
      conditions.push(request.attention ? IN_TRAY : Prisma.sql`NOT ${IN_TRAY}`);
    }
    const where =
      conditions.length === 0
        ? Prisma.empty
        : Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`;

    const rows = await this.tx.$queryRaw<ListRow[]>(Prisma.sql`
      SELECT s.id, s.operation_id, s.shift_id, s.folio, s.folio_reported, s.folio_conflict, s.total,
             s.needs_adjustment, s.flags, o.user_id, o.device_id, o.occurred_at, o.received_at, o.time_flags,
             r.created_at AS reviewed_at, r.user_id AS reviewed_by, r.note AS review_note,
             v.created_at AS voided_at, vo.user_id AS voided_by, v.operation_id AS void_operation_id,
             v.reason AS void_reason
        FROM sale s
        JOIN operation o ON o.id_negocio = s.id_negocio AND o.operation_id = s.operation_id
        JOIN cash_shift sh ON sh.id_negocio = s.id_negocio AND sh.id = s.shift_id
        LEFT JOIN sale_review r ON r.id_negocio = s.id_negocio AND r.sale_id = s.id
        LEFT JOIN sale_void v ON v.id_negocio = s.id_negocio AND v.sale_id = s.id
        LEFT JOIN operation vo ON vo.id_negocio = v.id_negocio AND vo.operation_id = v.operation_id
        ${where}
       ORDER BY date_trunc('milliseconds', o.occurred_at) DESC, s.id DESC
       LIMIT ${request.limit}`);
    return rows.map(headerOf);
  }

  async review(
    saleId: string,
    userId: string,
    note: string | null,
  ): Promise<{ review: SaleReviewRecord; created: boolean }> {
    // `ON CONFLICT DO NOTHING`: si otra peticion la esta revisando a la vez, espera a que termine y decide con lo que deje.
    const { count } = await this.tx.saleReview.createMany({
      data: [{ idNegocio: this.businessId, saleId, userId, note }],
      skipDuplicates: true,
    });
    const row = await this.tx.saleReview.findFirst({ where: { saleId } });
    if (row === null) throw new Error(`The review of the sale ${saleId} was not written`);
    return {
      review: { reviewedAt: row.createdAt, reviewedByUserId: row.userId, note: row.note },
      created: count === 1,
    };
  }

  async recordVoid(request: NewSaleVoid): Promise<SaleRecord> {
    // `ON CONFLICT DO NOTHING`: si otra peticion la esta anulando a la vez, espera a que termine y decide con lo que deje.
    const { count } = await this.tx.saleVoid.createMany({
      data: [
        {
          idNegocio: this.businessId,
          saleId: request.saleId,
          operationId: request.operationId,
          reason: request.reason,
        },
      ],
      skipDuplicates: true,
    });
    // Ya estaba anulada: lo que esta transaccion hizo antes (existencias, efectivo) se deshace con ella.
    if (count !== 1) throw new SaleVoidedError();
    const sale = await this.find(request.saleId);
    if (sale === null)
      throw new Error(`The sale ${request.saleId} vanished inside its transaction`);
    return sale;
  }

  /**
   * La venta con su operacion, sus lineas, sus cobros y su revision: una consulta tras otra, nunca varias a la vez por la misma
   * conexion de la transaccion.
   */
  private async hydrate(row: Sale): Promise<SaleRecord> {
    const operation = await this.tx.operation.findFirst({
      where: { operationId: row.operationId },
      select: { userId: true, deviceId: true, occurredAt: true, receivedAt: true, timeFlags: true },
    });
    if (operation === null) {
      throw new Error(`The sale ${row.id} has no operation ${row.operationId}`);
    }
    const lines = await this.tx.saleLine.findMany({
      where: { saleId: row.id },
      orderBy: [...IN_ORDER],
    });
    const payments = await this.tx.payment.findMany({
      where: { saleId: row.id },
      orderBy: [...IN_ORDER],
    });
    const review = await this.tx.saleReview.findFirst({ where: { saleId: row.id } });
    const voided = await this.tx.saleVoid.findFirst({ where: { saleId: row.id } });
    const voidOperation =
      voided === null
        ? null
        : await this.tx.operation.findFirst({
            where: { operationId: voided.operationId },
            select: { userId: true },
          });
    if (voided !== null && voidOperation === null) {
      throw new Error(`The void ${voided.id} has no operation ${voided.operationId}`);
    }
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
      review:
        review === null
          ? null
          : { reviewedAt: review.createdAt, reviewedByUserId: review.userId, note: review.note },
      voided:
        voided === null || voidOperation === null
          ? null
          : {
              voidedAt: voided.createdAt,
              voidedByUserId: voidOperation.userId,
              operationId: voided.operationId,
              reason: voided.reason,
            },
      lines: lines.map((line) => ({
        productId: line.productId,
        quantityMilli: Number(line.quantityMilli),
        unitPrice: Number(line.unitPrice),
        discount: Number(line.discount),
        taxRateBp: line.taxRateBp,
        // La base solo deja guardar los tres tipos (`sale_line_tax_kind_fits_rate`, ADR 0034).
        taxKind: line.taxKind as TaxKind,
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

function headerOf(row: ListRow): SaleHeader {
  return {
    id: row.id,
    operationId: row.operation_id,
    shiftId: row.shift_id,
    deviceId: row.device_id,
    userId: row.user_id,
    folio: row.folio,
    folioReported: row.folio_reported,
    folioConflict: row.folio_conflict,
    total: Number(row.total),
    needsAdjustment: row.needs_adjustment,
    flags: row.flags as SaleFlag[],
    timeFlags: row.time_flags as TimeFlag[],
    occurredAt: row.occurred_at,
    receivedAt: row.received_at,
    review:
      row.reviewed_at === null || row.reviewed_by === null
        ? null
        : { reviewedAt: row.reviewed_at, reviewedByUserId: row.reviewed_by, note: row.review_note },
    voided:
      row.voided_at === null ||
      row.voided_by === null ||
      row.void_operation_id === null ||
      row.void_reason === null
        ? null
        : {
            voidedAt: row.voided_at,
            voidedByUserId: row.voided_by,
            operationId: row.void_operation_id,
            reason: row.void_reason,
          },
  };
}
