import type { Session } from './authenticate.js';
import type { SaleRecord } from '../out/sales.js';

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

/** La venta con su total desglosado. Los totales se calculan de las lineas guardadas, nunca se guardan aparte. */
export interface SaleView extends SaleRecord {
  readonly summary: SaleTotalsView;
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
}
