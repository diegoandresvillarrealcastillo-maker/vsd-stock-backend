import type { Page } from '../../model/pagination.js';
import type { StockMovementRecord, StockRecord } from '../out/stock.js';
import type { Session } from './authenticate.js';

export type StockView = StockRecord;
export type StockMovementView = StockMovementRecord;

/** El resultado de registrar un ajuste: si `replayed`, ya existia (mismo `operationId`, mismo cuerpo) y no se hizo nada. */
export interface AdjustmentOutcome {
  readonly movement: StockMovementView;
  readonly replayed: boolean;
}

/**
 * Puertos de entrada de las existencias (C2-07). Cada metodo recibe la sesion de quien llama y lo que mando SIN validar
 * (`unknown`). Consultar es de los tres roles (`stock:view`); ajustar, de la gerencia (`stock:adjust`).
 */
export interface Stock {
  list(session: Session, query: unknown): Promise<Page<StockView>>;
  movements(session: Session, query: unknown): Promise<Page<StockMovementView>>;
}

export interface StockAdjustments {
  adjust(session: Session, body: unknown): Promise<AdjustmentOutcome>;
}
