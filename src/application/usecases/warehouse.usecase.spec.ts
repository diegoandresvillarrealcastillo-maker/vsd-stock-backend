import { describe, expect, it } from 'vitest';
import { NoMembershipError } from '../../domain/model/people-errors.js';
import { WarehouseMissingError } from '../../domain/model/purchase-errors.js';
import { UserInactiveError } from '../../domain/ports/in/authenticate.js';
import { FakeCatalog } from '../../../test/support/fake-catalog.js';
import { FakePeople, fakeUnitOfWork } from '../../../test/support/fake-people.js';
import { FakePurchasing, WAREHOUSE_ID } from '../../../test/support/fake-purchasing.js';
import { BUSINESS_ID, loneSession, memberSession } from '../../../test/support/sessions.js';
import { WarehouseUseCase } from './warehouse.usecase.js';

const setup = () => {
  const purchasing = new FakePurchasing();
  const work = fakeUnitOfWork(new FakePeople(), 'Tienda', new FakeCatalog(), purchasing);
  return { purchasing, work, useCase: new WarehouseUseCase(work) };
};

describe('WarehouseUseCase', () => {
  it('hands the one warehouse of the business to every role', async () => {
    const { work, useCase } = setup();

    for (const role of ['owner', 'admin', 'cashier'] as const) {
      await expect(useCase.get(memberSession(role))).resolves.toEqual({
        id: WAREHOUSE_ID,
        name: 'Principal',
      });
    }
    expect(work.openedFor).toEqual([BUSINESS_ID, BUSINESS_ID, BUSINESS_ID]);
  });

  it('says so when the business has none', async () => {
    const { purchasing, useCase } = setup();
    purchasing.stock.warehouseRecord = null;

    await expect(useCase.get(memberSession('owner'))).rejects.toBeInstanceOf(WarehouseMissingError);
  });

  it('refuses a person with no business and a person who was let go', async () => {
    const { useCase } = setup();

    await expect(useCase.get(loneSession())).rejects.toBeInstanceOf(NoMembershipError);
    await expect(useCase.get(memberSession('owner', { active: false }))).rejects.toBeInstanceOf(
      UserInactiveError,
    );
  });
});
