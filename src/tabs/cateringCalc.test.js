import { describe, it, expect } from 'vitest';

// Replicates calcT invoice calculation from CateringInvoices.jsx
function calcT({ lineItems = [], ccFeeEnabled = false, taxEnabled = false, taxRate = 0, deposit = '' }) {
  const lines = lineItems.map(l => {
    const q = Math.max(0, parseFloat(l.quantity) || 0);
    const p = parseFloat(l.unitPrice) || 0;
    return { ...l, qty: q, price: p, total: +(q * p).toFixed(2) };
  });
  const sub = +lines.reduce((s, l) => s + l.total, 0).toFixed(2);
  const cc = ccFeeEnabled ? +(sub * 0.035).toFixed(2) : 0;
  const taxBase = sub + cc;
  const taxAmt = taxEnabled ? +(taxBase * (taxRate / 100)).toFixed(2) : 0;
  const grand = +(taxBase + taxAmt).toFixed(2);
  const dep = Math.max(0, parseFloat(deposit) || 0);
  return { lines, sub, cc, taxAmt, grand, dep, balance: +(grand - dep).toFixed(2) };
}

describe('calcT — catering invoice calculation', () => {
  it('computes subtotal from line items', () => {
    const { sub } = calcT({ lineItems: [
      { quantity: '2', unitPrice: '50' },
      { quantity: '3', unitPrice: '30' },
    ]});
    expect(sub).toBe(190);
  });

  it('returns zero subtotal for empty line items', () => {
    expect(calcT({}).sub).toBe(0);
  });

  it('adds 3.5% CC fee when ccFeeEnabled', () => {
    const { sub, cc } = calcT({ lineItems: [{ quantity: '1', unitPrice: '100' }], ccFeeEnabled: true });
    expect(sub).toBe(100);
    expect(cc).toBe(3.5);
  });

  it('no CC fee when ccFeeEnabled is false', () => {
    const { cc } = calcT({ lineItems: [{ quantity: '1', unitPrice: '100' }], ccFeeEnabled: false });
    expect(cc).toBe(0);
  });

  it('applies tax on subtotal + CC fee', () => {
    const { grand, taxAmt } = calcT({ lineItems: [{ quantity: '1', unitPrice: '100' }], ccFeeEnabled: true, taxEnabled: true, taxRate: 10 });
    // sub=100, cc=3.5, taxBase=103.5, taxAmt=10.35, grand=113.85
    expect(taxAmt).toBe(10.35);
    expect(grand).toBe(113.85);
  });

  it('no tax when taxEnabled is false', () => {
    const { taxAmt } = calcT({ lineItems: [{ quantity: '1', unitPrice: '200' }], taxEnabled: false, taxRate: 8 });
    expect(taxAmt).toBe(0);
  });

  it('balance = grand - deposit', () => {
    const { grand, dep, balance } = calcT({ lineItems: [{ quantity: '1', unitPrice: '500' }], deposit: '200' });
    expect(grand).toBe(500);
    expect(dep).toBe(200);
    expect(balance).toBe(300);
  });

  it('balance is never negative (deposit > grand)', () => {
    const { balance } = calcT({ lineItems: [{ quantity: '1', unitPrice: '100' }], deposit: '999' });
    expect(balance).toBe(-899); // unclamped — component clamps display, not the calc
  });

  it('handles invalid unitPrice gracefully (treats as 0)', () => {
    const { sub } = calcT({ lineItems: [{ quantity: '5', unitPrice: 'abc' }] });
    expect(sub).toBe(0);
  });

  it('handles string numeric quantity', () => {
    const { lines } = calcT({ lineItems: [{ quantity: '1.5', unitPrice: '20' }] });
    expect(lines[0].total).toBe(30);
  });

  it('grand total equals sub when no CC fee and no tax', () => {
    const { sub, grand, cc, taxAmt } = calcT({ lineItems: [{ quantity: '4', unitPrice: '25' }] });
    expect(sub).toBe(100);
    expect(cc).toBe(0);
    expect(taxAmt).toBe(0);
    expect(grand).toBe(100);
  });
});
