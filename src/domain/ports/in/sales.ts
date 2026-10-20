import type { Session } from './authenticate.js';
import type { Page } from '../../model/pagination.js';
import type { SaleHeader, SaleRecord, SaleReviewRecord } from '../out/sales.js';

/** El total de un grupo de lineas de una misma tarifa, con el IVA desglosado (ADR 0014). */
export interface RateSummaryView {
  readonly rateBp: number;
  readonly total: number;
  readonly base: number;
  readonly tax: number;
}

export interface SaleTotalsView {
  readonly total: number;
  readonly base: number;
  readonly tax: number;
  /** Un renglon por tarifa presente, de menor a mayor. */
  readonly byRate: readonly RateSummaryView[];
}

/**
 * La venta con su total desglosado. Los totales se calculan de las lineas guardadas, nunca se guardan aparte. `attention`
 * dice si esta en la bandeja «Requiere atencion»: pide atencion y nadie la ha revisado (ADR 0027).
 */
export interface SaleView extends SaleRecord {
  readonly summary: SaleTotalsView;
  readonly attention: boolean;
}

/** Una venta de la lista: sin lineas ni cobros, con lo que hace falta para decidir si abrirla. */
export interface SaleSummaryView extends SaleHeader {
  readonly attention: boolean;
}

export interface SaleReviewOutcome {
  readonly saleId: string;
  readonly review: SaleReviewRecord;
  /** `true` si la venta ya estaba revisada y se devuelve esa revision. */
  readonly replayed: boolean;
}

export interface SaleOutcome {
  readonly sale: SaleView;
  /** `true` si esta operacion ya se habia aplicado y se devuelve lo que se hizo la primera vez. */
  readonly replayed: boolean;
}

/** Puerto de entrada: registrar ventas (C3-03). */
export interface Sales {
  /**
   * Registra una venta, que casi siempre ya ocurrio en un mostrador sin conexion (ADR 0009): se acepta y, si algo no
   * cuadra, se marca. Lanza `ValidationFailedError` si el cuerpo no sirve, si el turno no es de la persona o si nombra un
   * producto que el negocio no tiene, y `OperationIdReusedError` si el `operationId` ya se uso con otra venta.
   */
  create(session: Session, body: unknown): Promise<SaleOutcome>;
  /**
   * Las ventas, de la mas reciente a la mas vieja, por cursor. Un cajero ve las de sus turnos (`sale:view-own-shift`); la gerencia,
   * todas (`sale:view-all`), y solo ella pide la bandeja de atencion.
   */
  list(session: Session, query: unknown): Promise<Page<SaleSummaryView>>;
  /** Una venta con sus lineas y cobros. Lanza `SaleNotFoundError` si no existe o es de un turno ajeno para un cajero. */
  get(session: Session, saleId: string): Promise<SaleView>;
  /**
   * La gerencia revisa una venta: la saca de la bandeja sin cambiarla (ADR 0027). Necesita conexion. Revisarla otra vez devuelve
   * la revision que ya tenia.
   */
  review(session: Session, saleId: string, body: unknown): Promise<SaleReviewOutcome>;
}
