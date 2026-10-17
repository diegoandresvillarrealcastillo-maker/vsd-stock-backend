import {
  SupplierInUseError,
  SupplierNotFoundError,
} from '../../../domain/model/purchase-errors.js';
import type { NewSupplier, SupplierChange } from '../../../domain/model/supplier-input.js';
import type { ListRequest } from '../../../domain/ports/out/catalog.js';
import type { SupplierRecord, SupplierRepository } from '../../../domain/ports/out/suppliers.js';
import type { PrismaTransaction } from './prisma-unit-of-work.js';

const SUPPLIER_SELECT = { id: true, name: true, contact: true, createdAt: true } as const;

/** El codigo con que Prisma dice «la fila no existe» (para la seguridad por fila, una de otro negocio tampoco existe) o «hay filas que dependen de esta». */
function codeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null
    ? (error as { code?: unknown }).code
    : undefined;
}

/** Los proveedores del negocio de la transaccion, sobre Prisma. La seguridad por fila deja ver y escribir solo lo de ese negocio. */
export class PrismaSupplierRepository implements SupplierRepository {
  constructor(
    private readonly tx: PrismaTransaction,
    private readonly businessId: string,
  ) {}

  async list(request: ListRequest): Promise<SupplierRecord[]> {
    const after = request.after;
    return this.tx.supplier.findMany({
      // Por nombre y luego por id: la misma posicion que el cursor, que no cambia si alguien se suma.
      where:
        after === undefined
          ? {}
          : { OR: [{ name: { gt: after[0] } }, { name: after[0], id: { gt: after[1] } }] },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: request.limit,
      select: SUPPLIER_SELECT,
    });
  }

  async find(id: string): Promise<SupplierRecord | null> {
    return this.tx.supplier.findFirst({ where: { id }, select: SUPPLIER_SELECT });
  }

  async create(supplier: NewSupplier): Promise<SupplierRecord> {
    return this.tx.supplier.create({
      data: { idNegocio: this.businessId, name: supplier.name, contact: supplier.contact },
      select: SUPPLIER_SELECT,
    });
  }

  async update(id: string, change: SupplierChange): Promise<SupplierRecord> {
    try {
      return await this.tx.supplier.update({
        where: { id },
        data: {
          ...(change.name === undefined ? {} : { name: change.name }),
          ...(change.contact === undefined ? {} : { contact: change.contact }),
        },
        select: SUPPLIER_SELECT,
      });
    } catch (error) {
      if (codeOf(error) === 'P2025') throw new SupplierNotFoundError();
      throw error;
    }
  }

  async remove(id: string): Promise<void> {
    try {
      await this.tx.supplier.delete({ where: { id } });
    } catch (error) {
      if (codeOf(error) === 'P2025') throw new SupplierNotFoundError();
      if (codeOf(error) === 'P2003') throw new SupplierInUseError();
      throw error;
    }
  }
}
