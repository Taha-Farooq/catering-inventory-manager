import { describe, it, expect } from 'vitest';

// --- Monthly spending computation ---
function getMonthlySpending(purchaseInvoices) {
  const months = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const ym = d.toISOString().slice(0, 7);
    const label = d.toLocaleString('default', { month: 'short', year: '2-digit' });
    const matching = purchaseInvoices.filter(inv => {
      const ds = inv.date || inv.createdAt || '';
      return ds.slice(0, 7) === ym;
    });
    const total = matching.reduce((s, inv) => s + (inv.total || 0), 0);
    months.push({ ym, label, total, count: matching.length });
  }
  return months;
}

// --- isItemLowStock logic ---
function isItemLowStock(item, LOCATIONS) {
  const cur = parseFloat(item.currentQty);
  const min = parseFloat(item.minQty);
  if (!isNaN(cur) && !isNaN(min) && cur <= min) return true;
  return LOCATIONS.some(loc => {
    const lc = loc.toLowerCase();
    const q = parseFloat(item.locQty?.[lc]);
    const m = parseFloat(item.locMinQty?.[lc]);
    return !isNaN(q) && !isNaN(m) && q <= m;
  });
}
const TEST_LOCATIONS = ['Englewood', 'Hackensack'];

// --- Top suppliers computation ---
function getTopSuppliers(purchaseInvoices) {
  const m = {};
  purchaseInvoices.forEach(inv => {
    const s = inv.supplier || 'Unknown';
    if (!m[s]) m[s] = { name: s, count: 0, total: 0 };
    m[s].count++;
    m[s].total += inv.total || 0;
  });
  return Object.values(m).sort((a, b) => b.total - a.total).slice(0, 5);
}

// ---- Tests ----

describe('getMonthlySpending', () => {
  it('returns exactly 6 entries', () => {
    const result = getMonthlySpending([]);
    expect(result).toHaveLength(6);
  });

  it('all totals are 0 for empty invoice array', () => {
    const result = getMonthlySpending([]);
    result.forEach(entry => {
      expect(entry.total).toBe(0);
      expect(entry.count).toBe(0);
    });
  });

  it('invoice in current month appears in last entry total', () => {
    const now = new Date();
    const currentYM = now.toISOString().slice(0, 7);
    const invoices = [{ date: `${currentYM}-15`, total: 250 }];
    const result = getMonthlySpending(invoices);
    const last = result[result.length - 1];
    expect(last.ym).toBe(currentYM);
    expect(last.total).toBe(250);
    expect(last.count).toBe(1);
  });

  it('invoice with no date (empty string) is not counted', () => {
    const invoices = [{ date: '', total: 999 }];
    const result = getMonthlySpending(invoices);
    result.forEach(entry => {
      expect(entry.total).toBe(0);
    });
  });
});

describe('isItemLowStock', () => {
  it('returns true when locQty is below locMinQty for a location', () => {
    const item = {
      locQty: { englewood: '3' },
      locMinQty: { englewood: '5' },
    };
    expect(isItemLowStock(item, TEST_LOCATIONS)).toBe(true);
  });

  it('returns false when locQty is above locMinQty for all locations', () => {
    const item = {
      locQty: { englewood: '10', hackensack: '8' },
      locMinQty: { englewood: '5', hackensack: '5' },
    };
    expect(isItemLowStock(item, TEST_LOCATIONS)).toBe(false);
  });

  it('returns true when legacy currentQty is at or below minQty', () => {
    expect(isItemLowStock({ currentQty: '4', minQty: '5' }, TEST_LOCATIONS)).toBe(true);
    expect(isItemLowStock({ currentQty: '5', minQty: '5' }, TEST_LOCATIONS)).toBe(true);
  });
});

describe('getTopSuppliers', () => {
  it('returns empty array for empty invoice list', () => {
    expect(getTopSuppliers([])).toEqual([]);
  });

  it('sums totals correctly across multiple invoices for the same supplier', () => {
    const invoices = [
      { supplier: 'Sysco', total: 100 },
      { supplier: 'Sysco', total: 200 },
      { supplier: 'US Foods', total: 150 },
    ];
    const result = getTopSuppliers(invoices);
    const sysco = result.find(r => r.name === 'Sysco');
    const usfoods = result.find(r => r.name === 'US Foods');
    expect(sysco.total).toBe(300);
    expect(sysco.count).toBe(2);
    expect(usfoods.total).toBe(150);
    expect(usfoods.count).toBe(1);
  });

  it('returns top 5 suppliers sorted by total descending', () => {
    const invoices = [
      { supplier: 'A', total: 10 },
      { supplier: 'B', total: 50 },
      { supplier: 'C', total: 30 },
      { supplier: 'D', total: 80 },
      { supplier: 'E', total: 60 },
      { supplier: 'F', total: 90 },
    ];
    const result = getTopSuppliers(invoices);
    expect(result).toHaveLength(5);
    // Sorted descending by total: F(90), D(80), E(60), B(50), C(30)
    expect(result[0].name).toBe('F');
    expect(result[0].total).toBe(90);
    expect(result[1].name).toBe('D');
    expect(result[4].name).toBe('C');
    // Supplier A (total 10) should be excluded
    expect(result.find(r => r.name === 'A')).toBeUndefined();
  });
});
