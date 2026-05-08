import { describe, it, expect } from 'vitest';

// Replicates calcPeriodEnd from PayrollInvoices.jsx
function calcPeriodEnd(start, periodType) {
  const d = new Date(start + 'T12:00:00');
  if (periodType === 'weekly') d.setDate(d.getDate() + 6);
  else if (periodType === 'biweekly') d.setDate(d.getDate() + 13);
  else { d.setMonth(d.getMonth() + 1); d.setDate(0); }
  return d.toISOString().slice(0, 10);
}

// Replicates calcPayroll from PayrollInvoices.jsx as a pure function
function calcPayroll({ hourlyRate, regularHours, overtimeHours }) {
  const rate = parseFloat(hourlyRate) || 0;
  const reg = Math.max(0, parseFloat(regularHours) || 0);
  const ot = Math.max(0, parseFloat(overtimeHours) || 0);
  const total = reg * rate + ot * rate * 1.5;
  return { rate, reg, ot, total };
}

// Per-employee summary computation (replicates employeeSummary useMemo)
function buildEmployeeSummary(payrollRecords) {
  const m = {};
  payrollRecords.forEach(r => {
    const name = r.employeeName || 'Unknown';
    if (!m[name]) m[name] = { name, totalPay: 0, totalRegHours: 0, totalOtHours: 0, count: 0, unpaidTotal: 0 };
    m[name].totalPay += r.total || 0;
    m[name].totalRegHours += parseFloat(r.regularHours) || 0;
    m[name].totalOtHours += parseFloat(r.overtimeHours) || 0;
    m[name].count++;
    if ((r.status || 'unpaid') !== 'paid') m[name].unpaidTotal += r.total || 0;
  });
  return Object.values(m).sort((a, b) => b.totalPay - a.totalPay);
}

describe('calcPayroll', () => {
  it('computes basic regular pay', () => {
    const { total, reg, rate } = calcPayroll({ hourlyRate: '20', regularHours: '40', overtimeHours: '0' });
    expect(rate).toBe(20);
    expect(reg).toBe(40);
    expect(total).toBe(800);
  });

  it('computes overtime at 1.5x rate', () => {
    const { total } = calcPayroll({ hourlyRate: '20', regularHours: '40', overtimeHours: '5' });
    // 40 * 20 + 5 * 20 * 1.5 = 800 + 150 = 950
    expect(total).toBe(950);
  });

  it('returns zero total when rate is zero', () => {
    const { total } = calcPayroll({ hourlyRate: '0', regularHours: '40', overtimeHours: '10' });
    expect(total).toBe(0);
  });

  it('returns zero total when all fields are empty strings', () => {
    const { total, rate, reg, ot } = calcPayroll({ hourlyRate: '', regularHours: '', overtimeHours: '' });
    expect(total).toBe(0);
    expect(rate).toBe(0);
    expect(reg).toBe(0);
    expect(ot).toBe(0);
  });

  it('treats negative overtime hours as zero', () => {
    const { ot, total } = calcPayroll({ hourlyRate: '15', regularHours: '40', overtimeHours: '-5' });
    expect(ot).toBe(0);
    expect(total).toBe(15 * 40);
  });

  it('handles fractional hours', () => {
    const { total } = calcPayroll({ hourlyRate: '10', regularHours: '7.5', overtimeHours: '0' });
    expect(total).toBe(75);
  });

  it('handles string numeric rate', () => {
    const { rate } = calcPayroll({ hourlyRate: '18.50', regularHours: '0', overtimeHours: '0' });
    expect(rate).toBe(18.5);
  });
});

describe('buildEmployeeSummary', () => {
  it('returns empty array for empty records', () => {
    expect(buildEmployeeSummary([])).toEqual([]);
  });

  it('groups multiple records for same employee', () => {
    const records = [
      { employeeName: 'Alice', total: 500, regularHours: '40', overtimeHours: '0', status: 'paid' },
      { employeeName: 'Alice', total: 600, regularHours: '40', overtimeHours: '5', status: 'unpaid' },
    ];
    const result = buildEmployeeSummary(records);
    expect(result).toHaveLength(1);
    const alice = result[0];
    expect(alice.name).toBe('Alice');
    expect(alice.totalPay).toBe(1100);
    expect(alice.count).toBe(2);
    expect(alice.totalRegHours).toBe(80);
    expect(alice.totalOtHours).toBe(5);
    expect(alice.unpaidTotal).toBe(600);
  });

  it('sorts by totalPay descending', () => {
    const records = [
      { employeeName: 'Bob', total: 300, regularHours: '20', overtimeHours: '0', status: 'paid' },
      { employeeName: 'Alice', total: 800, regularHours: '40', overtimeHours: '0', status: 'paid' },
    ];
    const result = buildEmployeeSummary(records);
    expect(result[0].name).toBe('Alice');
    expect(result[1].name).toBe('Bob');
  });

  it('treats missing status as unpaid', () => {
    const records = [{ employeeName: 'Carol', total: 400, regularHours: '30', overtimeHours: '0' }];
    const result = buildEmployeeSummary(records);
    expect(result[0].unpaidTotal).toBe(400);
  });

  it('uses "Unknown" for missing employeeName', () => {
    const records = [{ total: 200, regularHours: '10', overtimeHours: '0', status: 'paid' }];
    const result = buildEmployeeSummary(records);
    expect(result[0].name).toBe('Unknown');
  });
});

describe('calcPeriodEnd', () => {
  it('weekly period: end is 6 days after start', () => {
    expect(calcPeriodEnd('2026-01-01', 'weekly')).toBe('2026-01-07');
  });

  it('biweekly period: end is 13 days after start', () => {
    expect(calcPeriodEnd('2026-01-01', 'biweekly')).toBe('2026-01-14');
  });

  it('monthly period: end is last day of start month', () => {
    expect(calcPeriodEnd('2026-01-15', 'monthly')).toBe('2026-01-31');
    expect(calcPeriodEnd('2026-02-01', 'monthly')).toBe('2026-02-28');
  });

  it('monthly period: leap year February', () => {
    expect(calcPeriodEnd('2024-02-01', 'monthly')).toBe('2024-02-29');
  });

  it('weekly period crossing month boundary', () => {
    expect(calcPeriodEnd('2026-01-29', 'weekly')).toBe('2026-02-04');
  });
});
