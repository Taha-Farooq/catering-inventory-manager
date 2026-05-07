import { describe, it, expect } from 'vitest';

// Replicates analytics computations as pure functions

function groupByEventType(cateringInvoices) {
  const m = {};
  cateringInvoices.forEach(i => { const t = i.eventType || 'Other'; m[t] = (m[t] || 0) + (i.grandTotal || 0); });
  return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, v]) => ({ name, total: +v.toFixed(2) }));
}

function topCustomers(cateringInvoices) {
  const m = {};
  cateringInvoices.forEach(i => { const c = i.customerName || 'Unknown'; m[c] = (m[c] || 0) + (i.grandTotal || 0); });
  return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, v]) => ({ name, total: +v.toFixed(2) }));
}

function filterByDateRange(invoices, fromDate, toDate, dateField = 'date') {
  return invoices.filter(i => {
    const d = i[dateField] || i.dateStart || i.createdAt || '';
    if (fromDate && d < fromDate) return false;
    if (toDate && d > toDate) return false;
    return true;
  });
}

function grossMargin(totalRevenue, totalExpenses) {
  if (totalRevenue <= 0) return null;
  return +((totalRevenue - totalExpenses) / totalRevenue * 100).toFixed(1);
}

describe('groupByEventType', () => {
  it('returns empty array for empty invoices', () => {
    expect(groupByEventType([])).toEqual([]);
  });

  it('groups by eventType and sums grandTotal', () => {
    const invs = [
      { eventType: 'Wedding', grandTotal: 1000 },
      { eventType: 'Wedding', grandTotal: 500 },
      { eventType: 'Corporate', grandTotal: 800 },
    ];
    const result = groupByEventType(invs);
    const wedding = result.find(r => r.name === 'Wedding');
    const corp = result.find(r => r.name === 'Corporate');
    expect(wedding.total).toBe(1500);
    expect(corp.total).toBe(800);
  });

  it('uses "Other" when eventType is missing', () => {
    const invs = [{ grandTotal: 300 }];
    const result = groupByEventType(invs);
    expect(result[0].name).toBe('Other');
    expect(result[0].total).toBe(300);
  });

  it('sorts by total descending', () => {
    const invs = [
      { eventType: 'A', grandTotal: 100 },
      { eventType: 'B', grandTotal: 500 },
      { eventType: 'C', grandTotal: 250 },
    ];
    const result = groupByEventType(invs);
    expect(result[0].name).toBe('B');
    expect(result[1].name).toBe('C');
    expect(result[2].name).toBe('A');
  });

  it('caps at 8 entries', () => {
    const invs = Array.from({ length: 12 }, (_, i) => ({ eventType: `E${i}`, grandTotal: i * 10 }));
    expect(groupByEventType(invs)).toHaveLength(8);
  });
});

describe('topCustomers', () => {
  it('returns empty for empty invoices', () => {
    expect(topCustomers([])).toEqual([]);
  });

  it('sums revenue per customer', () => {
    const invs = [
      { customerName: 'Smith', grandTotal: 400 },
      { customerName: 'Smith', grandTotal: 200 },
      { customerName: 'Jones', grandTotal: 700 },
    ];
    const result = topCustomers(invs);
    const smith = result.find(r => r.name === 'Smith');
    expect(smith.total).toBe(600);
    expect(result[0].name).toBe('Jones');
  });

  it('uses "Unknown" for missing customerName', () => {
    const invs = [{ grandTotal: 100 }];
    expect(topCustomers(invs)[0].name).toBe('Unknown');
  });
});

describe('filterByDateRange', () => {
  const invoices = [
    { date: '2025-01-10', total: 100 },
    { date: '2025-06-15', total: 200 },
    { date: '2025-12-20', total: 300 },
  ];

  it('returns all when no dates set', () => {
    expect(filterByDateRange(invoices, '', '')).toHaveLength(3);
  });

  it('filters by fromDate inclusive', () => {
    const result = filterByDateRange(invoices, '2025-06-01', '');
    expect(result).toHaveLength(2);
    expect(result.map(i => i.total)).toEqual([200, 300]);
  });

  it('filters by toDate inclusive', () => {
    const result = filterByDateRange(invoices, '', '2025-06-15');
    expect(result).toHaveLength(2);
    expect(result.map(i => i.total)).toEqual([100, 200]);
  });

  it('filters by both from and to', () => {
    const result = filterByDateRange(invoices, '2025-06-01', '2025-06-30');
    expect(result).toHaveLength(1);
    expect(result[0].total).toBe(200);
  });

  it('returns empty when range excludes all', () => {
    expect(filterByDateRange(invoices, '2026-01-01', '2026-12-31')).toHaveLength(0);
  });
});

describe('grossMargin', () => {
  it('returns correct margin percentage', () => {
    expect(grossMargin(1000, 600)).toBe(40.0);
  });

  it('returns negative margin when expenses exceed revenue', () => {
    expect(grossMargin(500, 700)).toBe(-40.0);
  });

  it('returns null when revenue is zero', () => {
    expect(grossMargin(0, 100)).toBeNull();
  });

  it('returns 100% when expenses are zero', () => {
    expect(grossMargin(1000, 0)).toBe(100.0);
  });

  it('rounds to one decimal place', () => {
    expect(grossMargin(300, 100)).toBe(66.7);
  });
});
