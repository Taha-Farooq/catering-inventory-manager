import { describe, it, expect } from 'vitest';

// Replicates normalizeImportHeaders from ItemDatabase.jsx
const IMPORT_COL = {
  name: ['name','item name','item'],
  category: ['category','cat'],
  unit: ['unit','uom','unit of measure'],
  caseSize: ['case size', 'casesize', 'case_size', 'units per case'],
  upc: ['upc','barcode'],
  seller: ['seller','supplier','vendor'],
  price: ['price','unit price','cost','$/unit'],
  notes: ['notes','note'],
};
const LOCATIONS = ['Englewood', 'Hackensack'];

function normalizeImportHeaders(headers) {
  const map = {};
  headers.forEach((h, i) => {
    const lc = String(h).toLowerCase().trim();
    for (const [key, aliases] of Object.entries(IMPORT_COL)) {
      if (aliases.includes(lc) && !(key in map)) { map[key] = i; break; }
    }
    LOCATIONS.forEach(loc => {
      const lcLoc = loc.toLowerCase();
      if (lc === lcLoc + '_qty' && !(`locQty_${lcLoc}` in map)) map[`locQty_${lcLoc}`] = i;
      if (lc === lcLoc + '_min' && !(`locMinQty_${lcLoc}` in map)) map[`locMinQty_${lcLoc}`] = i;
    });
  });
  return map;
}

// Replicates parseNum from DailyIncomeExpense.jsx (for completeness — tested in dailyFinanceUtils.test.js)
function parseNum(v) {
  if (v === '' || v == null) return 0;
  const n = parseFloat(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? +n.toFixed(2) : 0;
}

describe('normalizeImportHeaders', () => {
  it('maps "name" header to column index 0', () => {
    const map = normalizeImportHeaders(['name', 'category', 'unit', 'price']);
    expect(map.name).toBe(0);
  });

  it('maps alias "item name" to name key', () => {
    const map = normalizeImportHeaders(['item name', 'price']);
    expect(map.name).toBe(0);
  });

  it('maps alias "item" to name key', () => {
    const map = normalizeImportHeaders(['item', 'seller', 'price']);
    expect(map.name).toBe(0);
  });

  it('maps all primary column aliases', () => {
    const map = normalizeImportHeaders(['name', 'cat', 'uom', 'barcode', 'vendor', 'cost', 'note', 'case size']);
    expect(map.name).toBe(0);
    expect(map.category).toBe(1);
    expect(map.unit).toBe(2);
    expect(map.upc).toBe(3);
    expect(map.seller).toBe(4);
    expect(map.price).toBe(5);
    expect(map.notes).toBe(6);
    expect(map.caseSize).toBe(7);
  });

  it('maps "supplier" to seller key', () => {
    const map = normalizeImportHeaders(['name', 'supplier']);
    expect(map.seller).toBe(1);
  });

  it('maps "unit price" to price key', () => {
    const map = normalizeImportHeaders(['name', 'unit price']);
    expect(map.price).toBe(1);
  });

  it('maps "$/unit" to price key', () => {
    const map = normalizeImportHeaders(['name', '$/unit']);
    expect(map.price).toBe(1);
  });

  it('maps location qty columns (e.g. englewood_qty)', () => {
    const map = normalizeImportHeaders(['name', 'englewood_qty', 'hackensack_qty']);
    expect(map['locQty_englewood']).toBe(1);
    expect(map['locQty_hackensack']).toBe(2);
  });

  it('maps location min columns (e.g. hackensack_min)', () => {
    const map = normalizeImportHeaders(['name', 'englewood_min', 'hackensack_min']);
    expect(map['locMinQty_englewood']).toBe(1);
    expect(map['locMinQty_hackensack']).toBe(2);
  });

  it('is case-insensitive for header names', () => {
    const map = normalizeImportHeaders(['NAME', 'Category', 'UNIT PRICE']);
    expect(map.name).toBe(0);
    expect(map.category).toBe(1);
    expect(map.price).toBe(2);
  });

  it('trims whitespace from header values', () => {
    const map = normalizeImportHeaders(['  name  ', '  price  ']);
    expect(map.name).toBe(0);
    expect(map.price).toBe(1);
  });

  it('returns empty map for headers with no recognized columns', () => {
    const map = normalizeImportHeaders(['foo', 'bar', 'baz']);
    expect(Object.keys(map)).toHaveLength(0);
  });

  it('takes first occurrence when a key appears twice (no overwrite)', () => {
    const map = normalizeImportHeaders(['name', 'item name']);
    expect(map.name).toBe(0);
  });

  it('ignores unknown location prefixes', () => {
    const map = normalizeImportHeaders(['name', 'london_qty']);
    expect(map['locQty_london']).toBeUndefined();
  });
});
