import type { SyncKind } from '../../model/sync-input.js';
import type { ProductRecord } from '../out/catalog.js';
import type { StockLevel } from '../out/stock.js';
import type { Session } from './authenticate.js';

/** Lo que paso con UNA operacion de un lote. */
export interface SyncItemResult {
  /** El `operationId` de su cuerpo, o `null` si no se pudo leer. */
  readonly operationId: string | null;
  /** La clase de operacion, o `null` si ni siquiera se pudo leer. */
  readonly kind: SyncKind | null;
  readonly outcome:
    /** Se aplico (o ya estaba aplicada: `replayed`). `value` es lo que la ruta individual devuelve: el turno, la venta. */
    | { readonly type: 'applied'; readonly replayed: boolean; readonly value: unknown }
    /** No se aplico. `error` es el que habria lanzado la ruta individual: el adaptador HTTP lo traduce igual. */
    | { readonly type: 'failed'; readonly error: unknown };
}

export interface SyncOutcome {
  /** La hora del servidor al contestar: con ella el dispositivo mide su reloj (ADR 0016 y 0028). */
  readonly serverTime: Date;
  readonly results: readonly SyncItemResult[];
}

/**
 * Puerto de entrada: el lote de sincronizacion (C3-06, ADR 0028). Una lista ordenada de operaciones que el dispositivo hizo sin
 * conexion; cada una se aplica en su propia transaccion con las reglas de su ruta individual, y un resultado por cada una.
 */
export interface Sync {
  /**
   * Aplica el lote. Lanza si la peticion entera no sirve (no es una persona con negocio, o el lote no es una lista de 1 a 50
   * operaciones); una operacion que no sirve queda en su resultado y no echa a perder a las demas.
   */
  apply(session: Session, body: unknown): Promise<SyncOutcome>;
}

/** La existencia de un producto en la copia de lectura. Un producto que nunca se movio no aparece: vale cero. */
export type StockCopyRecord = StockLevel;

/** Una pagina de la copia de lectura, con la hora del servidor al leerla (ADR 0028, puntos 9 a 12). */
export interface CopyPage<T> {
  readonly asOf: Date;
  readonly items: T[];
  readonly nextCursor: string | null;
}

/**
 * Puerto de entrada: la copia de lectura que el dispositivo guarda para vender sin red. Incremental con `since`; los
 * archivados vienen marcados (`active: false`) para que el dispositivo los quite.
 */
export interface SyncCopy {
  products(session: Session, query: unknown): Promise<CopyPage<ProductRecord>>;
  stock(session: Session, query: unknown): Promise<CopyPage<StockCopyRecord>>;
}
