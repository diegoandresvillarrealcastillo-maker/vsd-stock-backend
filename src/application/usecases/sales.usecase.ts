import { resolveReceivedOperation } from '../../domain/model/operation-time-input.js';
import { Money } from '../../domain/model/money.js';
import { pageOf, readPageRequest, timeThenUuid, type Page } from '../../domain/model/pagination.js';
import { OperationIdReusedError } from '../../domain/model/purchase-errors.js';
import { can } from '../../domain/model/role.js';
import { requiresAttention } from '../../domain/model/sale-attention.js';
import { SaleNotFoundError } from '../../domain/model/sale-errors.js';
import { flagsOfSale, soldAtCatalogPrice } from '../../domain/model/sale-flags.js';
import {
  SALE_FIELDS,
  readSale,
  saleFingerprint,
  type SaleInput,
} from '../../domain/model/sale-input.js';
import {
  SALE_FILTER_FIELDS,
  SALE_REVIEW_FIELDS,
  readSaleFilter,
  readSaleReview,
} from '../../domain/model/sale-query-input.js';
import { summarizeSale, type SaleSummary } from '../../domain/model/sale-totals.js';
import { isWholeOnly } from '../../domain/model/unit-of-measure.js';
import { isUuid } from '../../domain/model/uuid.js';
import {
  type FieldError,
  InputReader,
  ValidationFailedError,
} from '../../domain/model/validation.js';
import type { Session } from '../../domain/ports/in/authenticate.js';
import type {
  SaleOutcome,
  SaleReviewOutcome,
  SaleSummaryView,
  SaleTotalsView,
  SaleView,
  Sales,
} from '../../domain/ports/in/sales.js';
import type { ProductRecord } from '../../domain/ports/out/catalog.js';
import type { Clock } from '../../domain/ports/out/clock.js';
import type { SaleHeader, SaleRecord } from '../../domain/ports/out/sales.js';
import type { BusinessScope, UnitOfWork } from '../../domain/ports/out/unit-of-work.js';
import { ensureCan, requireMember } from '../session-guards.js';

/** Un turno que no existe y uno que es de otra persona se dicen igual: quien vende no se entera de los turnos ajenos. */
const UNKNOWN_SHIFT: FieldError = {
  pointer: '/shiftId',
  code: 'unknown-shift',
  detail: 'No existe ese turno entre los tuyos.',
};

const unknownProduct = (index: number): FieldError => ({
  pointer: `/lines/${index}/productId`,
  code: 'unknown-product',
  detail: 'No existe ese producto en este negocio.',
});

const notWhole = (index: number): FieldError => ({
  pointer: `/lines/${index}/quantityMilli`,
  code: 'not-whole',
  detail: 'Este producto se cuenta en unidades enteras: la cantidad no lleva decimales.',
});

/** Una unidad entera son mil milesimas. */
const MILLI_PER_UNIT = 1000;

/**
 * Los productos que la venta nombra tienen que existir en ESTE negocio y poderse vender en esa cantidad. Uno archivado
 * despues de que el dispositivo lo vendio se acepta: la venta ya ocurrio (ADR 0009). Junta todos los problemas, en el
 * orden del cuerpo.
 */
async function productsOf(
  scope: BusinessScope,
  sale: SaleInput,
): Promise<ReadonlyMap<string, ProductRecord>> {
  const found = await scope.catalog.findProducts(sale.lines.map((line) => line.productId));
  const byId = new Map(found.map((product) => [product.id, product]));
  const errors: FieldError[] = [];
  sale.lines.forEach((line, index) => {
    const product = byId.get(line.productId);
    if (product === undefined) {
      errors.push(unknownProduct(index));
    } else if (isWholeOnly(product.unit) && line.quantityMilli % MILLI_PER_UNIT !== 0) {
      errors.push(notWhole(index));
    }
  });
  if (errors.length > 0) throw new ValidationFailedError(errors);
  return byId;
}

/** Lo que se descuenta de cada producto: las lineas de un mismo producto se juntan en un solo movimiento. */
function quantitiesSold(sale: SaleInput): Map<string, number> {
  const sold = new Map<string, number>();
  for (const line of sale.lines) {
    sold.set(line.productId, (sold.get(line.productId) ?? 0) + line.quantityMilli);
  }
  return sold;
}

function totalsView(summary: SaleSummary): SaleTotalsView {
  return {
    total: summary.total.amount,
    base: summary.base.amount,
    tax: summary.tax.amount,
    byRate: summary.byRate.map((row) => ({
      rateBp: row.rateBp,
      total: row.total.amount,
      base: row.base.amount,
      tax: row.tax.amount,
    })),
  };
}

/** Si la venta esta en la bandeja «Requiere atencion»: pide atencion y nadie la ha revisado (ADR 0027). */
const inTray = (sale: SaleHeader): boolean => requiresAttention(sale) && sale.review === null;

/** Una venta de la lista, con lo que hace falta para decidir si abrirla. */
const summaryViewOf = (sale: SaleHeader): SaleSummaryView => ({ ...sale, attention: inTray(sale) });

/** La venta con su total desglosado, calculado de las lineas que quedaron guardadas. */
function viewOf(sale: SaleRecord): SaleView {
  const summary = summarizeSale(
    sale.lines.map((line) => ({
      unitPrice: Money.of(line.unitPrice),
      quantityMilli: line.quantityMilli,
      discount: Money.of(line.discount),
      rateBp: line.taxRateBp,
    })),
  );
  return { ...sale, summary: totalsView(summary), attention: inTray(sale) };
}

/**
 * Caso de uso de la venta (C3-03, ADR 0027). Registrar una venta es UNA operacion idempotente: la venta, sus lineas, sus
 * cobros y los movimientos que bajan la existencia se guardan en la misma transaccion o no se guarda nada (ADR 0013).
 *
 * Una venta casi siempre ya ocurrio en un mostrador, a veces sin conexion (ADR 0009): el servidor la acepta y, si algo no
 * cuadra con lo que el sabe y el dispositivo no (existencia en negativo, turno ya cerrado, precio del catalogo, folio
 * repetido, dispositivo dado de baja, totales distintos), la guarda MARCADA para que alguien la mire. Solo rechaza lo que
 * ninguna realidad del mostrador explica: un cuerpo que no es una venta, un turno que no es de quien vende y un producto
 * que el negocio no tiene.
 */
export class SalesUseCase implements Sales {
  constructor(
    private readonly work: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  async create(session: Session, body: unknown): Promise<SaleOutcome> {
    const actor = requireMember(session);
    ensureCan(actor, 'sale:create');

    const reader = new InputReader(body, SALE_FIELDS);
    const sale = readSale(reader);
    reader.finish();
    const times = resolveReceivedOperation(sale.time, this.clock.now());

    return this.work.inBusiness(actor.businessId, async (scope) => {
      // El turno tiene que ser de quien vende: el dispositivo del turno es el que hizo la venta.
      const shift = await scope.shifts.find(sale.shiftId);
      if (shift === null || shift.userId !== actor.userId) {
        throw new ValidationFailedError([UNKNOWN_SHIFT]);
      }
      const products = await productsOf(scope, sale);

      // Primero se reclama la operacion: dos envios iguales a la vez se turnan en este punto, y el segundo ve lo que dejo
      // el primero. Si algo falla despues, el reclamo se deshace con todo lo demas.
      const claim = await scope.operations.claim({
        operationId: sale.operationId,
        kind: 'sale',
        userId: actor.userId,
        fingerprint: saleFingerprint(sale),
        deviceId: shift.deviceId,
        times,
      });
      if (claim === 'conflict') throw new OperationIdReusedError();
      if (claim === 'replay') {
        // Repetida: se entrega lo que ya se hizo, sin volver a mirar el stock, el turno ni el catalogo.
        const existing = await scope.sales.findByOperation(sale.operationId);
        if (existing === null) {
          throw new Error(`The operation ${sale.operationId} is claimed but has no sale`);
        }
        return { sale: viewOf(existing), replayed: true };
      }

      // La existencia baja primero y se mira ya actualizada, bajo el candado que esos movimientos tomaron (ADR 0013).
      const sold = quantitiesSold(sale);
      await scope.stock.addMovements(
        sale.operationId,
        [...sold].map(([productId, quantityMilli]) => ({
          productId,
          delta: -quantityMilli,
          reason: 'sale' as const,
          note: null,
        })),
      );
      const remaining = await scope.stock.quantitiesOf([...sold.keys()]);
      const needsAdjustment = [...remaining.values()].some((quantity) => quantity < 0);

      // El turno se bloquea al final: cerrarlo espera a esta venta y el candado dura lo minimo (ADR 0013). Lo que se
      // lee aqui, ya bloqueado, es lo que dice si la venta llego despues del cierre.
      const lockedShift = await scope.shifts.lockShared(shift.id);
      if (lockedShift === null)
        throw new Error(`The shift ${shift.id} vanished inside its transaction`);
      const device = await scope.devices.find(shift.deviceId);
      if (device === null)
        throw new Error(`The device ${shift.deviceId} vanished inside its transaction`);

      const flags = flagsOfSale({
        priceDiffers: sale.lines.some((line) => {
          const catalog = products.get(line.productId);
          return catalog === undefined || !soldAtCatalogPrice(line, catalog);
        }),
        claimedTotal: sale.claimedTotal,
        computedTotal: sale.summary.total.amount,
        paidTotal: sale.payments.reduce((paid, payment) => paid + payment.amount, 0),
        occurredAt: times.occurredAt,
        shiftClosedAt: lockedShift.closedAt,
        deviceRevokedAt: device.revokedAt,
        folioDeviceCode: sale.folioDevice,
        deviceCode: device.code,
      });

      const saved = await scope.sales.create({
        operationId: sale.operationId,
        shiftId: shift.id,
        folio: sale.folio,
        // El total es el del servidor: el del dispositivo queda comparado en las marcas.
        total: sale.summary.total.amount,
        needsAdjustment,
        flags,
        lines: sale.lines,
        payments: sale.payments,
      });
      return { sale: viewOf(saved), replayed: false };
    });
  }

  async list(session: Session, query: unknown): Promise<Page<SaleSummaryView>> {
    const actor = requireMember(session);
    ensureCan(actor, 'sale:view-own-shift');

    const reader = new InputReader(query, ['limit', 'cursor', ...SALE_FILTER_FIELDS]);
    const request = readPageRequest(reader, 2, timeThenUuid);
    const filter = readSaleFilter(reader);
    reader.finish();
    // Las ventas de todos, y la bandeja de lo que pide atencion, son de la gerencia (ADR 0017 y 0027).
    const everything = can(actor.role, 'sale:view-all');
    if (filter.attention !== undefined) ensureCan(actor, 'sale:view-all');

    const [afterAt, afterId] = request.after ?? [];
    const rows = await this.work.inBusiness(actor.businessId, (scope) =>
      scope.sales.list({
        // Una de mas: si llega, hay otra pagina.
        limit: request.limit + 1,
        ...(afterAt !== undefined && afterId !== undefined
          ? { after: [afterAt, afterId] as const }
          : {}),
        ...(everything ? {} : { shiftOwnerId: actor.userId }),
        ...filter,
      }),
    );
    const page = pageOf(rows, request.limit, (sale) => [sale.occurredAt.toISOString(), sale.id]);
    return { ...page, items: page.items.map(summaryViewOf) };
  }

  async get(session: Session, saleId: string): Promise<SaleView> {
    const actor = requireMember(session);
    ensureCan(actor, 'sale:view-own-shift');
    // Un identificador que no es un UUID no es de nadie: no se le pregunta nada a la base.
    if (!isUuid(saleId)) throw new SaleNotFoundError();

    return this.work.inBusiness(actor.businessId, async (scope) => {
      const sale = await scope.sales.find(saleId.toLowerCase());
      if (sale === null) throw new SaleNotFoundError();
      if (!can(actor.role, 'sale:view-all')) {
        // La venta de un turno ajeno no existe para un cajero: no se le dice que existe.
        const shift = await scope.shifts.find(sale.shiftId);
        if (shift?.userId !== actor.userId) throw new SaleNotFoundError();
      }
      return viewOf(sale);
    });
  }

  async review(session: Session, saleId: string, body: unknown): Promise<SaleReviewOutcome> {
    const actor = requireMember(session);
    // Revisar es de quien ve todas las ventas, y necesita conexion (ADR 0017 y 0027).
    ensureCan(actor, 'sale:view-all');
    const reader = new InputReader(body, SALE_REVIEW_FIELDS);
    const { note } = readSaleReview(reader);
    reader.finish();
    if (!isUuid(saleId)) throw new SaleNotFoundError();

    return this.work.inBusiness(actor.businessId, async (scope) => {
      const sale = await scope.sales.find(saleId.toLowerCase());
      if (sale === null) throw new SaleNotFoundError();
      const { review, created } = await scope.sales.review(sale.id, actor.userId, note);
      return { saleId: sale.id, review, replayed: !created };
    });
  }
}
