import { describe, expect, it } from 'vitest';
import {
  CategoryInUseError,
  CategoryNameTakenError,
  CategoryNotFoundError,
} from '../../domain/model/catalog-errors.js';
import { encodeCursor } from '../../domain/model/pagination.js';
import { ForbiddenError, NoMembershipError } from '../../domain/model/people-errors.js';
import { ValidationFailedError } from '../../domain/model/validation.js';
import { UserInactiveError } from '../../domain/ports/in/authenticate.js';
import { FakeCatalog } from '../../../test/support/fake-catalog.js';
import { FakePeople, fakeUnitOfWork } from '../../../test/support/fake-people.js';
import { BUSINESS_ID, loneSession, memberSession } from '../../../test/support/sessions.js';
import { CategoriesUseCase } from './categories.usecase.js';

const setup = () => {
  const catalog = new FakeCatalog();
  const work = fakeUnitOfWork(new FakePeople(), 'Tienda', catalog);
  return { catalog, work, useCase: new CategoriesUseCase(work) };
};

const OTHER = '99999999-9999-4999-8999-999999999999';

describe('CategoriesUseCase', () => {
  describe('creating', () => {
    it('creates a category and hands it back', async () => {
      const { catalog, useCase } = setup();

      const category = await useCase.create(memberSession('admin'), { name: '  Granos  ' });

      expect(category).toMatchObject({ name: 'Granos' });
      expect(catalog.categories).toHaveLength(1);
    });

    it('works inside the business of the person who asks', async () => {
      const { work, useCase } = setup();

      await useCase.create(memberSession('owner'), { name: 'Granos' });

      expect(work.openedFor).toEqual([BUSINESS_ID]);
    });

    it('refuses a name already taken, whatever its case', async () => {
      const { useCase } = setup();
      await useCase.create(memberSession('owner'), { name: 'Granos' });

      await expect(
        useCase.create(memberSession('owner'), { name: 'GRANOS' }),
      ).rejects.toBeInstanceOf(CategoryNameTakenError);
    });

    it('reports every problem and creates nothing', async () => {
      const { catalog, useCase } = setup();

      const failure = await useCase
        .create(memberSession('owner'), { name: '', extra: 1 })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ValidationFailedError);
      expect(
        (failure as ValidationFailedError).errors.map((e) => `${e.pointer}:${e.code}`),
      ).toEqual(['/extra:unknown-field', '/name:blank']);
      expect(catalog.categories).toEqual([]);
    });

    it('accepts a name of 120 characters and refuses one of 121', async () => {
      const { useCase } = setup();

      await expect(
        useCase.create(memberSession('owner'), { name: 'n'.repeat(120) }),
      ).resolves.toBeDefined();
      await expect(
        useCase.create(memberSession('owner'), { name: 'n'.repeat(121) }),
      ).rejects.toBeInstanceOf(ValidationFailedError);
    });

    it('is for the management: an administrator can, a cashier can not', async () => {
      const { catalog, useCase } = setup();

      await expect(useCase.create(memberSession('admin'), { name: 'A' })).resolves.toBeDefined();
      await expect(useCase.create(memberSession('cashier'), { name: 'B' })).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      expect(catalog.categories).toHaveLength(1);
    });
  });

  describe('listing', () => {
    it('lists every role the categories by name, in pages', async () => {
      const { useCase } = setup();
      for (const name of ['Bebidas', 'Aseo', 'Granos']) {
        await useCase.create(memberSession('owner'), { name });
      }

      for (const role of ['owner', 'admin', 'cashier'] as const) {
        const first = await useCase.list(memberSession(role), { limit: '2' });
        expect(first.items.map((c) => c.name)).toEqual(['Aseo', 'Bebidas']);
        const second = await useCase.list(memberSession(role), {
          limit: '2',
          cursor: first.nextCursor,
        });
        expect(second.items.map((c) => c.name)).toEqual(['Granos']);
        expect(second.nextCursor).toBeNull();
      }
    });

    it('refuses a cursor whose id is not a UUID, which the database could not compare', async () => {
      const { useCase } = setup();

      const failure = await useCase
        .list(memberSession('owner'), { cursor: encodeCursor(['Granos', 'no-es-un-uuid']) })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ValidationFailedError);
      expect((failure as ValidationFailedError).errors.map((e) => e.code)).toEqual([
        'invalid-cursor',
      ]);
    });

    it('refuses a bad cursor and a limit out of range together', async () => {
      const { useCase } = setup();

      const failure = await useCase
        .list(memberSession('owner'), { limit: '999', cursor: 'basura' })
        .catch((error: unknown) => error);

      expect((failure as ValidationFailedError).errors.map((e) => e.pointer)).toEqual([
        '/limit',
        '/cursor',
      ]);
    });
  });

  describe('renaming', () => {
    it('renames a category', async () => {
      const { useCase } = setup();
      const created = await useCase.create(memberSession('owner'), { name: 'Granos' });

      const renamed = await useCase.rename(memberSession('admin'), created.id, {
        name: 'Cereales',
      });

      expect(renamed).toMatchObject({ id: created.id, name: 'Cereales' });
    });

    it('lets a category keep its name with another case', async () => {
      const { useCase } = setup();
      const created = await useCase.create(memberSession('owner'), { name: 'granos' });

      await expect(
        useCase.rename(memberSession('owner'), created.id, { name: 'Granos' }),
      ).resolves.toMatchObject({
        name: 'Granos',
      });
    });

    it('refuses the name of another category', async () => {
      const { useCase } = setup();
      await useCase.create(memberSession('owner'), { name: 'Aseo' });
      const granos = await useCase.create(memberSession('owner'), { name: 'Granos' });

      await expect(
        useCase.rename(memberSession('owner'), granos.id, { name: 'aseo' }),
      ).rejects.toBeInstanceOf(CategoryNameTakenError);
    });

    it('says there is no such category, also for an id that is not a UUID', async () => {
      const { work, useCase } = setup();

      await expect(
        useCase.rename(memberSession('owner'), OTHER, { name: 'X' }),
      ).rejects.toBeInstanceOf(CategoryNotFoundError);
      work.openedFor.length = 0;
      await expect(
        useCase.rename(memberSession('owner'), 'no-es-uuid', { name: 'X' }),
      ).rejects.toBeInstanceOf(CategoryNotFoundError);
      expect(work.openedFor).toEqual([]);
    });

    it('refuses a cashier before looking at what they sent', async () => {
      const { useCase } = setup();

      await expect(
        useCase.rename(memberSession('cashier'), OTHER, { basura: 1 }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  describe('removing', () => {
    it('removes a category with no products', async () => {
      const { catalog, useCase } = setup();
      const created = await useCase.create(memberSession('owner'), { name: 'Granos' });

      await useCase.remove(memberSession('admin'), created.id);

      expect(catalog.categories).toEqual([]);
    });

    it('refuses to remove one that still has products', async () => {
      const { catalog, useCase } = setup();
      const created = await useCase.create(memberSession('owner'), { name: 'Granos' });
      catalog.products.push({
        id: 'p',
        name: 'Arroz',
        sku: 'A',
        barcode: null,
        unit: 'unit',
        unitPrice: 1,
        taxRateBp: 0,
        active: true,
        categoryId: created.id,
        minStockMilli: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      });

      await expect(useCase.remove(memberSession('owner'), created.id)).rejects.toBeInstanceOf(
        CategoryInUseError,
      );
      expect(catalog.categories).toHaveLength(1);
    });

    it('says there is no such category', async () => {
      const { useCase } = setup();

      await expect(useCase.remove(memberSession('owner'), OTHER)).rejects.toBeInstanceOf(
        CategoryNotFoundError,
      );
      await expect(useCase.remove(memberSession('owner'), 'no-es-uuid')).rejects.toBeInstanceOf(
        CategoryNotFoundError,
      );
    });

    it('refuses a cashier', async () => {
      const { useCase } = setup();

      await expect(useCase.remove(memberSession('cashier'), OTHER)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    });
  });

  it('asks a person with no business to open one first, and refuses one who was deactivated', async () => {
    const { useCase } = setup();

    await expect(useCase.list(loneSession(), {})).rejects.toBeInstanceOf(NoMembershipError);
    await expect(
      useCase.list(memberSession('owner', { active: false }), {}),
    ).rejects.toBeInstanceOf(UserInactiveError);
  });
});
