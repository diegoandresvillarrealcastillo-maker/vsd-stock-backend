import { CategoryNotFoundError } from '../../domain/model/catalog-errors.js';
import { endsInUuid, pageOf, readPageRequest, type Page } from '../../domain/model/pagination.js';
import { isUuid } from '../../domain/model/uuid.js';
import { InputReader } from '../../domain/model/validation.js';
import type { Session } from '../../domain/ports/in/authenticate.js';
import type { Categories, CategoryView } from '../../domain/ports/in/catalog.js';
import type { UnitOfWork } from '../../domain/ports/out/unit-of-work.js';
import { ensureCan, requireMember } from '../session-guards.js';

/** Lo que cabe en `category.name` (ADR 0021). */
const MAX_NAME_LENGTH = 120;

/**
 * Casos de uso de las categorias del catalogo (ADR 0015). Las ven los tres roles; las cambia la gerencia
 * (`product:manage`, ADR 0017). El nombre es unico por negocio sin importar mayusculas.
 */
export class CategoriesUseCase implements Categories {
  constructor(private readonly work: UnitOfWork) {}

  async list(session: Session, query: unknown): Promise<Page<CategoryView>> {
    const actor = requireMember(session);
    ensureCan(actor, 'product:view');

    const reader = new InputReader(query, ['limit', 'cursor']);
    const request = readPageRequest(reader, 2, endsInUuid);
    reader.finish();

    const [afterName, afterId] = request.after ?? [];
    const rows = await this.work.inBusiness(actor.businessId, (scope) =>
      scope.catalog.listCategories({
        // Una de mas: si llega, hay otra pagina.
        limit: request.limit + 1,
        ...(afterName !== undefined && afterId !== undefined
          ? { after: [afterName, afterId] as const }
          : {}),
      }),
    );
    return pageOf(rows, request.limit, (category) => [category.name, category.id]);
  }

  async create(session: Session, body: unknown): Promise<CategoryView> {
    const actor = requireMember(session);
    ensureCan(actor, 'product:manage');
    const name = readName(body);
    return this.work.inBusiness(actor.businessId, (scope) => scope.catalog.createCategory(name));
  }

  async rename(session: Session, categoryId: string, body: unknown): Promise<CategoryView> {
    const actor = requireMember(session);
    ensureCan(actor, 'product:manage');
    const name = readName(body);
    // Un identificador que no es un UUID no es de nadie: no se le pregunta nada a la base.
    if (!isUuid(categoryId)) throw new CategoryNotFoundError();
    return this.work.inBusiness(actor.businessId, async (scope) => {
      if ((await scope.catalog.findCategory(categoryId)) === null)
        throw new CategoryNotFoundError();
      return scope.catalog.renameCategory(categoryId, name);
    });
  }

  async remove(session: Session, categoryId: string): Promise<void> {
    const actor = requireMember(session);
    ensureCan(actor, 'product:manage');
    if (!isUuid(categoryId)) throw new CategoryNotFoundError();
    await this.work.inBusiness(actor.businessId, async (scope) => {
      if ((await scope.catalog.findCategory(categoryId)) === null)
        throw new CategoryNotFoundError();
      await scope.catalog.deleteCategory(categoryId);
    });
  }
}

function readName(body: unknown): string {
  const reader = new InputReader(body, ['name']);
  const name = reader.text('name', { label: 'El nombre', max: MAX_NAME_LENGTH });
  reader.finish();
  return name;
}
