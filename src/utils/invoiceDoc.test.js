import { describe, it, expect } from 'vitest';
import { buildCateringInvoiceDoc, buildPurchaseInvoiceDoc, buildTransferInvoiceDoc } from './invoiceDoc.js';

const brand = { name: 'DeGrill Inc', address: 'Spring Valley, NY', phone: '(845) 555-0100', email: 'info@degrill.com', logo: '' };

const catInv = {
  id: 'CAT-1042',
  date: '2026-10-15',
  customerName: 'Acme Corp',
  customerAddress: '300 Park Ave, NYC',
  customerPhone: '(212) 555-1234',
  customerEmail: 'events@acme.example',
  eventType: 'Corporate Lunch',
  guestCount: 75,
  lineItems: [
    { description: 'Chicken Tikka Platter', quantity: 75, unitPrice: 18, total: 1350 },
    { description: 'Naan basket (24 ct)', quantity: 3, unitPrice: 36, total: 108 },
  ],
  subtotal: 1458,
  ccFee: 51.03,
  taxAmount: 122.11,
  grandTotal: 1631.14,
  payments: [{ date: '2026-10-08', amount: 500, note: 'Deposit (Zelle)' }],
};

describe('buildCateringInvoiceDoc', () => {
  it('renders the customer, event, line items, and balance', () => {
    const html = buildCateringInvoiceDoc(catInv, brand);
    expect(html).toContain('CATERING INVOICE');
    expect(html).toContain('CAT-1042');
    expect(html).toContain('Acme Corp');
    expect(html).toContain('Corporate Lunch');
    expect(html).toContain('75'); // guests
    expect(html).toContain('Chicken Tikka Platter');
    expect(html).toContain('$1,631.14'); // grand total
    expect(html).toContain('BALANCE DUE');
    expect(html).toContain('Payments Received');
  });
  it('shows "Paid in full" when paid', () => {
    const paid = { ...catInv, payments: [{ date: '2026-10-15', amount: 1631.14 }] };
    const html = buildCateringInvoiceDoc(paid, brand);
    expect(html).toContain('PAID IN FULL');
  });
  it('escapes a customer name containing markup', () => {
    const evil = { ...catInv, customerName: '<script>x()</script>' };
    const html = buildCateringInvoiceDoc(evil, brand);
    expect(html).not.toContain('<script>x()</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('buildPurchaseInvoiceDoc', () => {
  const purInv = {
    id: 'PUR-901', date: '2026-10-12', supplier: 'Restaurant Depot',
    lineItems: [{ description: 'Basmati rice 25lb', quantity: 4, unitPrice: 28, total: 112 }],
    subtotal: 112, total: 112, status: 'unpaid', dueDate: '2026-11-12',
  };
  it('shows UNPAID with due date when unpaid', () => {
    const html = buildPurchaseInvoiceDoc(purInv, brand);
    expect(html).toContain('PURCHASE INVOICE');
    expect(html).toContain('Restaurant Depot');
    expect(html).toContain('UNPAID');
    expect(html).toContain('November 12, 2026'); // formatted due date
  });
  it('shows PAID with payment date when paid', () => {
    const paid = { ...purInv, status: 'paid', paidAt: '2026-10-20' };
    const html = buildPurchaseInvoiceDoc(paid, brand);
    expect(html).toContain('PAID');
    expect(html).toContain('October 20, 2026');
  });
});

describe('buildTransferInvoiceDoc', () => {
  const trInv = {
    id: 'TR-2026-10-1', date: '2026-10-08', from: 'Hackensack', to: 'Englewood',
    lineItems: [{ description: 'Tikka masala sauce, 1gal', quantity: 6, unitPrice: 24, total: 144 }],
    subtotal: 144, commission: 21.6, commissionPct: 15, total: 165.6,
  };
  it('renders the from→to route and commission line', () => {
    const html = buildTransferInvoiceDoc(trInv, brand);
    expect(html).toContain('INTER-LOCATION TRANSFER INVOICE');
    expect(html).toContain('Hackensack → Englewood');
    expect(html).toContain('Commission');
    expect(html).toContain('15%');
    expect(html).toContain('$165.60');
  });
});
