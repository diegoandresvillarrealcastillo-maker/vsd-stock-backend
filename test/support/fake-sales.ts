import type { NewSale, SaleRecord, SaleRepository } from '../../src/domain/ports/out/sales.js';
import type { FakeShifts } from './fake-cash.js';
import type { FakeOperations } from './fake-purchasing.js';

/**
 * Las ventas de un negocio en memoria. Hace lo mismo que el adaptador de Prisma, sin base: el folio repetido se guarda con
 * otro y marcado, y la hora, la persona y el dispositivo salen de la operacion que la trajo.
 */
export class FakeSales implements SaleRepository {
  readonly records: SaleRecord[] = [];
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
    const record: SaleRecord = {
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
    return Promise.resolve(record);
  }

  findByOperation(operationId: string): Promise<SaleRecord | null> {
    return Promise.resolve(
      this.records.find((record) => record.operationId === operationId) ?? null,
    );
  }
}
