import { describe, expect, it } from 'vitest';
import { SALE_FLAGS, flagsOfSale, soldAtCatalogPrice, type SaleFacts } from './sale-flags.js';

const OCCURRED = new Date('2026-10-18T15:00:00.000Z');

/** Una venta sin nada raro: cada prueba cambia solo lo que quiere mirar. */
const clean: SaleFacts = {
  priceDiffers: false,
  claimedTotal: 42_000,
  computedTotal: 42_000,
  paidTotal: 42_000,
  occurredAt: OCCURRED,
  shiftClosedAt: null,
  deviceRevokedAt: null,
  folioDeviceCode: 'AA',
  deviceCode: 'AA',
};

describe('the flags of a sale', () => {
  it('marks nothing on a sale where everything adds up', () => {
    expect(flagsOfSale(clean)).toEqual([]);
  });

  it('marks a price or a tax rate that is not the one in the catalog', () => {
    expect(flagsOfSale({ ...clean, priceDiffers: true })).toEqual(['price-differs']);
  });

  it('marks a total that the server calculated differently from the device, in either direction', () => {
    expect(flagsOfSale({ ...clean, claimedTotal: 42_001 })).toEqual(['total-differs']);
    expect(flagsOfSale({ ...clean, claimedTotal: 41_999 })).toEqual(['total-differs']);
  });

  it('marks payments that do not add up to the total, whether they fall short or go over', () => {
    expect(flagsOfSale({ ...clean, paidTotal: 41_000 })).toEqual(['payment-mismatch']);
    expect(flagsOfSale({ ...clean, paidTotal: 50_000 })).toEqual(['payment-mismatch']);
  });

  it('accepts a sale of nothing that was paid with nothing', () => {
    expect(flagsOfSale({ ...clean, claimedTotal: 0, computedTotal: 0, paidTotal: 0 })).toEqual([]);
  });

  it('marks a sale that happened after its shift was closed, but not one that happened before it', () => {
    const closedAfter = new Date(OCCURRED.getTime() + 1);
    const closedBefore = new Date(OCCURRED.getTime() - 1);

    expect(flagsOfSale({ ...clean, shiftClosedAt: closedAfter })).toEqual([]);
    expect(flagsOfSale({ ...clean, shiftClosedAt: OCCURRED })).toEqual([]);
    expect(flagsOfSale({ ...clean, shiftClosedAt: closedBefore })).toEqual(['late-shift']);
  });

  it('marks a sale made by a device after it was revoked, but not one made before', () => {
    const revokedBefore = new Date(OCCURRED.getTime() - 1);
    const revokedAfter = new Date(OCCURRED.getTime() + 1);

    expect(flagsOfSale({ ...clean, deviceRevokedAt: revokedBefore })).toEqual(['revoked-device']);
    expect(flagsOfSale({ ...clean, deviceRevokedAt: OCCURRED })).toEqual(['revoked-device']);
    expect(flagsOfSale({ ...clean, deviceRevokedAt: revokedAfter })).toEqual([]);
  });

  it('marks a folio that does not carry the code of the device that sold', () => {
    expect(flagsOfSale({ ...clean, folioDeviceCode: 'AB' })).toEqual(['folio-device']);
  });

  it('says every flag it finds, always in the same order', () => {
    const everything = flagsOfSale({
      priceDiffers: true,
      claimedTotal: 1,
      computedTotal: 2,
      paidTotal: 3,
      occurredAt: OCCURRED,
      shiftClosedAt: new Date(OCCURRED.getTime() - 1000),
      deviceRevokedAt: new Date(OCCURRED.getTime() - 1000),
      folioDeviceCode: 'AB',
      deviceCode: 'AA',
    });

    expect(everything).toEqual([...SALE_FLAGS]);
  });

  it('knows exactly the flags the database accepts', () => {
    expect(SALE_FLAGS).toEqual([
      'price-differs',
      'total-differs',
      'payment-mismatch',
      'late-shift',
      'revoked-device',
      'folio-device',
    ]);
  });
});

describe('selling at the catalog price', () => {
  const product = { unitPrice: 8_500, taxRateBp: 1900 };

  it('is true when the price and the tax rate are the ones of the product today', () => {
    expect(soldAtCatalogPrice({ unitPrice: 8_500, taxRateBp: 1900 }, product)).toBe(true);
  });

  it('is false when the price changed', () => {
    expect(soldAtCatalogPrice({ unitPrice: 8_000, taxRateBp: 1900 }, product)).toBe(false);
  });

  it('is false when the tax rate changed', () => {
    expect(soldAtCatalogPrice({ unitPrice: 8_500, taxRateBp: 500 }, product)).toBe(false);
  });
});
