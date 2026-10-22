import type { InputReader } from './validation.js';

/** Los campos al crear un proveedor: solo el nombre y un contacto opcional (C2-06). */
export const NEW_SUPPLIER_FIELDS = ['name', 'contact'] as const;
export const SUPPLIER_CHANGE_FIELDS = NEW_SUPPLIER_FIELDS;

/** Lo que cabe en `supplier.name` y `supplier.contact` (ADR 0021). */
const MAX_NAME_LENGTH = 120;
const MAX_CONTACT_LENGTH = 200;

export interface NewSupplier {
  readonly name: string;
  readonly contact: string | null;
}

/** Lo que cambia de un proveedor. Lo que no aparece, no cambia; `null` borra el contacto. */
export interface SupplierChange {
  readonly name?: string;
  readonly contact?: string | null;
}

function contactOf(reader: InputReader): string | null | undefined {
  if (reader.isNull('contact')) return null;
  return reader.text('contact', { label: 'El contacto', max: MAX_CONTACT_LENGTH, optional: true });
}

/** Lee un proveedor nuevo. Los problemas quedan en el lector; el llamador llama a `finish()` antes de usar el resultado. */
export function readNewSupplier(reader: InputReader): NewSupplier {
  const name = reader.text('name', { label: 'El nombre', max: MAX_NAME_LENGTH });
  return { name, contact: contactOf(reader) ?? null };
}

/** Lee lo que cambia de un proveedor. Pide al menos un campo. */
export function readSupplierChange(reader: InputReader): SupplierChange {
  const draft: { -readonly [K in keyof SupplierChange]: SupplierChange[K] } = {};
  if (reader.raw('name') !== undefined) {
    draft.name = reader.text('name', { label: 'El nombre', max: MAX_NAME_LENGTH });
  }
  const contact = contactOf(reader);
  if (contact !== undefined) draft.contact = contact;
  if (reader.raw('name') === undefined && contact === undefined) {
    reader.fail('', 'empty-change', 'Indica al menos un dato para cambiar.');
  }
  return draft;
}
