import { requiresAttention } from '../../src/domain/model/sale-attention.js';
import { SaleVoidedError } from '../../src/domain/model/sale-errors.js';
import type {
  NewSale,
  SaleHeader,
  SaleListRequest,
  SaleRecord,
  SaleRepository,
  SaleReviewRecord,
  SaleVoidRecord,
  SalesOfPeriod,
  NewSaleVoid,
} from '../../src/domain/ports/out/sales.js';
import type { FakeShifts } from './fake-cash.js';
import type { FakeOperations } from './fake-purchasing.js';

/** Una venta guardada, sin su revision ni su anulacion: se anotan aparte, como en la base (otras filas). */
type StoredSale = Omit<SaleRecord, 'review' | 'voided'>;

const newestFirst = (a: StoredSale, b: StoredSale): number =>
  b.occurredAt.getTime() - a.occurredAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/**
 * Las ventas de un negocio en memoria. Hace lo mismo que el adaptador de Prisma, sin base: el folio repetido se guarda con
 * otro y marcado, y la hora, la persona y el dispositivo salen de la operacion que la trajo.
 */
export class FakeSales implements SaleRepository {
  readonly records: StoredSale[] = [];
  /** La revision de cada venta, por su identificador. */
  readonly reviews = new Map<string, SaleReviewRecord>();
  /** La hora con que se anota una revision. */
  reviewedAt = new Date('2026-10-19T09:00:00.000Z');
  /** La anulacion de cada venta, por su identificador. */
  readonly voids = new Map<string, SaleVoidRecord>();
  /** La hora con que se anota una anulacion. */
  voidedAt = new Date('2026-10-19T10:00:00.000Z');
  private counter = 0;

  constructor(
    private readonly operations: FakeOperations,
    private readonly shifts: FakeShifts,
  ) {}

  create(sale: NewSale): Promise<SaleRecord> {
    const claimed = this.operations.claims.get(sale.operationId);
    if (claimed === undefined) {
      return Promise.reject(new Error(`The operation ${sale.operationId} was not claimed`));
    }
    const shift = this.shifts.records.find((record) => record.id === sale.shiftId);
    if (shift === undefined)
      return Promise.reject(new Error(`The shift ${sale.shiftId} is unknown`));
    const taken = this.records.some((record) => record.folio === sale.folio);
    this.counter += 1;
    const times = claimed.request.times;
    const record: StoredSale = {
      id: `ee000000-0000-4000-8000-${String(this.counter).padStart(12, '0')}`,
      operationId: sale.operationId,
      shiftId: sale.shiftId,
      deviceId: claimed.request.deviceId ?? null,
      userId: claimed.request.userId,
      folio: taken ? `${sale.folio}~${sale.operationId.slice(0, 8)}` : sale.folio,
      folioReported: sale.folio,
      folioConflict: taken,
      total: sale.total,
      needsAdjustment: sale.needsAdjustment,
      flags: sale.flags,
      timeFlags: times?.flags ?? [],
      occurredAt: times?.occurredAt ?? new Date('2026-10-18T12:00:00.000Z'),
      receivedAt: times?.receivedAt ?? new Date('2026-10-18T12:00:00.000Z'),
      lines: sale.lines,
      payments: sale.payments,
    };
    this.records.push(record);
    return Promise.resolve(this.withReview(record));
  }

  findByOperation(operationId: string): Promise<SaleRecord | null> {
    const found = this.records.find((record) => record.operationId === operationId);
    return Promise.resolve(found === undefined ? null : this.withReview(found));
  }

  find(id: string): Promise<SaleRecord | null> {
    const found = this.records.find((record) => record.id === id);
    return Promise.resolve(found === undefined ? null : this.withReview(found));
  }

  findByVoid(operationId: string): Promise<SaleRecord | null> {
    const voided = [...this.voids].find(([, record]) => record.operationId === operationId);
    return this.find(voided?.[0] ?? '');
  }

  list(request: SaleListRequest): Promise<SaleHeader[]> {
    const after = request.after;
    const rows = [...this.records]
      .sort(newestFirst)
      .filter((sale) => {
        if (request.shiftOwnerId === undefined) return true;
        return (
          this.shifts.records.find((shift) => shift.id === sale.shiftId)?.userId ===
          request.shiftOwnerId
        );
      })
      .filter((sale) => request.shiftId === undefined || sale.shiftId === request.shiftId)
      .filter(
        (sale) =>
          request.folio === undefined ||
          sale.folio === request.folio ||
          sale.folioReported === request.folio,
      )
      .filter((sale) => {
        if (request.attention === undefined) return true;
        const inTray = requiresAttention(sale) && !this.reviews.has(sale.id);
        return inTray === request.attention;
      })
      .filter(
        (sale) =>
          after === undefined ||
          sale.occurredAt.toISOString() < after[0] ||
          (sale.occurredAt.toISOString() === after[0] && sale.id < after[1]),
      );
    return Promise.resolve(rows.slice(0, request.limit).map((sale) => this.headerOf(sale)));
  }

  inPeriod(from: Date, to: Date): Promise<SalesOfPeriod> {
    const within = (at: Date): boolean => at >= from && at < to;
    return Promise.resolve({
      sold: this.records.filter((sale) => within(sale.occurredAt)),
      voided: this.records.filter((sale) => {
        const voided = this.voids.get(sale.id);
        return voided !== undefined && within(voided.voidedAt);
      }),
    });
  }

  review(
    saleId: string,
    userId: string,
    note: string | null,
  ): Promise<{ review: SaleReviewRecord; created: boolean }> {
    const existing = this.reviews.get(saleId);
    if (existing !== undefined) return Promise.resolve({ review: existing, created: false });
    const review: SaleReviewRecord = {
      reviewedAt: this.reviewedAt,
      reviewedByUserId: userId,
      note,
    };
    this.reviews.set(saleId, review);
    return Promise.resolve({ review, created: true });
  }

  recordVoid(request: NewSaleVoid): Promise<SaleRecord> {
    if (this.voids.has(request.saleId)) return Promise.reject(new SaleVoidedError());
    const claimed = this.operations.claims.get(request.operationId);
    if (claimed === undefined) {
      return Promise.reject(new Error(`The operation ${request.operationId} was not claimed`));
    }
    this.voids.set(request.saleId, {
      voidedAt: this.voidedAt,
      voidedByUserId: claimed.userId,
      operationId: request.operationId,
      reason: request.reason,
    });
    return this.find(request.saleId).then((sale) => {
      if (sale === null) throw new Error(`The sale ${request.saleId} vanished`);
      return sale;
    });
  }

  private withReview(sale: StoredSale): SaleRecord {
    return {
      ...sale,
      review: this.reviews.get(sale.id) ?? null,
      voided: this.voids.get(sale.id) ?? null,
    };
  }

  private headerOf(sale: StoredSale): SaleHeader {
    const { lines: _lines, payments: _payments, ...header } = this.withReview(sale);
    return header;
  }
}
