import { describe, expect, it } from 'vitest';
import { encodeCursor } from '../../domain/model/pagination.js';
import { ForbiddenError, NoMembershipError } from '../../domain/model/people-errors.js';
import { SupplierInUseError, SupplierNotFoundError } from '../../domain/model/purchase-errors.js';
import { ValidationFailedError } from '../../domain/model/validation.js';
import { UserInactiveError } from '../../domain/ports/in/authenticate.js';
import { FakeCatalog } from '../../../test/support/fake-catalog.js';
import { FakePeople, fakeUnitOfWork } from '../../../test/support/fake-people.js';
import { FakePurchasing } from '../../../test/support/fake-purchasing.js';
import { BUSINESS_ID, loneSession, memberSession } from '../../../test/support/sessions.js';
import { SuppliersUseCase } from './suppliers.usecase.js';

const setup = () => {
  const purchasing = new FakePurchasing();
  const work = fakeUnitOfWork(new FakePeople(), 'Tienda', new FakeCatalog(), purchasing);
  return { purchasing, work, useCase: new SuppliersUseCase(work) };
};

const OTHER = '99999999-9999-4999-8999-999999999999';

describe('SuppliersUseCase', () => {
  describe('creating', () => {
    it('creates a supplier with only a name, or with a contact too', async () => {
      const { purchasing, useCase } = setup();

      const lonely = await useCase.create(memberSession('owner'), { name: '  Lácteos El Sol ' });
      const withContact = await useCase.create(memberSession('admin'), {
        name: 'Granos del Valle',
        contact: ' 300 123 4567 ',
      });

      expect(lonely).toMatchObject({ name: 'Lácteos El Sol', contact: null });
      expect(withContact).toMatchObject({ name: 'Granos del Valle', contact: '300 123 4567' });
      expect(purchasing.suppliers.records).toHaveLength(2);
    });

    it('works inside the business of the person who asks', async () => {
      const { work, useCase } = setup();

      await useCase.create(memberSession('owner'), { name: 'A' });

      expect(work.openedFor).toEqual([BUSINESS_ID]);
    });

    it('lets two suppliers have the same name: they can be two different shops', async () => {
      const { purchasing, useCase } = setup();

      await useCase.create(memberSession('owner'), { name: 'Distribuidora' });
      await useCase.create(memberSession('owner'), { name: 'Distribuidora' });

      expect(purchasing.suppliers.records).toHaveLength(2);
    });

    it('reports every problem and creates nothing', async () => {
      const { purchasing, useCase } = setup();

      const failure = await useCase
        .create(memberSession('owner'), { name: '', phone: 1 })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ValidationFailedError);
      expect(
        (failure as ValidationFailedError).errors.map((e) => `${e.pointer}:${e.code}`),
      ).toEqual(['/phone:unknown-field', '/name:blank']);
      expect(purchasing.suppliers.records).toEqual([]);
    });

    it('is for the management: an administrator can, a cashier can not', async () => {
      const { purchasing, useCase } = setup();

      await expect(useCase.create(memberSession('admin'), { name: 'A' })).resolves.toBeDefined();
      await expect(useCase.create(memberSession('cashier'), { name: 'B' })).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      expect(purchasing.suppliers.records).toHaveLength(1);
    });

    it('refuses a person with no business and a person who was let go', async () => {
      const { useCase } = setup();

      await expect(useCase.create(loneSession(), { name: 'A' })).rejects.toBeInstanceOf(
        NoMembershipError,
      );
      await expect(
        useCase.create(memberSession('owner', { active: false }), { name: 'A' }),
      ).rejects.toBeInstanceOf(UserInactiveError);
    });
  });

  describe('listing', () => {
    it('lists the suppliers by name, in pages, for the management only', async () => {
      const { useCase } = setup();
      for (const name of ['Bebidas SA', 'Aseo Ltda', 'Granos']) {
        await useCase.create(memberSession('owner'), { name });
      }

      const first = await useCase.list(memberSession('admin'), { limit: '2' });
      expect(first.items.map((s) => s.name)).toEqual(['Aseo Ltda', 'Bebidas SA']);
      const second = await useCase.list(memberSession('owner'), {
        limit: '2',
        cursor: first.nextCursor,
      });
      expect(second.items.map((s) => s.name)).toEqual(['Granos']);
      expect(second.nextCursor).toBeNull();
      await expect(useCase.list(memberSession('cashier'), {})).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    });

    it('refuses a cursor whose id is not a UUID, which the database could not compare', async () => {
      const { useCase } = setup();

      const failure = await useCase
        .list(memberSession('owner'), { cursor: encodeCursor(['Granos', 'no-es-un-uuid']) })
        .catch((error: unknown) => error);

      expect((failure as ValidationFailedError).errors.map((e) => e.code)).toEqual([
        'invalid-cursor',
      ]);
    });
  });

  describe('changing', () => {
    it('changes the name, the contact, or clears the contact', async () => {
      const { useCase } = setup();
      const created = await useCase.create(memberSession('owner'), {
        name: 'Granos',
        contact: '300',
      });

      const renamed = await useCase.update(memberSession('admin'), created.id, {
        name: 'Cereales',
      });
      const cleared = await useCase.update(memberSession('owner'), created.id, { contact: null });

      expect(renamed).toMatchObject({ name: 'Cereales', contact: '300' });
      expect(cleared).toMatchObject({ name: 'Cereales', contact: null });
    });

    it('asks for at least one change', async () => {
      const { useCase } = setup();
      const created = await useCase.create(memberSession('owner'), { name: 'Granos' });

      const failure = await useCase
        .update(memberSession('owner'), created.id, {})
        .catch((error: unknown) => error);

      expect((failure as ValidationFailedError).errors.map((e) => e.code)).toEqual([
        'empty-change',
      ]);
    });

    it('says there is no such supplier, also for an id that is not a UUID, without asking the database', async () => {
      const { work, useCase } = setup();

      await expect(
        useCase.update(memberSession('owner'), OTHER, { name: 'X' }),
      ).rejects.toBeInstanceOf(SupplierNotFoundError);
      work.openedFor.length = 0;
      await expect(
        useCase.update(memberSession('owner'), 'no-es-uuid', { name: 'X' }),
      ).rejects.toBeInstanceOf(SupplierNotFoundError);
      expect(work.openedFor).toEqual([]);
    });

    it('refuses a cashier before looking at what they sent', async () => {
      const { useCase } = setup();

      await expect(
        useCase.update(memberSession('cashier'), OTHER, { basura: 1 }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  describe('removing', () => {
    it('removes a supplier that has no purchases', async () => {
      const { purchasing, useCase } = setup();
      const created = await useCase.create(memberSession('owner'), { name: 'Granos' });

      await useCase.remove(memberSession('admin'), created.id);

      expect(purchasing.suppliers.records).toEqual([]);
    });

    it('keeps one that has purchases: they are history', async () => {
      const { purchasing, useCase } = setup();
      const created = await useCase.create(memberSession('owner'), { name: 'Granos' });
      await purchasing.purchases.create({
        operationId: OTHER,
        userId: OTHER,
        warehouseId: OTHER,
        supplierId: created.id,
        note: null,
        lines: [],
      });

      await expect(useCase.remove(memberSession('owner'), created.id)).rejects.toBeInstanceOf(
        SupplierInUseError,
      );
      expect(purchasing.suppliers.records).toHaveLength(1);
    });

    it('says there is no such supplier', async () => {
      const { useCase } = setup();

      await expect(useCase.remove(memberSession('owner'), OTHER)).rejects.toBeInstanceOf(
        SupplierNotFoundError,
      );
      await expect(useCase.remove(memberSession('owner'), 'no-es-uuid')).rejects.toBeInstanceOf(
        SupplierNotFoundError,
      );
    });

    it('refuses a cashier', async () => {
      const { useCase } = setup();

      await expect(useCase.remove(memberSession('cashier'), OTHER)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    });
  });
});
