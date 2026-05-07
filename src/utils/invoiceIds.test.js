import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../errors.js', () => ({ reportError: vi.fn() }));
vi.mock('../storageHealth.js', () => ({ notifySaveFailure: vi.fn() }));
vi.mock('../toastContext.jsx', () => ({ showToast: vi.fn() }));

function createMemoryLocalStorage() {
  const store = Object.create(null);
  return {
    getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); },
    removeItem(k) { delete store[k]; },
    clear() { for (const k of Object.keys(store)) delete store[k]; },
    get length() { return Object.keys(store).length; },
    key(i) { return Object.keys(store)[i] ?? null; },
  };
}

describe('invoiceIds', () => {
  let nextId, nextTransferId, normalizeTransferInvoice;

  beforeEach(async () => {
    globalThis.localStorage = createMemoryLocalStorage();
    vi.resetModules();
    vi.mock('../errors.js', () => ({ reportError: vi.fn() }));
    vi.mock('../storageHealth.js', () => ({ notifySaveFailure: vi.fn() }));
    vi.mock('../toastContext.jsx', () => ({ showToast: vi.fn() }));
    const mod = await import('./invoiceIds.js');
    nextId = mod.nextId;
    nextTransferId = mod.nextTransferId;
    normalizeTransferInvoice = mod.normalizeTransferInvoice;
  });

  describe('nextId', () => {
    it('generates sequential purchase IDs with P- prefix', () => {
      expect(nextId('purchase')).toBe('P-0001');
      expect(nextId('purchase')).toBe('P-0002');
    });

    it('generates sequential catering IDs with C- prefix', () => {
      expect(nextId('catering')).toBe('C-0001');
      expect(nextId('catering')).toBe('C-0002');
    });

    it('pads numbers to 4 digits', () => {
      for (let i = 0; i < 9; i++) nextId('purchase');
      expect(nextId('purchase')).toBe('P-0010');
    });

    it('persists sequence counter to localStorage', () => {
      nextId('purchase');
      const stored = JSON.parse(globalThis.localStorage.getItem('_seq'));
      expect(stored.purchase).toBe(1);
    });
  });

  describe('nextTransferId', () => {
    it('generates ID with PPH-ENG-{date}-{seq} format', () => {
      const id = nextTransferId('2026-05-07');
      expect(id).toBe('PPH-ENG-20260507-0001');
    });

    it('increments sequence across calls', () => {
      expect(nextTransferId('2026-01-01')).toBe('PPH-ENG-20260101-0001');
      expect(nextTransferId('2026-01-01')).toBe('PPH-ENG-20260101-0002');
    });

    it('uses today when dateStr omitted', () => {
      const id = nextTransferId();
      const todayStr = new Date().toISOString().split('T')[0].replace(/-/g, '');
      expect(id).toContain(todayStr);
    });
  });

  describe('normalizeTransferInvoice', () => {
    it('fills default from/to fields', () => {
      const result = normalizeTransferInvoice({});
      expect(result.from).toBe('Parathas & Platters - Hackensack');
      expect(result.to).toBe('Parathas & Platters - Englewood');
    });

    it('preserves provided from/to', () => {
      const result = normalizeTransferInvoice({ from: 'A', to: 'B' });
      expect(result.from).toBe('A');
      expect(result.to).toBe('B');
    });

    it('computes commission and totals from line items', () => {
      const result = normalizeTransferInvoice({
        lineItems: [{ quantity: 2, item: 'Rice', price: 100 }],
      });
      const line = result.lineItems[0];
      expect(line.commission).toBe(15);
      expect(line.total).toBe(115);
      expect(result.subTotal).toBe(100);
      expect(result.commissionTotal).toBe(15);
      expect(result.grandTotal).toBe(115);
    });

    it('preserves explicit commission on line items', () => {
      const result = normalizeTransferInvoice({
        lineItems: [{ quantity: 1, item: 'X', price: 100, commission: 20, total: 120 }],
      });
      expect(result.lineItems[0].commission).toBe(20);
      expect(result.lineItems[0].total).toBe(120);
    });

    it('sets default status to unpaid', () => {
      expect(normalizeTransferInvoice({}).status).toBe('unpaid');
    });

    it('generates an ID if none provided', () => {
      const result = normalizeTransferInvoice({ date: '2026-05-01' });
      expect(result.id).toMatch(/^PPH-ENG-20260501-/);
    });

    it('preserves existing id', () => {
      const result = normalizeTransferInvoice({ id: 'EXISTING-001' });
      expect(result.id).toBe('EXISTING-001');
    });

    it('handles empty lineItems', () => {
      const result = normalizeTransferInvoice({ lineItems: [] });
      expect(result.lineItems).toEqual([]);
      expect(result.grandTotal).toBe(0);
    });

    it('normalizes legacy unitPrice field', () => {
      const result = normalizeTransferInvoice({
        lineItems: [{ quantity: 1, item: 'Y', unitPrice: 50 }],
      });
      expect(result.lineItems[0].price).toBe(50);
    });
  });
});
