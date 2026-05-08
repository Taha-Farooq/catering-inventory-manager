import { describe, it, expect } from 'vitest';

// Replicates monthlyNetProfit computation from Analytics.jsx
function buildMonthlyNetProfit(cateringInvoices, purchaseInvoices, dailyFinanceEntries) {
  const m = {};
  cateringInvoices.forEach(inv => {
    const d = inv.date || inv.dateStart || inv.createdAt;
    if (!d) return;
    const k = d.slice(0, 7);
    if (!m[k]) m[k] = { rev: 0, spend: 0 };
    m[k].rev += inv.grandTotal || 0;
  });
  purchaseInvoices.forEach(inv => {
    const d = inv.date || inv.createdAt;
    if (!d) return;
    const k = d.slice(0, 7);
    if (!m[k]) m[k] = { rev: 0, spend: 0 };
    m[k].spend += inv.total || 0;
  });
  dailyFinanceEntries.forEach(e => {
    const d = e.date;
    if (!d) return;
    const k = d.slice(0, 7);
    if (!m[k]) m[k] = { rev: 0, spend: 0 };
    m[k].rev += e.income || 0;
    m[k].spend += e.expense || 0;
  });
  return Object.entries(m)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-12)
    .map(([k, v]) => {
      const net = +(v.rev - v.spend).toFixed(2);
      return { label: k.slice(5) + '/' + k.slice(2, 4), net, positive: net >= 0 };
    });
}

// Replicates applyPreset date math from Analytics.jsx
function applyPreset(preset, nowDate) {
  const now = nowDate || new Date();
  const fmtD = d => d.toISOString().slice(0, 10);
  if (preset === '7d') { const f = new Date(now); f.setDate(f.getDate() - 6); return { from: fmtD(f), to: fmtD(now) }; }
  if (preset === '30d') { const f = new Date(now); f.setDate(f.getDate() - 29); return { from: fmtD(f), to: fmtD(now) }; }
  if (preset === 'month') { return { from: fmtD(new Date(now.getFullYear(), now.getMonth(), 1)), to: fmtD(new Date(now.getFullYear(), now.getMonth() + 1, 0)) }; }
  if (preset === 'lastmonth') { return { from: fmtD(new Date(now.getFullYear(), now.getMonth() - 1, 1)), to: fmtD(new Date(now.getFullYear(), now.getMonth(), 0)) }; }
  if (preset === 'year') { return { from: `${now.getFullYear()}-01-01`, to: fmtD(now) }; }
  return { from: '', to: '' };
}

describe('buildMonthlyNetProfit', () => {
  it('returns empty for all-empty inputs', () => {
    expect(buildMonthlyNetProfit([], [], [])).toEqual([]);
  });

  it('computes net profit from catering revenue minus purchase spend', () => {
    const catering = [{ date: '2026-01-15', grandTotal: 1000 }];
    const purchases = [{ date: '2026-01-20', total: 400 }];
    const result = buildMonthlyNetProfit(catering, purchases, []);
    expect(result).toHaveLength(1);
    expect(result[0].net).toBe(600);
    expect(result[0].positive).toBe(true);
    expect(result[0].label).toBe('01/26');
  });

  it('marks negative months correctly', () => {
    const purchases = [{ date: '2026-02-10', total: 800 }];
    const catering = [{ date: '2026-02-05', grandTotal: 300 }];
    const result = buildMonthlyNetProfit(catering, purchases, []);
    expect(result[0].net).toBe(-500);
    expect(result[0].positive).toBe(false);
  });

  it('combines catering + daily income, purchase + daily expense', () => {
    const catering = [{ date: '2026-03-01', grandTotal: 500 }];
    const purchases = [{ date: '2026-03-15', total: 200 }];
    const daily = [{ date: '2026-03-10', income: 100, expense: 50 }];
    const result = buildMonthlyNetProfit(catering, purchases, daily);
    expect(result[0].net).toBe(350); // 500+100 - 200+50 = 350
  });

  it('groups multiple records in same month', () => {
    const catering = [
      { date: '2026-04-01', grandTotal: 300 },
      { date: '2026-04-15', grandTotal: 200 },
    ];
    const result = buildMonthlyNetProfit(catering, [], []);
    expect(result).toHaveLength(1);
    expect(result[0].net).toBe(500);
  });

  it('caps at 12 months', () => {
    const catering = Array.from({ length: 15 }, (_, i) => ({
      date: `20${25 - Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-01`,
      grandTotal: 100,
    }));
    const result = buildMonthlyNetProfit(catering, [], []);
    expect(result.length).toBeLessThanOrEqual(12);
  });

  it('skips records with no date', () => {
    const catering = [{ grandTotal: 999 }]; // no date field
    const result = buildMonthlyNetProfit(catering, [], []);
    expect(result).toHaveLength(0);
  });
});

describe('applyPreset', () => {
  const now = new Date('2026-05-08T12:00:00');

  it('7d: from is 6 days ago, to is today', () => {
    const { from, to } = applyPreset('7d', now);
    expect(from).toBe('2026-05-02');
    expect(to).toBe('2026-05-08');
  });

  it('30d: from is 29 days ago, to is today', () => {
    const { from, to } = applyPreset('30d', now);
    expect(from).toBe('2026-04-09');
    expect(to).toBe('2026-05-08');
  });

  it('month: current month from first to last day', () => {
    const { from, to } = applyPreset('month', now);
    expect(from).toBe('2026-05-01');
    expect(to).toBe('2026-05-31');
  });

  it('lastmonth: previous month full range', () => {
    const { from, to } = applyPreset('lastmonth', now);
    expect(from).toBe('2026-04-01');
    expect(to).toBe('2026-04-30');
  });

  it('year: from Jan 1 to today', () => {
    const { from, to } = applyPreset('year', now);
    expect(from).toBe('2026-01-01');
    expect(to).toBe('2026-05-08');
  });

  it('unknown preset: returns empty strings', () => {
    const { from, to } = applyPreset('', now);
    expect(from).toBe('');
    expect(to).toBe('');
  });
});
