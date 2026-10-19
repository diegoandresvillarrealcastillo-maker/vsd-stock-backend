import { SYNC_FIELDS, readSyncBatch, type SyncItem } from '../../domain/model/sync-input.js';
import { InputReader, ValidationFailedError } from '../../domain/model/validation.js';
import type { Session } from '../../domain/ports/in/authenticate.js';
import type { Sales } from '../../domain/ports/in/sales.js';
import type { Shifts } from '../../domain/ports/in/shifts.js';
import type { Sync, SyncItemResult, SyncOutcome } from '../../domain/ports/in/sync.js';
import type { Clock } from '../../domain/ports/out/clock.js';
import { requireMember } from '../session-guards.js';

/**
 * El lote de sincronizacion (C3-06, ADR 0028). No sabe aplicar nada: reparte cada operacion al caso de uso de su ruta individual
 * —abrir y cerrar un turno, vender—, asi que hay UNA sola forma de aplicarlas, con las mismas reglas, la misma idempotencia y las
 * mismas pruebas. Cada una va en su propia transaccion (la de su caso de uso) y una que falla no deshace ni detiene a las demas:
 * el resultado dice, por cada una, si se aplico o por que no.
 */
export class SyncUseCase implements Sync {
  constructor(
    private readonly shifts: Shifts,
    private readonly sales: Sales,
    private readonly clock: Clock,
  ) {}

  async apply(session: Session, body: unknown): Promise<SyncOutcome> {
    // Lo que no depende de la operacion (no hay negocio, la persona esta dada de baja) echa abajo la peticion entera.
    requireMember(session);
    const reader = new InputReader(body, SYNC_FIELDS);
    const items = readSyncBatch(reader);
    reader.finish();

    const results: SyncItemResult[] = [];
    // Una tras otra y en el orden en que llegaron: abrir un turno y vender en el caben en el mismo lote.
    for (const item of items) results.push(await this.applyOne(session, item));
    return { serverTime: this.clock.now(), results };
  }

  private async applyOne(session: Session, item: SyncItem): Promise<SyncItemResult> {
    if (!item.valid) {
      return {
        operationId: item.operationId,
        kind: null,
        outcome: { type: 'failed', error: new ValidationFailedError(item.errors) },
      };
    }
    try {
      switch (item.kind) {
        case 'shift-open': {
          const { shift, replayed } = await this.shifts.open(session, item.body);
          return applied(item.operationId, item.kind, replayed, shift);
        }
        case 'shift-close': {
          // El turno viene en `shiftId`, junto al cuerpo (lo exige el lector del lote para cerrar).
          const { shift, replayed } = await this.shifts.close(
            session,
            item.shiftId ?? '',
            item.body,
          );
          return applied(item.operationId, item.kind, replayed, shift);
        }
        case 'sale': {
          const { sale, replayed } = await this.sales.create(session, item.body);
          return applied(item.operationId, item.kind, replayed, sale);
        }
      }
    } catch (error) {
      return {
        operationId: item.operationId,
        kind: item.kind,
        outcome: { type: 'failed', error },
      };
    }
  }
}

function applied(
  operationId: string | null,
  kind: SyncItemResult['kind'],
  replayed: boolean,
  value: unknown,
): SyncItemResult {
  return { operationId, kind, outcome: { type: 'applied', replayed, value } };
}
