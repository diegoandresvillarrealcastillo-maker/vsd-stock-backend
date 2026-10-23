import { describe, expect, it } from 'vitest';
import { ForbiddenError, NoMembershipError } from '../../domain/model/people-errors.js';
import type { Role } from '../../domain/model/role.js';
import { ValidationFailedError } from '../../domain/model/validation.js';
import { voidFolio } from '../../domain/model/void-folio.js';
import { UserInactiveError } from '../../domain/ports/in/authenticate.js';
import type { PaymentRecord, SaleLineRecord } from '../../domain/ports/out/sales.js';
import { FakeCash } from '../../../test/support/fake-cash.js';
import { FakePeople, fakeUnitOfWork } from '../../../test/support/fake-people.js';
import { FakePurchasing } from '../../../test/support/fake-purchasing.js';
import { FakeSales } from '../../../test/support/fake-sales.js';
import { loneSession, memberSession } from '../../../test/support/sessions.js';
import { ReportsUseCase } from './reports.usecase.js';

const owner = memberSession('owner');

const setup = () => {
  const purchasing = new FakePurchasing();
  const cash = new FakeCash();
  const sales = new FakeSales(purchasing.operations, cash.shifts);
  const work = fakeUnitOfWork(
    new FakePeople(),
    'Tienda',
    undefined,
    purchasing,
    undefined,
    cash,
    sales,
  );
  return { useCase: new ReportsUseCase(work), sales, work };
};

const lines = (
  rateBp: number,
  taxKind: SaleLineRecord['taxKind'],
  price: number,
): SaleLineRecord[] => [
  {
    productId: 'f0000000-0000-4000-8000-0000000000a1',
    quantityMilli: 1000,
    unitPrice: price,
    discount: 0,
    taxRateBp: rateBp,
    taxKind,
  },
];
const cash = (amount: number): PaymentRecord[] => [{ method: 'cash', amount, reference: null }];

let counter = 0;
/** Una venta guardada a la hora que se diga, con sus lineas y cobros; se anota anulada si se dice cuando. */
const seed = (
  sales: FakeSales,
  occurredAt: string,
  saleLines: SaleLineRecord[],
  payments: PaymentRecord[],
  voidedAt?: string,
) => {
  counter += 1;
  const id = `ee000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
  sales.records.push({
    id,
    operationId: `0a1b2c3d-4e5f-4a6b-8c7d-${String(counter).padStart(12, '0')}`,
    shiftId: '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e',
    deviceId: null,
    userId: '11111111-1111-4111-8111-111111111111',
    folio: `AA-${String(counter).padStart(6, '0')}`,
    folioReported: `AA-${String(counter).padStart(6, '0')}`,
    folioConflict: false,
    total: saleLines.reduce((sum, l) => sum + l.unitPrice, 0),
    needsAdjustment: false,
    flags: [],
    timeFlags: [],
    occurredAt: new Date(occurredAt),
    receivedAt: new Date(occurredAt),
    lines: saleLines,
    payments,
  });
  if (voidedAt !== undefined) {
    sales.voids.set(id, {
      folio: voidFolio(sales.voids.size + 1),
      voidedAt: new Date(voidedAt),
      voidedByUserId: '11111111-1111-4111-8111-111111111111',
      operationId: `5e6f7a8b-4e5f-4a6b-8c7d-${String(counter).padStart(12, '0')}`,
      reason: 'Se equivocó',
    });
  }
  return id;
};

const failureOf = async (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );

describe('ReportsUseCase.monthly', () => {
  it('reports the sales of the month with the tax of each row', async () => {
    const { useCase, sales } = setup();
    seed(sales, '2026-10-10T15:00:00.000Z', lines(1900, 'taxed', 11_900), cash(11_900));
    seed(sales, '2026-10-11T15:00:00.000Z', lines(0, 'excluded', 500), cash(500));

    const report = await useCase.monthly(owner, { month: '2026-10' });

    expect(report.month).toBe('2026-10');
    expect(report.sales.count).toBe(2);
    expect(report.sales.rows[0]).toMatchObject({ taxKind: 'taxed', total: 11_900, tax: 1_900 });
    expect(report.sales.rows[3]).toMatchObject({ taxKind: 'excluded', total: 500 });
    expect(report.sales.total).toBe(12_400);
  });

  it('cuts the months at midnight in Bogotá, not at midnight UTC', async () => {
    const { useCase, sales } = setup();
    // 31 de octubre, 23:30 en Bogota (04:30 UTC del 1 de noviembre): es de octubre.
    seed(sales, '2026-11-01T04:30:00.000Z', lines(0, 'exempt', 1_000), cash(1_000));
    // 1 de noviembre, 00:30 en Bogota (05:30 UTC): es de noviembre.
    seed(sales, '2026-11-01T05:30:00.000Z', lines(0, 'exempt', 2_000), cash(2_000));
    // 1 de octubre, 00:30 en Bogota (05:30 UTC): es de octubre.
    seed(sales, '2026-10-01T05:30:00.000Z', lines(0, 'exempt', 4_000), cash(4_000));
    // 30 de septiembre, 23:30 en Bogota (04:30 UTC del 1 de octubre): es de septiembre.
    seed(sales, '2026-10-01T04:30:00.000Z', lines(0, 'exempt', 8_000), cash(8_000));

    const october = await useCase.monthly(owner, { month: '2026-10' });
    const november = await useCase.monthly(owner, { month: '2026-11' });

    expect(october.sales.total).toBe(5_000);
    expect(november.sales.total).toBe(2_000);
  });

  it('puts a void in the month it happened, apart from the month of the sale', async () => {
    const { useCase, sales } = setup();
    seed(
      sales,
      '2026-10-30T15:00:00.000Z',
      lines(1900, 'taxed', 11_900),
      cash(11_900),
      '2026-11-02T15:00:00.000Z',
    );

    const october = await useCase.monthly(owner, { month: '2026-10' });
    const november = await useCase.monthly(owner, { month: '2026-11' });

    expect(october.sales.total).toBe(11_900);
    expect(october.voids.count).toBe(0);
    expect(november.sales.total).toBe(0);
    expect(november.voids.total).toBe(11_900);
  });

  it('is the same month whoever asks among the management, and asks the business of the session', async () => {
    const { useCase, sales, work } = setup();
    seed(sales, '2026-10-10T15:00:00.000Z', lines(0, 'exempt', 1_000), cash(1_000));

    const asOwner = await useCase.monthly(memberSession('owner'), { month: '2026-10' });
    const asAdmin = await useCase.monthly(memberSession('admin'), { month: '2026-10' });

    expect(asAdmin).toEqual(asOwner);
    expect(work.openedFor).toEqual([
      memberSession('owner').membership!.businessId,
      memberSession('admin').membership!.businessId,
    ]);
  });

  it('is not for the cashier, who is told no', async () => {
    const { useCase } = setup();

    const failure = await failureOf(
      useCase.monthly(memberSession('cashier'), { month: '2026-10' }),
    );

    expect(failure).toBeInstanceOf(ForbiddenError);
  });

  it.each<[string, Role]>([
    ['owner', 'owner'],
    ['admin', 'admin'],
  ])('lets the %s see it', async (_name, role) => {
    const { useCase } = setup();

    await expect(useCase.monthly(memberSession(role), { month: '2026-10' })).resolves.toBeDefined();
  });

  it('does not open the business for someone who may not see the report', async () => {
    const { useCase, work } = setup();

    await failureOf(useCase.monthly(memberSession('cashier'), { month: '2026-10' }));

    expect(work.openedFor).toEqual([]);
  });

  it('turns away a person without a business and one who was removed', async () => {
    const { useCase } = setup();

    expect(await failureOf(useCase.monthly(loneSession(), { month: '2026-10' }))).toBeInstanceOf(
      NoMembershipError,
    );
    expect(
      await failureOf(
        useCase.monthly(memberSession('owner', { active: false }), { month: '2026-10' }),
      ),
    ).toBeInstanceOf(UserInactiveError);
  });

  it.each([
    [{}, '/month:required'],
    [{ month: '2026-13' }, '/month:invalid-month'],
    [{ month: '2026-10', extra: '1' }, '/extra:unknown-field'],
  ])('rejects the query %j with %s before opening the business', async (query, problem) => {
    const { useCase, work } = setup();

    const failure = await failureOf(useCase.monthly(owner, query));

    expect(failure).toBeInstanceOf(ValidationFailedError);
    expect((failure as ValidationFailedError).errors.map((e) => `${e.pointer}:${e.code}`)).toEqual([
      problem,
    ]);
    expect(work.openedFor).toEqual([]);
  });
});
