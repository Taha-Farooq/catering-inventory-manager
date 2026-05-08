import { describe, it, expect } from 'vitest';

// Replicates totalPaidFor from CateringInvoices.jsx
function totalPaidFor(inv) {
  const legacy = parseFloat(inv.deposit) || 0;
  const pmts = (inv.payments || []).reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
  return +(legacy + pmts).toFixed(2);
}

// Replicates balanceFor from CateringInvoices.jsx
function balanceFor(inv) {
  return +Math.max(0, (inv.grandTotal || 0) - totalPaidFor(inv)).toFixed(2);
}

describe('totalPaidFor', () => {
  it('returns 0 for invoice with no deposit and no payments', () => {
    expect(totalPaidFor({ grandTotal: 500 })).toBe(0);
  });

  it('returns legacy deposit when no payments array', () => {
    expect(totalPaidFor({ deposit: 200, grandTotal: 500 })).toBe(200);
  });

  it('sums payments array, ignoring legacy deposit when deposit is absent', () => {
    const inv = {
      grandTotal: 500,
      payments: [
        { id: '1', amount: 100, date: '2026-01-01', note: '' },
        { id: '2', amount: 150, date: '2026-01-15', note: '' },
      ],
    };
    expect(totalPaidFor(inv)).toBe(250);
  });

  it('adds legacy deposit to payments array', () => {
    const inv = {
      deposit: 100,
      grandTotal: 500,
      payments: [
        { id: '1', amount: 200, date: '2026-01-01', note: '' },
      ],
    };
    expect(totalPaidFor(inv)).toBe(300);
  });

  it('handles string amounts in payments array', () => {
    const inv = {
      grandTotal: 500,
      payments: [{ id: '1', amount: '75.50', date: '2026-01-01' }],
    };
    expect(totalPaidFor(inv)).toBe(75.50);
  });

  it('handles null amounts in payments gracefully', () => {
    const inv = {
      grandTotal: 500,
      payments: [{ id: '1', amount: null, date: '2026-01-01' }],
    };
    expect(totalPaidFor(inv)).toBe(0);
  });

  it('handles empty payments array', () => {
    expect(totalPaidFor({ grandTotal: 500, payments: [] })).toBe(0);
  });

  it('rounds to 2 decimal places', () => {
    const inv = {
      grandTotal: 500,
      payments: [
        { id: '1', amount: 33.333 },
        { id: '2', amount: 33.333 },
        { id: '3', amount: 33.334 },
      ],
    };
    expect(totalPaidFor(inv)).toBe(100);
  });
});

describe('balanceFor', () => {
  it('returns full grandTotal when nothing paid', () => {
    expect(balanceFor({ grandTotal: 500 })).toBe(500);
  });

  it('returns correct balance after partial payment', () => {
    const inv = { grandTotal: 500, payments: [{ amount: 200 }] };
    expect(balanceFor(inv)).toBe(300);
  });

  it('returns 0 when fully paid', () => {
    const inv = { grandTotal: 500, payments: [{ amount: 500 }] };
    expect(balanceFor(inv)).toBe(0);
  });

  it('clamps to 0 when overpaid (no negative balances)', () => {
    const inv = { grandTotal: 100, payments: [{ amount: 150 }] };
    expect(balanceFor(inv)).toBe(0);
  });

  it('returns 0 for invoice with no grandTotal', () => {
    expect(balanceFor({})).toBe(0);
  });

  it('combines legacy deposit and new payments', () => {
    const inv = { grandTotal: 600, deposit: 100, payments: [{ amount: 200 }] };
    expect(balanceFor(inv)).toBe(300);
  });
});
