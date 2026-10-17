import type { Page } from '../../model/pagination.js';
import type { CategoryRecord, ProductRecord } from '../out/catalog.js';
import type { Session } from './authenticate.js';

/** Lo que se le cuenta a quien mira el catalogo. */
export type CategoryView = CategoryRecord;
export type ProductView = ProductRecord;

/**
 * Puertos de entrada del catalogo (ADR 0015). Cada metodo recibe la sesion de quien llama y lo que mando SIN validar
 * (`unknown`): validarlo es parte del caso de uso. Ver el catalogo es de los tres roles; cambiarlo, de la gerencia.
 */
export interface Categories {
  list(session: Session, query: unknown): Promise<Page<CategoryView>>;
  create(session: Session, body: unknown): Promise<CategoryView>;
  rename(session: Session, categoryId: string, body: unknown): Promise<CategoryView>;
  remove(session: Session, categoryId: string): Promise<void>;
}

export interface Products {
  list(session: Session, query: unknown): Promise<Page<ProductView>>;
  get(session: Session, productId: string): Promise<ProductView>;
  create(session: Session, body: unknown): Promise<ProductView>;
  update(session: Session, productId: string, body: unknown): Promise<ProductView>;
}
