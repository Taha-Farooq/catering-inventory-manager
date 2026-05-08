import { describe, it, expect } from 'vitest';

// Replicates parseNum from DailyIncomeExpense.jsx
function parseNum(v) {
  if (v === '' || v == null) return 0;
  const n = parseFloat(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? +n.toFixed(2) : 0;
}

// Replicates totals reduce from DailyIncomeExpense.jsx
function calcTotals(entries) {
  return entries.reduce((acc, r) => {
    acc.income += +(r.income || 0);
    acc.expense += +(r.expense || 0);
    acc.salesTaxCollected += +(r.salesTaxCollected || 0);
    acc.taxPaid += +(r.taxPaid || 0);
    return acc;
  }, { income: 0, expense: 0, salesTaxCollected: 0, taxPaid: 0 });
}

// Replicates net / estimatedIncomeTax / salesTaxDue from DailyIncomeExpense.jsx
function calcSummary(entries, incomeTaxRate = 22) {
  const totals = calcTotals(entries);
  const net = +(totals.income - totals.expense).toFixed(2);
  const estimatedIncomeTax = +(Math.max(net, 0) * (incomeTaxRate / 100)).toFixed(2);
  const salesTaxDue = +(totals.salesTaxCollected - totals.taxPaid).toFixed(2);
  return { ...totals, net, estimatedIncomeTax, salesTaxDue };
}

// Replicates monthly grouping from DailyIncomeExpense.jsx
function buildMonthlyData(entries) {
  const m = {};
  entries.forEach(r => {
    const d = (r.date || '').slice(0, 7);
    if (!d) return;
    if (!m[d]) m[d] = { month: d, income: 0, expense: 0, tax: 0 };
    m[d].income += +(r.income || 0);
    m[d].expense += +(r.expense || 0);
    m[d].tax += +((r.salesTaxCollected || 0) - (r.taxPaid || 0));
  });
  return Object.values(m).sort((a, b) => a.month.localeCompare(b.month)).slice(-18).map(x => ({
    ...x,
    net: +(x.income - x.expense).toFixed(2),
    label: `${x.month.slice(5)}/${x.month.slice(2, 4)}`
  }));
}

describe('parseNum', () => {
  it('parses plain numbers', () => {
    expect(parseNum('123.45')).toBe(123.45);
    expect(parseNum(100)).toBe(100);
  });

  it('returns 0 for empty string or null', () => {
    expect(parseNum('')).toBe(0);
    expect(parseNum(null)).toBe(0);
  });

  it('strips non-numeric characters (e.g. $ sign)', () => {
    expect(parseNum('$1,234.56')).toBe(1234.56);
  });

  it('rounds to 2 decimal places', () => {
    expect(parseNum('9.9999')).toBe(10);
    expect(parseNum('1.234')).toBe(1.23);
  });

  it('returns 0 for non-numeric string', () => {
    expect(parseNum('abc')).toBe(0);
  });

  it('handles zero', () => {
    expect(parseNum('0')).toBe(0);
    expect(parseNum(0)).toBe(0);
  });
});

describe('calcTotals', () => {
  it('returns zeros for empty entries', () => {
    const t = calcTotals([]);
    expect(t.income).toBe(0);
    expect(t.expense).toBe(0);
    expect(t.salesTaxCollected).toBe(0);
    expect(t.taxPaid).toBe(0);
  });

  it('sums income and expense across entries', () => {
    const entries = [
      { income: 1000, expense: 400, salesTaxCollected: 80, taxPaid: 0 },
      { income: 500,  expense: 200, salesTaxCollected: 40, taxPaid: 30 },
    ];
    const t = calcTotals(entries);
    expect(t.income).toBe(1500);
    expect(t.expense).toBe(600);
    expect(t.salesTaxCollected).toBe(120);
    expect(t.taxPaid).toBe(30);
  });

  it('treats missing fields as 0', () => {
    const t = calcTotals([{ income: 200 }]);
    expect(t.expense).toBe(0);
    expect(t.salesTaxCollected).toBe(0);
    expect(t.taxPaid).toBe(0);
  });
});

describe('calcSummary', () => {
  it('net = income - expense', () => {
    const s = calcSummary([{ income: 1000, expense: 400 }]);
    expect(s.net).toBe(600);
  });

  it('estimated income tax applies to positive net at given rate', () => {
    const s = calcSummary([{ income: 1000, expense: 0 }], 22);
    expect(s.estimatedIncomeTax).toBe(220);
  });

  it('estimated income tax is 0 when net is negative', () => {
    const s = calcSummary([{ income: 100, expense: 500 }], 22);
    expect(s.net).toBe(-400);
    expect(s.estimatedIncomeTax).toBe(0);
  });

  it('salesTaxDue = collected - paid', () => {
    const s = calcSummary([{ income: 500, expense: 0, salesTaxCollected: 80, taxPaid: 30 }]);
    expect(s.salesTaxDue).toBe(50);
  });

  it('salesTaxDue can be negative (over-remitted)', () => {
    const s = calcSummary([{ salesTaxCollected: 10, taxPaid: 50 }]);
    expect(s.salesTaxDue).toBe(-40);
  });

  it('uses default 22% income tax rate when not specified', () => {
    const s = calcSummary([{ income: 1000, expense: 0 }]);
    expect(s.estimatedIncomeTax).toBe(220);
  });

  it('respects custom income tax rate', () => {
    const s = calcSummary([{ income: 1000, expense: 0 }], 30);
    expect(s.estimatedIncomeTax).toBe(300);
  });
});

describe('buildMonthlyData', () => {
  it('returns empty array for empty entries', () => {
    expect(buildMonthlyData([])).toEqual([]);
  });

  it('groups entries by month', () => {
    const entries = [
      { date: '2026-01-10', income: 300, expense: 100, salesTaxCollected: 0, taxPaid: 0 },
      { date: '2026-01-20', income: 200, expense: 50,  salesTaxCollected: 0, taxPaid: 0 },
      { date: '2026-02-05', income: 500, expense: 200, salesTaxCollected: 0, taxPaid: 0 },
    ];
    const result = buildMonthlyData(entries);
    expect(result).toHaveLength(2);
    const jan = result.find(r => r.month === '2026-01');
    expect(jan.income).toBe(500);
    expect(jan.expense).toBe(150);
    expect(jan.net).toBe(350);
  });

  it('ignores entries with no date', () => {
    const entries = [
      { date: '', income: 999, expense: 0 },
      { date: '2026-03-01', income: 100, expense: 0 },
    ];
    const result = buildMonthlyData(entries);
    expect(result).toHaveLength(1);
    expect(result[0].income).toBe(100);
  });

  it('sorts months chronologically', () => {
    const entries = [
      { date: '2026-03-01', income: 100, expense: 0 },
      { date: '2026-01-01', income: 200, expense: 0 },
      { date: '2026-02-01', income: 150, expense: 0 },
    ];
    const result = buildMonthlyData(entries);
    expect(result[0].month).toBe('2026-01');
    expect(result[1].month).toBe('2026-02');
    expect(result[2].month).toBe('2026-03');
  });

  it('produces correct label format (MM/YY)', () => {
    const entries = [{ date: '2026-05-01', income: 100, expense: 0 }];
    const result = buildMonthlyData(entries);
    expect(result[0].label).toBe('05/26');
  });

  it('includes tax net in each month entry', () => {
    const entries = [{ date: '2026-04-01', income: 0, expense: 0, salesTaxCollected: 100, taxPaid: 40 }];
    const result = buildMonthlyData(entries);
    expect(result[0].tax).toBe(60);
  });
});
