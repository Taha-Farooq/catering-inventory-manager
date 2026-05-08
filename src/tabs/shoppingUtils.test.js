import { describe, it, expect } from 'vitest';

// --- Shopping list seller subtotals ---
function getSellerTotals(shoppingList) {
  const m = {};
  shoppingList.forEach(e => {
    const s = e.selectedSeller || 'Unspecified';
    if (!m[s]) m[s] = 0;
    const qty = Number(e.quantity) || 0;
    const price = e.price != null ? Number(e.price) : 0;
    m[s] += qty * price;
  });
  return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([name, total]) => ({ name, total: +total.toFixed(2) }));
}

// --- Case unit price conversion ---
function convertPriceForUnit(entry, newUnit, caseSize) {
  const CASE_UNITS = new Set(['case', 'bag', 'box', 'flat']);
  let newPrice = entry.price;
  if (CASE_UNITS.has(newUnit) && !CASE_UNITS.has(entry.unit) && caseSize) {
    const cs = parseInt(caseSize);
    if (!isNaN(cs) && cs > 0 && entry.price != null) {
      newPrice = +(entry.price * cs).toFixed(2);
    }
  }
  if (!CASE_UNITS.has(newUnit) && CASE_UNITS.has(entry.unit) && caseSize) {
    const cs = parseInt(caseSize);
    if (!isNaN(cs) && cs > 0 && entry.price != null) {
      newPrice = +(entry.price / cs).toFixed(2);
    }
  }
  return newPrice;
}

// --- Shopping list grand total ---
function grandTotal(shoppingList) {
  return shoppingList.reduce((s, e) => s + (Number(e.quantity) || 0) * (e.price ?? 0), 0);
}

describe('getSellerTotals', () => {
  it('sums by seller correctly', () => {
    const list = [
      { selectedSeller: 'Sysco', quantity: 2, price: 5 },
      { selectedSeller: 'Sysco', quantity: 1, price: 10 },
      { selectedSeller: 'US Foods', quantity: 3, price: 4 },
    ];
    const result = getSellerTotals(list);
    expect(result).toEqual([
      { name: 'Sysco', total: 20 },
      { name: 'US Foods', total: 12 },
    ]);
  });

  it('groups blank seller as Unspecified', () => {
    const list = [{ selectedSeller: '', quantity: 1, price: 7 }];
    const result = getSellerTotals(list);
    expect(result[0].name).toBe('Unspecified');
    expect(result[0].total).toBe(7);
  });

  it('returns empty array for empty list', () => {
    expect(getSellerTotals([])).toEqual([]);
  });

  it('sorts by total descending', () => {
    const list = [
      { selectedSeller: 'A', quantity: 1, price: 5 },
      { selectedSeller: 'B', quantity: 1, price: 20 },
    ];
    const result = getSellerTotals(list);
    expect(result[0].name).toBe('B');
  });

  it('handles null price gracefully', () => {
    const list = [{ selectedSeller: 'Sysco', quantity: 3, price: null }];
    const result = getSellerTotals(list);
    expect(result[0].total).toBe(0);
  });
});

describe('convertPriceForUnit', () => {
  it('multiplies by caseSize when switching to case unit', () => {
    const entry = { unit: 'each', price: 2.5 };
    expect(convertPriceForUnit(entry, 'case', '12')).toBe(30);
  });

  it('divides by caseSize when switching from case to each', () => {
    const entry = { unit: 'case', price: 24 };
    expect(convertPriceForUnit(entry, 'each', '12')).toBe(2);
  });

  it('does not convert when no caseSize', () => {
    const entry = { unit: 'each', price: 5 };
    expect(convertPriceForUnit(entry, 'case', null)).toBe(5);
  });

  it('does not convert when caseSize is 0', () => {
    const entry = { unit: 'each', price: 5 };
    expect(convertPriceForUnit(entry, 'case', '0')).toBe(5);
  });

  it('does not convert when switching between non-case units', () => {
    const entry = { unit: 'lb', price: 3 };
    expect(convertPriceForUnit(entry, 'each', '12')).toBe(3);
  });

  it('rounds to 2 decimal places', () => {
    const entry = { unit: 'each', price: 1 };
    expect(convertPriceForUnit(entry, 'case', '3')).toBe(3.00);
    const entry2 = { unit: 'case', price: 10 };
    expect(convertPriceForUnit(entry2, 'each', '3')).toBe(3.33);
  });
});

describe('grandTotal', () => {
  it('sums all items correctly', () => {
    const list = [
      { quantity: 2, price: 5 },
      { quantity: 3, price: 4 },
    ];
    expect(grandTotal(list)).toBe(22);
  });

  it('returns 0 for empty list', () => {
    expect(grandTotal([])).toBe(0);
  });

  it('skips items with null price', () => {
    const list = [{ quantity: 5, price: null }, { quantity: 2, price: 3 }];
    expect(grandTotal(list)).toBe(6);
  });
});
