import { describe, expect, it } from 'vitest';
import {
  BarcodeTakenError,
  ProductNotFoundError,
  SkuTakenError,
  UnitLockedError,
} from '../../domain/model/catalog-errors.js';
import { encodeCursor } from '../../domain/model/pagination.js';
import { ForbiddenError, NoMembershipError } from '../../domain/model/people-errors.js';
import { ValidationFailedError } from '../../domain/model/validation.js';
import { UserInactiveError } from '../../domain/ports/in/authenticate.js';
import { FakeCatalog } from '../../../test/support/fake-catalog.js';
import { FakePeople, fakeUnitOfWork } from '../../../test/support/fake-people.js';
import { BUSINESS_ID, loneSession, memberSession } from '../../../test/support/sessions.js';
import { ProductsUseCase } from './products.usecase.js';

const BARCODE = '7701234567897';
const OTHER_BARCODE = '7709876543217';
const MISSING = '99999999-9999-4999-8999-999999999999';

const arroz = {
  name: 'Arroz 500 g',
  sku: 'ARR-500',
  unit: 'unit',
  unitPrice: 3200,
  taxRateBp: 0,
  taxKind: 'exempt',
};

const setup = () => {
  const catalog = new FakeCatalog();
  const work = fakeUnitOfWork(new FakePeople(), 'Tienda', catalog);
  return { catalog, work, useCase: new ProductsUseCase(work) };
};

const failureOf = async (attempt: Promise<unknown>): Promise<ValidationFailedError> => {
  const error = await attempt.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ValidationFailedError);
  return error as ValidationFailedError;
};

describe('ProductsUseCase', () => {
  describe('creating', () => {
    it('creates an active product and hands it back with its price in whole pesos', async () => {
      const { useCase } = setup();

      const product = await useCase.create(memberSession('admin'), { ...arroz, barcode: BARCODE });

      expect(product).toMatchObject({
        name: 'Arroz 500 g',
        sku: 'ARR-500',
        barcode: BARCODE,
        unit: 'unit',
        unitPrice: 3200,
        taxRateBp: 0,
        taxKind: 'exempt',
        active: true,
        categoryId: null,
        minStockMilli: null,
      });
    });

    it.each([
      ['taxed', 1900],
      ['taxed', 500],
      ['exempt', 0],
      ['excluded', 0],
    ] as const)('keeps the tax kind %s with %i basis points', async (taxKind, taxRateBp) => {
      const { useCase } = setup();

      const product = await useCase.create(memberSession('admin'), {
        ...arroz,
        taxKind,
        taxRateBp,
      });

      expect(product).toMatchObject({ taxKind, taxRateBp });
    });

    it('refuses a tax kind that does not fit the rate and creates nothing', async () => {
      const { catalog, useCase } = setup();

      const failure = await failureOf(
        useCase.create(memberSession('admin'), { ...arroz, taxKind: 'taxed', taxRateBp: 0 }),
      );

      expect(failure.errors.map((e) => `${e.pointer}:${e.code}`)).toEqual([
        '/taxKind:tax-kind-rate-mismatch',
      ]);
      expect(catalog.products).toEqual([]);
    });

    it('wants the tax kind: a product without it would sell without a classification (ADR 0034)', async () => {
      const { useCase } = setup();
      const { taxKind: _omitted, ...withoutKind } = arroz;

      const failure = await failureOf(useCase.create(memberSession('admin'), withoutKind));

      expect(failure.errors.map((e) => `${e.pointer}:${e.code}`)).toEqual(['/taxKind:required']);
    });

    it('works inside the business of the person who asks', async () => {
      const { work, useCase } = setup();

      await useCase.create(memberSession('owner'), arroz);

      expect(work.openedFor).toEqual([BUSINESS_ID]);
    });

    it('puts the product in a category of the business', async () => {
      const { catalog, useCase } = setup();
      const category = await catalog.createCategory('Granos');

      const product = await useCase.create(memberSession('owner'), {
        ...arroz,
        categoryId: category.id,
      });

      expect(product.categoryId).toBe(category.id);
    });

    it('refuses a category that does not exist in the business, as a problem of that field', async () => {
      const { catalog, useCase } = setup();

      const failure = await failureOf(
        useCase.create(memberSession('owner'), { ...arroz, categoryId: MISSING }),
      );

      expect(failure.errors).toEqual([
        {
          pointer: '/categoryId',
          code: 'unknown-category',
          detail: 'No existe esa categoría en este negocio.',
        },
      ]);
      expect(catalog.products).toEqual([]);
    });

    it('refuses a SKU already taken, whatever its case', async () => {
      const { useCase } = setup();
      await useCase.create(memberSession('owner'), arroz);

      await expect(
        useCase.create(memberSession('owner'), { ...arroz, sku: 'arr-500' }),
      ).rejects.toBeInstanceOf(SkuTakenError);
    });

    it('refuses a barcode already taken, also when it is the UPC-A of an EAN-13', async () => {
      const { useCase } = setup();
      await useCase.create(memberSession('owner'), { ...arroz, barcode: BARCODE });

      await expect(
        useCase.create(memberSession('owner'), { ...arroz, sku: 'OTRO', barcode: BARCODE }),
      ).rejects.toBeInstanceOf(BarcodeTakenError);
    });

    it('reports every problem together and creates nothing', async () => {
      const { catalog, useCase } = setup();

      const failure = await failureOf(
        useCase.create(memberSession('owner'), {
          name: '',
          sku: 'mal é',
          unit: 'box',
          unitPrice: -1,
          taxRateBp: 7,
          taxKind: 'taxed',
        }),
      );

      expect(failure.errors.map((e) => `${e.pointer}:${e.code}`)).toEqual([
        '/name:blank',
        '/sku:invalid-sku',
        '/unit:invalid-value',
        '/unitPrice:out-of-range',
        '/taxRateBp:invalid-value',
      ]);
      expect(catalog.products).toEqual([]);
    });

    it('is for the management: an administrator can, a cashier can not', async () => {
      const { useCase } = setup();

      await expect(useCase.create(memberSession('admin'), arroz)).resolves.toBeDefined();
      await expect(
        useCase.create(memberSession('cashier'), { ...arroz, sku: 'OTRO' }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  describe('looking at the catalog', () => {
    const fill = async () => {
      const { catalog, useCase } = setup();
      const granos = await catalog.createCategory('Granos');
      const owner = memberSession('owner');
      await useCase.create(owner, { ...arroz, categoryId: granos.id, barcode: BARCODE });
      await useCase.create(owner, {
        name: 'Azúcar 1 kg',
        sku: 'AZU-1K',
        unit: 'unit',
        unitPrice: 4500,
        taxRateBp: 0,
        taxKind: 'exempt',
      });
      await useCase.create(owner, {
        name: 'Leche entera',
        sku: 'LEC-1L',
        unit: 'liter',
        unitPrice: 4200,
        taxRateBp: 500,
        taxKind: 'taxed',
        barcode: OTHER_BARCODE,
      });
      const archived = await useCase.create(owner, {
        name: 'Aceite',
        sku: 'ACE-1L',
        unit: 'liter',
        unitPrice: 12000,
        taxRateBp: 1900,
        taxKind: 'taxed',
      });
      await useCase.update(owner, archived.id, { active: false });
      return { catalog, useCase, granos };
    };

    it('lets every role look: owner, administrator and cashier', async () => {
      const { useCase } = await fill();

      for (const role of ['owner', 'admin', 'cashier'] as const) {
        const page = await useCase.list(memberSession(role), {});
        expect(page.items.map((p) => p.name)).toEqual([
          'Aceite',
          'Arroz 500 g',
          'Azúcar 1 kg',
          'Leche entera',
        ]);
      }
    });

    it('gets one product by id', async () => {
      const { useCase } = await fill();
      const [first] = (await useCase.list(memberSession('cashier'), {})).items;

      await expect(useCase.get(memberSession('cashier'), first!.id)).resolves.toEqual(first);
    });

    it('says there is no such product, also for an id that is not a UUID', async () => {
      const { work, useCase } = setup();

      await expect(useCase.get(memberSession('owner'), MISSING)).rejects.toBeInstanceOf(
        ProductNotFoundError,
      );
      work.openedFor.length = 0;
      await expect(useCase.get(memberSession('owner'), 'no-es-uuid')).rejects.toBeInstanceOf(
        ProductNotFoundError,
      );
      expect(work.openedFor).toEqual([]);
    });

    it('filters by a part of the name or the SKU, whatever the case', async () => {
      const { useCase } = await fill();

      expect(
        (await useCase.list(memberSession('owner'), { search: 'azú' })).items.map((p) => p.sku),
      ).toEqual(['AZU-1K']);
      expect(
        (await useCase.list(memberSession('owner'), { search: 'arr-5' })).items.map((p) => p.sku),
      ).toEqual(['ARR-500']);
    });

    it('finds a product by its whole barcode', async () => {
      const { useCase } = await fill();

      const page = await useCase.list(memberSession('owner'), { search: OTHER_BARCODE });

      expect(page.items.map((p) => p.sku)).toEqual(['LEC-1L']);
    });

    it('filters by category and by whether it is active', async () => {
      const { useCase, granos } = await fill();

      expect(
        (await useCase.list(memberSession('owner'), { categoryId: granos.id })).items.map(
          (p) => p.sku,
        ),
      ).toEqual(['ARR-500']);
      expect(
        (await useCase.list(memberSession('owner'), { active: 'false' })).items.map((p) => p.sku),
      ).toEqual(['ACE-1L']);
      expect(
        (await useCase.list(memberSession('owner'), { active: 'true' })).items.map((p) => p.sku),
      ).toEqual(['ARR-500', 'AZU-1K', 'LEC-1L']);
    });

    it('walks the list in pages without repeating or skipping anyone', async () => {
      const { useCase } = await fill();
      const seen: string[] = [];
      let cursor: string | null | undefined;

      for (let pages = 0; pages < 10; pages += 1) {
        const page = await useCase.list(
          memberSession('owner'),
          cursor ? { limit: '3', cursor } : { limit: '3' },
        );
        seen.push(...page.items.map((p) => p.sku));
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }

      expect(seen).toEqual(['ACE-1L', 'ARR-500', 'AZU-1K', 'LEC-1L']);
    });

    it('refuses a filter it does not understand, every one at once', async () => {
      const { useCase } = setup();

      const failure = await failureOf(
        useCase.list(memberSession('owner'), {
          active: 'quizas',
          categoryId: 'x',
          search: '',
          limit: '0',
        }),
      );

      expect(failure.errors.map((e) => `${e.pointer}:${e.code}`)).toEqual([
        '/limit:out-of-range',
        '/search:blank',
        '/categoryId:invalid-id',
        '/active:invalid-value',
      ]);
    });

    it('refuses a cursor whose id is not a UUID, which the database could not compare', async () => {
      const { useCase } = setup();

      const failure = await failureOf(
        useCase.list(memberSession('owner'), {
          cursor: encodeCursor(['Arroz', 'no-es-un-uuid']),
        }),
      );

      expect(failure.errors.map((e) => `${e.pointer}:${e.code}`)).toEqual([
        '/cursor:invalid-cursor',
      ]);
    });
  });

  describe('changing a product', () => {
    it('changes the name and the category, and leaves the rest', async () => {
      const { catalog, useCase } = setup();
      const granos = await catalog.createCategory('Granos');
      const created = await useCase.create(memberSession('owner'), arroz);

      const updated = await useCase.update(memberSession('admin'), created.id, {
        name: 'Arroz blanco',
        categoryId: granos.id,
      });

      expect(updated).toMatchObject({
        name: 'Arroz blanco',
        categoryId: granos.id,
        sku: 'ARR-500',
        unitPrice: 3200,
      });
    });

    it('archives a product and brings it back', async () => {
      const { useCase } = setup();
      const created = await useCase.create(memberSession('owner'), arroz);

      expect(
        (await useCase.update(memberSession('owner'), created.id, { active: false })).active,
      ).toBe(false);
      expect(
        (await useCase.update(memberSession('owner'), created.id, { active: true })).active,
      ).toBe(true);
    });

    it('changes the price, which takes the price permission too', async () => {
      const { useCase } = setup();
      const created = await useCase.create(memberSession('owner'), arroz);

      const updated = await useCase.update(memberSession('admin'), created.id, { unitPrice: 3500 });

      expect(updated.unitPrice).toBe(3500);
      await expect(
        useCase.update(memberSession('cashier'), created.id, { unitPrice: 1 }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('clears the barcode, the category and the minimum stock with null', async () => {
      const { catalog, useCase } = setup();
      const granos = await catalog.createCategory('Granos');
      const created = await useCase.create(memberSession('owner'), {
        ...arroz,
        barcode: BARCODE,
        categoryId: granos.id,
        minStockMilli: 5000,
      });

      const updated = await useCase.update(memberSession('owner'), created.id, {
        barcode: null,
        categoryId: null,
        minStockMilli: null,
      });

      expect(updated).toMatchObject({ barcode: null, categoryId: null, minStockMilli: null });
    });

    it('keeps the SKU of the product itself without calling it taken', async () => {
      const { useCase } = setup();
      const created = await useCase.create(memberSession('owner'), arroz);

      await expect(
        useCase.update(memberSession('owner'), created.id, { sku: 'arr-500' }),
      ).resolves.toMatchObject({
        sku: 'arr-500',
      });
    });

    it('refuses the SKU or the barcode of another product', async () => {
      const { useCase } = setup();
      await useCase.create(memberSession('owner'), { ...arroz, barcode: BARCODE });
      const other = await useCase.create(memberSession('owner'), { ...arroz, sku: 'OTRO' });

      await expect(
        useCase.update(memberSession('owner'), other.id, { sku: 'ARR-500' }),
      ).rejects.toBeInstanceOf(SkuTakenError);
      await expect(
        useCase.update(memberSession('owner'), other.id, { barcode: BARCODE }),
      ).rejects.toBeInstanceOf(BarcodeTakenError);
    });

    it('refuses a category that does not exist', async () => {
      const { useCase } = setup();
      const created = await useCase.create(memberSession('owner'), arroz);

      const failure = await failureOf(
        useCase.update(memberSession('owner'), created.id, { categoryId: MISSING }),
      );

      expect(failure.errors[0]).toMatchObject({ pointer: '/categoryId', code: 'unknown-category' });
    });

    describe('the tax kind and the rate (ADR 0034)', () => {
      const mismatch = (pointer: string) => ({
        pointer,
        code: 'tax-kind-rate-mismatch',
        detail:
          'El tipo gravado lleva una tarifa de 5 % o 19 %; el exento y el excluido llevan 0 %.',
      });

      it('moves a product from exempt to excluded with the kind alone, because the rate stays at 0 %', async () => {
        const { useCase } = setup();
        const created = await useCase.create(memberSession('owner'), arroz);

        const updated = await useCase.update(memberSession('owner'), created.id, {
          taxKind: 'excluded',
        });

        expect(updated).toMatchObject({ taxKind: 'excluded', taxRateBp: 0 });
      });

      it('moves a product to taxed when the kind and the rate come together', async () => {
        const { useCase } = setup();
        const created = await useCase.create(memberSession('owner'), arroz);

        const updated = await useCase.update(memberSession('owner'), created.id, {
          taxKind: 'taxed',
          taxRateBp: 1900,
        });

        expect(updated).toMatchObject({ taxKind: 'taxed', taxRateBp: 1900 });
      });

      it('changes the rate of a taxed product between 5 % and 19 % with the rate alone', async () => {
        const { useCase } = setup();
        const created = await useCase.create(memberSession('owner'), {
          ...arroz,
          taxKind: 'taxed',
          taxRateBp: 500,
        });

        const updated = await useCase.update(memberSession('owner'), created.id, {
          taxRateBp: 1900,
        });

        expect(updated).toMatchObject({ taxKind: 'taxed', taxRateBp: 1900 });
      });

      it('refuses the rate alone when it does not fit the kind the product already has', async () => {
        const { catalog, useCase } = setup();
        const created = await useCase.create(memberSession('owner'), arroz);

        const failure = await failureOf(
          useCase.update(memberSession('owner'), created.id, { taxRateBp: 1900 }),
        );

        expect(failure.errors).toEqual([mismatch('/taxRateBp')]);
        expect(catalog.products[0]).toMatchObject({ taxKind: 'exempt', taxRateBp: 0 });
      });

      it('refuses the kind alone when it does not fit the rate the product already has', async () => {
        const { catalog, useCase } = setup();
        const created = await useCase.create(memberSession('owner'), {
          ...arroz,
          taxKind: 'taxed',
          taxRateBp: 1900,
        });

        const failure = await failureOf(
          useCase.update(memberSession('owner'), created.id, { taxKind: 'exempt' }),
        );

        expect(failure.errors).toEqual([mismatch('/taxKind')]);
        expect(catalog.products[0]).toMatchObject({ taxKind: 'taxed', taxRateBp: 1900 });
      });

      it('does not judge the pair that is stored when the change does not touch the tax', async () => {
        const { catalog, useCase } = setup();
        const created = await useCase.create(memberSession('owner'), arroz);
        // La base no deja guardar un par que no cabe; si alguna vez hubiera uno, cambiar el nombre no es lo que lo arregla ni lo que lo impide.
        catalog.products[0] = { ...catalog.products[0]!, taxKind: 'taxed', taxRateBp: 0 };

        const updated = await useCase.update(memberSession('owner'), created.id, { name: 'Arroz' });

        expect(updated.name).toBe('Arroz');
      });
    });

    describe('the unit', () => {
      it('changes while the product has no stock movements', async () => {
        const { useCase } = setup();
        const created = await useCase.create(memberSession('owner'), arroz);

        expect(
          (await useCase.update(memberSession('owner'), created.id, { unit: 'kilogram' })).unit,
        ).toBe('kilogram');
      });

      it('does not change once the product has stock movements (ADR 0015)', async () => {
        const { catalog, useCase } = setup();
        const created = await useCase.create(memberSession('owner'), arroz);
        catalog.moved.add(created.id);

        await expect(
          useCase.update(memberSession('owner'), created.id, { unit: 'kilogram' }),
        ).rejects.toBeInstanceOf(UnitLockedError);
        expect(catalog.products[0]?.unit).toBe('unit');
      });

      it('lets a product with movements keep its unit when the same one is sent', async () => {
        const { catalog, useCase } = setup();
        const created = await useCase.create(memberSession('owner'), arroz);
        catalog.moved.add(created.id);

        await expect(
          useCase.update(memberSession('owner'), created.id, { unit: 'unit', name: 'Arroz' }),
        ).resolves.toMatchObject({ unit: 'unit', name: 'Arroz' });
      });

      it('lets a product with movements change anything else', async () => {
        const { catalog, useCase } = setup();
        const created = await useCase.create(memberSession('owner'), arroz);
        catalog.moved.add(created.id);

        await expect(
          useCase.update(memberSession('owner'), created.id, { unitPrice: 4000 }),
        ).resolves.toMatchObject({
          unitPrice: 4000,
        });
      });
    });

    it('says there is no such product, also for an id that is not a UUID', async () => {
      const { work, useCase } = setup();

      await expect(
        useCase.update(memberSession('owner'), MISSING, { name: 'x' }),
      ).rejects.toBeInstanceOf(ProductNotFoundError);
      work.openedFor.length = 0;
      await expect(
        useCase.update(memberSession('owner'), 'no-es-uuid', { name: 'x' }),
      ).rejects.toBeInstanceOf(ProductNotFoundError);
      expect(work.openedFor).toEqual([]);
    });

    it('refuses a cashier before looking at what they sent', async () => {
      const { useCase } = setup();

      await expect(
        useCase.update(memberSession('cashier'), MISSING, { basura: 1 }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('asks for at least one change', async () => {
      const { useCase } = setup();
      const created = await useCase.create(memberSession('owner'), arroz);

      const failure = await failureOf(useCase.update(memberSession('owner'), created.id, {}));

      expect(failure.errors[0]).toMatchObject({ code: 'empty-change' });
    });
  });

  it('asks a person with no business to open one first, and refuses one who was deactivated', async () => {
    const { useCase } = setup();

    await expect(useCase.list(loneSession(), {})).rejects.toBeInstanceOf(NoMembershipError);
    await expect(
      useCase.get(memberSession('owner', { active: false }), MISSING),
    ).rejects.toBeInstanceOf(UserInactiveError);
  });
});
