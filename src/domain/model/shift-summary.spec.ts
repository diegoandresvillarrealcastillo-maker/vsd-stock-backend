import { describe, expect, it } from 'vitest';
import { summarizeShift, type ShiftCashTotals } from './shift-summary.js';

const totals = (change: Partial<ShiftCashTotals> = {}): ShiftCashTotals => ({
  cashSales: 0,
  cashIn: 0,
  cashOut: 0,
  late: { count: 0, cashAmount: 0 },
  ...change,
});

describe('the cash count of a shift', () => {
  it('expects what the drawer started with, plus the cash of the sales and what went in, minus what went out', () => {
    const summary = summarizeShift(
      { openingAmount: 50_000, countedAmount: null },
      totals({ cashSales: 120_000, cashIn: 10_000, cashOut: 30_000 }),
    );

    expect(summary.expectedAmount).toBe(150_000);
    expect(summary).toMatchObject({
      openingAmount: 50_000,
      cashSales: 120_000,
      cashIn: 10_000,
      cashOut: 30_000,
    });
  });

  it('has no counted amount and no difference while the shift is open', () => {
    const summary = summarizeShift({ openingAmount: 1000, countedAmount: null }, totals());

    expect(summary.countedAmount).toBeNull();
    expect(summary.difference).toBeNull();
  });

  it('says how much is missing as a negative difference and how much is left over as a positive one', () => {
    const short = summarizeShift(
      { openingAmount: 1000, countedAmount: 900 },
      totals({ cashSales: 500 }),
    );
    const over = summarizeShift(
      { openingAmount: 1000, countedAmount: 1700 },
      totals({ cashSales: 500 }),
    );
    const exact = summarizeShift(
      { openingAmount: 1000, countedAmount: 1500 },
      totals({ cashSales: 500 }),
    );

    expect([short.difference, over.difference, exact.difference]).toEqual([-600, 200, 0]);
    expect(short.countedAmount).toBe(900);
  });

  it('counts a drawer with nothing in it: zero is a count, not a missing one', () => {
    const summary = summarizeShift({ openingAmount: 0, countedAmount: 0 }, totals());

    expect(summary.countedAmount).toBe(0);
    expect(summary.difference).toBe(0);
  });

  it('shows the sales that arrived after the shift was closed apart, and does not add them to what is expected', () => {
    const summary = summarizeShift(
      { openingAmount: 1000, countedAmount: 1500 },
      totals({ cashSales: 500, late: { count: 2, cashAmount: 700 } }),
    );

    expect(summary.expectedAmount).toBe(1500);
    expect(summary.difference).toBe(0);
    expect(summary.lateSales).toEqual({ count: 2, cashAmount: 700 });
  });
});
