import { describe, expect, it } from 'vitest';
import { ATTENTION_TIME_FLAGS, requiresAttention, type SaleSignals } from './sale-attention.js';
import { SALE_FLAGS } from './sale-flags.js';

/** Una venta sin nada raro: cada prueba cambia solo lo que quiere mirar. */
const clean: SaleSignals = {
  needsAdjustment: false,
  folioConflict: false,
  flags: [],
  timeFlags: [],
};

describe('what asks for attention in a sale', () => {
  it('is nothing in a sale where everything adds up', () => {
    expect(requiresAttention(clean)).toBe(false);
  });

  it('is a product that was left with less than nothing in stock', () => {
    expect(requiresAttention({ ...clean, needsAdjustment: true })).toBe(true);
  });

  it('is a folio that was already another sale', () => {
    expect(requiresAttention({ ...clean, folioConflict: true })).toBe(true);
  });

  it.each(SALE_FLAGS)('is the flag %s that the server put on the sale', (flag) => {
    expect(requiresAttention({ ...clean, flags: [flag] })).toBe(true);
  });

  it.each(['clock-skew', 'future', 'unreadable'] as const)(
    'is a time that the server could not trust: %s',
    (flag) => {
      expect(requiresAttention({ ...clean, timeFlags: [flag] })).toBe(true);
    },
  );

  it.each(['clock-unverified', 'stale'] as const)(
    'is not a time that only informs: %s, because a device that never measured its clock is the normal case',
    (flag) => {
      expect(requiresAttention({ ...clean, timeFlags: [flag] })).toBe(false);
    },
  );

  it('is any of them, together or alone', () => {
    expect(
      requiresAttention({
        needsAdjustment: false,
        folioConflict: false,
        flags: [],
        timeFlags: ['clock-unverified', 'stale', 'future'],
      }),
    ).toBe(true);
  });

  it('knows exactly the times that ask for it', () => {
    expect([...ATTENTION_TIME_FLAGS]).toEqual(['clock-skew', 'future', 'unreadable']);
  });
});
