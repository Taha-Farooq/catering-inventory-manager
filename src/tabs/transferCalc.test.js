import { describe, it, expect } from 'vitest';

const COMMISSION_RATE = 0.15;

// Replicates transfer invoice calculation from TransferInvoices.jsx
function calcTransferInvoice(lineItems) {
  const lines = lineItems
    .map(l => {
      const qty = parseFloat(l.quantity) || 0;
      const unitPrice = parseFloat(l.price) || 0;
      const price = +(qty * unitPrice).toFixed(2);
      const commission = +(price * COMMISSION_RATE).toFixed(2);
      const total = +(price + commission).toFixed(2);
      return { ...l, qty, unitPrice, price, commission, total };
    })
    .filter(l => l.qty > 0 && l.unitPrice > 0);

  const subTotal = +lines.reduce((s, l) => s + l.price, 0).toFixed(2);
  const commissionTotal = +lines.reduce((s, l) => s + l.commission, 0).toFixed(2);
  const grandTotal = +(subTotal + commissionTotal).toFixed(2);
  return { lines, subTotal, commissionTotal, grandTotal };
}

describe('calcTransferInvoice', () => {
  it('computes subtotal, 15% commission, and grand total', () => {
    const result = calcTransferInvoice([{ quantity: '10', price: '5', item: 'Chicken' }]);
    expect(result.subTotal).toBe(50);
    expect(result.commissionTotal).toBe(7.5);
    expect(result.grandTotal).toBe(57.5);
  });

  it('rounds commission to 2 decimal places', () => {
    const result = calcTransferInvoice([{ quantity: '1', price: '3.33', item: 'Item' }]);
    expect(result.lines[0].commission).toBe(0.5); // 3.33 * 0.15 = 0.4995 → 0.5
    expect(result.lines[0].total).toBe(3.83);
  });

  it('returns zero for empty line items', () => {
    const result = calcTransferInvoice([]);
    expect(result.subTotal).toBe(0);
    expect(result.commissionTotal).toBe(0);
    expect(result.grandTotal).toBe(0);
  });

  it('filters out lines with zero quantity or price', () => {
    const result = calcTransferInvoice([
      { quantity: '0', price: '10', item: 'A' },
      { quantity: '5', price: '0', item: 'B' },
      { quantity: '2', price: '20', item: 'C' },
    ]);
    expect(result.lines).toHaveLength(1);
    expect(result.subTotal).toBe(40);
  });

  it('sums multiple lines correctly', () => {
    const result = calcTransferInvoice([
      { quantity: '5', price: '10', item: 'A' },
      { quantity: '3', price: '20', item: 'B' },
    ]);
    // Line A: 50, commission 7.5, total 57.5
    // Line B: 60, commission 9, total 69
    // subTotal: 110, commissionTotal: 16.5, grandTotal: 126.5
    expect(result.subTotal).toBe(110);
    expect(result.commissionTotal).toBe(16.5);
    expect(result.grandTotal).toBe(126.5);
  });

  it('grand total = subtotal + commissionTotal', () => {
    const result = calcTransferInvoice([{ quantity: '7', price: '13', item: 'Lamb' }]);
    expect(result.grandTotal).toBe(+(result.subTotal + result.commissionTotal).toFixed(2));
  });

  it('handles fractional quantities', () => {
    const result = calcTransferInvoice([{ quantity: '2.5', price: '8', item: 'Beef' }]);
    expect(result.subTotal).toBe(20);
    expect(result.commissionTotal).toBe(3);
  });
});
