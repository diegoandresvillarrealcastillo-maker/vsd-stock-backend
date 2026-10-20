import {
  ShiftAlreadyOpenError,
  ShiftClosedError,
  ShiftIdReusedError,
  ShiftNotFoundError,
} from '../../../domain/model/shift-errors.js';
import type { CashDirection } from '../../../domain/model/shift-input.js';
import type { ShiftCashTotals } from '../../../domain/model/shift-summary.js';
import type {
  CashMovementRecord,
  CashMovementRepository,
  NewCashMovement,
  NewShift,
  ShiftClosing,
  ShiftListRequest,
  ShiftRecord,
  ShiftRepository,
} from '../../../domain/ports/out/shifts.js';
import { Prisma } from '../../../generated/prisma/client.js';
import type { PrismaTransaction } from './prisma-unit-of-work.js';

const SHIFT_SELECT = {
  id: true,
  deviceId: true,
  userId: true,
  openedAt: true,
  closedAt: true,
  closedByUserId: true,
  openingAmount: true,
  countedAmount: true,
} as const;

interface ShiftRow {
  readonly id: string;
  readonly deviceId: string;
  readonly userId: string;
  readonly openedAt: Date;
  readonly closedAt: Date | null;
  readonly closedByUserId: string | null;
  readonly openingAmount: bigint;
  readonly countedAmount: bigint | null;
}

/** La base limita el dinero a un billon de pesos: un `number` los guarda sin perder uno. */
function recordOf(row: ShiftRow): ShiftRecord {
  return {
    id: row.id,
    deviceId: row.deviceId,
    userId: row.userId,
    openedAt: row.openedAt,
    closedAt: row.closedAt,
    closedByUserId: row.closedByUserId,
    openingAmount: Number(row.openingAmount),
    countedAmount: row.countedAmount === null ? null : Number(row.countedAmount),
  };
}

/** Lo que dijo la base cuando una restriccion de unicidad fallo, como texto para buscar su nombre. */
function uniqueViolation(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { code, meta, message } = error as { code?: unknown; meta?: unknown; message?: unknown };
  if (code !== 'P2002') return undefined;
  return `${JSON.stringify(meta ?? {})} ${typeof message === 'string' ? message : ''}`.toLowerCase();
}

/** Una suma de la base llega como `bigint` (o `null` si no habia filas): un `number` alcanza para el dinero de un turno. */
const peso = (value: bigint | number | null | undefined): number => Number(value ?? 0);

/** Los turnos del negocio de la transaccion, sobre Prisma. La seguridad por fila deja ver y escribir solo lo de ese negocio. */
export class PrismaShiftRepository implements ShiftRepository {
  constructor(
    private readonly tx: PrismaTransaction,
    private readonly businessId: string,
  ) {}

  async find(id: string): Promise<ShiftRecord | null> {
    const row = await this.tx.cashShift.findFirst({ where: { id }, select: SHIFT_SELECT });
    return row === null ? null : recordOf(row);
  }

  async lockShared(id: string): Promise<ShiftRecord | null> {
    // `FOR SHARE` bloquea el turno hasta el final de la transaccion: cerrarlo (un UPDATE) espera a esta venta. En
    // READ COMMITTED la lectura que sigue ve lo ultimo que confirmo quien lo cerro mientras esta esperaba.
    await this.tx.$queryRaw`SELECT id FROM cash_shift WHERE id = ${id}::uuid FOR SHARE`;
    return this.find(id);
  }

  async list(request: ShiftListRequest): Promise<ShiftRecord[]> {
    const after = request.after;
    const rows = await this.tx.cashShift.findMany({
      where: {
        // Del mas nuevo al mas viejo: la posicion es la misma que lleva el cursor.
        ...(after === undefined
          ? {}
          : {
              OR: [
                { openedAt: { lt: new Date(after[0]) } },
                { openedAt: new Date(after[0]), id: { lt: after[1] } },
              ],
            }),
        ...(request.userId === undefined ? {} : { userId: request.userId }),
        ...(request.open === undefined ? {} : { closedAt: request.open ? null : { not: null } }),
      },
      orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
      take: request.limit,
      select: SHIFT_SELECT,
    });
    return rows.map(recordOf);
  }

  async open(shift: NewShift): Promise<ShiftRecord> {
    try {
      const row = await this.tx.cashShift.create({
        data: {
          id: shift.id,
          idNegocio: this.businessId,
          deviceId: shift.deviceId,
          userId: shift.userId,
          openedAt: shift.openedAt,
          openingAmount: BigInt(shift.openingAmount),
        },
        select: SHIFT_SELECT,
      });
      return recordOf(row);
    } catch (error) {
      const text = uniqueViolation(error);
      if (text !== undefined) {
        // El indice parcial dice «ya tiene uno abierto»; la llave primaria, «ese identificador ya es de otro turno».
        if (text.includes('cash_shift_one_open')) throw new ShiftAlreadyOpenError();
        throw new ShiftIdReusedError();
      }
      throw error;
    }
  }

  async close(id: string, closing: ShiftClosing): Promise<ShiftRecord> {
    // Un solo UPDATE condicionado a que siga abierto: dos cierres a la vez se turnan en la fila y solo uno cambia algo. Tambien
    // espera a las ventas que tienen el turno bloqueado en modo compartido (ADR 0013), asi que el arqueo no pierde ninguna.
    const { count } = await this.tx.cashShift.updateMany({
      where: { id, closedAt: null },
      data: {
        closedAt: closing.closedAt,
        closedByUserId: closing.closedByUserId,
        countedAmount: BigInt(closing.countedAmount),
      },
    });
    const current = await this.find(id);
    if (count === 0) throw current === null ? new ShiftNotFoundError() : new ShiftClosedError();
    if (current === null) throw new ShiftNotFoundError();
    return current;
  }

  async totals(id: string): Promise<ShiftCashTotals> {
    // Una venta es tardia si ocurrio (hora efectiva de su operacion) despues de que el turno se cerro. El efectivo de una
    // venta es la suma de sus cobros en efectivo; una venta anulada sigue contando aqui, y la devolucion sale del turno de
    // quien anula (ADR 0026).
    const [sales] = await this.tx.$queryRaw<
      { cash_sales: bigint | null; late_count: bigint | null; late_cash: bigint | null }[]
    >(Prisma.sql`
      WITH shift AS (SELECT closed_at FROM cash_shift WHERE id = ${id}::uuid),
      per_sale AS (
        SELECT s.id,
               COALESCE(SUM(p.amount) FILTER (WHERE p.method = 'cash'), 0) AS cash,
               (shift.closed_at IS NOT NULL AND o.occurred_at > shift.closed_at) AS late
          FROM sale s
          JOIN operation o ON o.id_negocio = s.id_negocio AND o.operation_id = s.operation_id
          LEFT JOIN payment p ON p.id_negocio = s.id_negocio AND p.sale_id = s.id
          CROSS JOIN shift
         WHERE s.shift_id = ${id}::uuid
         GROUP BY s.id, shift.closed_at, o.occurred_at
      )
      SELECT COALESCE(SUM(cash) FILTER (WHERE NOT late), 0)::bigint AS cash_sales,
             COUNT(*) FILTER (WHERE late)::bigint AS late_count,
             COALESCE(SUM(cash) FILTER (WHERE late), 0)::bigint AS late_cash
        FROM per_sale`);
    const movements = await this.tx.$queryRaw<{ direction: string; amount: bigint | null }[]>(
      Prisma.sql`
        SELECT direction, COALESCE(SUM(amount), 0)::bigint AS amount
          FROM cash_movement
         WHERE shift_id = ${id}::uuid
         GROUP BY direction`,
    );
    const total = (direction: CashDirection) =>
      peso(movements.find((row) => row.direction === direction)?.amount);
    return {
      cashSales: peso(sales?.cash_sales),
      cashIn: total('in'),
      cashOut: total('out'),
      late: { count: peso(sales?.late_count), cashAmount: peso(sales?.late_cash) },
    };
  }
}

const MOVEMENT_SELECT = {
  id: true,
  operationId: true,
  shiftId: true,
  direction: true,
  amount: true,
  reason: true,
} as const;

interface MovementRow {
  readonly id: string;
  readonly operationId: string;
  readonly shiftId: string;
  readonly direction: string;
  readonly amount: bigint;
  readonly reason: string | null;
}

function movementOf(row: MovementRow): CashMovementRecord {
  return {
    id: row.id,
    operationId: row.operationId,
    shiftId: row.shiftId,
    // La base solo admite estos dos valores (`cash_movement_direction_known`).
    direction: row.direction as CashDirection,
    amount: Number(row.amount),
    reason: row.reason,
  };
}

/** El efectivo que entra y sale de un turno fuera de una venta, sobre Prisma. */
export class PrismaCashMovementRepository implements CashMovementRepository {
  constructor(
    private readonly tx: PrismaTransaction,
    private readonly businessId: string,
  ) {}

  async create(movement: NewCashMovement): Promise<CashMovementRecord> {
    const row = await this.tx.cashMovement.create({
      data: {
        idNegocio: this.businessId,
        operationId: movement.operationId,
        shiftId: movement.shiftId,
        direction: movement.direction,
        amount: BigInt(movement.amount),
        reason: movement.reason,
      },
      select: MOVEMENT_SELECT,
    });
    return movementOf(row);
  }

  async findByOperation(operationId: string): Promise<CashMovementRecord | null> {
    const row = await this.tx.cashMovement.findFirst({
      where: { operationId },
      select: MOVEMENT_SELECT,
    });
    return row === null ? null : movementOf(row);
  }
}
