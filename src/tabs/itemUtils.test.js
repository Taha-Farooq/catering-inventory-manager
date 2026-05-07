import { describe, it, expect } from 'vitest';

// Replicates the isLowStock pattern from ItemDatabase as a pure function
function isLowStock(item) {
  const locations = ['Englewood', 'Hackensack'];
  const cur = parseFloat(item.currentQty);
  const min = parseFloat(item.minQty);
  if (!isNaN(cur) && !isNaN(min) && cur <= min) return true;
  return locations.some(loc => {
    const lc = loc.toLowerCase();
    const q = parseFloat(item.locQty?.[lc]);
    const m = parseFloat(item.locMinQty?.[lc]);
    return !isNaN(q) && !isNaN(m) && q <= m;
  });
}

describe('isLowStock', () => {
  it('returns true when currentQty is below minQty (legacy)', () => {
    expect(isLowStock({ currentQty: '3', minQty: '5' })).toBe(true);
  });

  it('returns false when currentQty is above minQty (legacy)', () => {
    expect(isLowStock({ currentQty: '10', minQty: '5' })).toBe(false);
  });

  it('returns true when per-location qty is below location min', () => {
    expect(isLowStock({ locQty: { englewood: '2' }, locMinQty: { englewood: '5' } })).toBe(true);
  });

  it('returns false when per-location qty is above location min', () => {
    expect(isLowStock({ locQty: { englewood: '10' }, locMinQty: { englewood: '5' } })).toBe(false);
  });

  it('returns false when qty data is empty or missing', () => {
    expect(isLowStock({})).toBe(false);
    expect(isLowStock({ currentQty: '', minQty: '' })).toBe(false);
    expect(isLowStock({ currentQty: null, minQty: null })).toBe(false);
  });

  it('returns true when per-location qty equals location min (at min = low)', () => {
    expect(isLowStock({ locQty: { englewood: '5' }, locMinQty: { englewood: '5' } })).toBe(true);
  });
});
