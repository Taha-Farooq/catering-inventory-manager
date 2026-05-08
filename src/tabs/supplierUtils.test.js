import { describe, it, expect } from 'vitest';

// --- Supplier stats computation (from SupplierManagement.jsx) ---
function buildSupplierStats(purchaseInvoices) {
  const m = {};
  purchaseInvoices.forEach(inv => {
    const name = (inv.supplier || '').toLowerCase();
    if (!name) return;
    if (!m[name]) m[name] = { spend: 0, orders: 0 };
    m[name].spend += inv.total || 0;
    m[name].orders += 1;
  });
  return m;
}

// --- Items per supplier (from SupplierManagement.jsx) ---
function buildItemsPerSupplier(items) {
  const m = {};
  items.forEach(item => {
    (item.sellers || []).forEach(sel => {
      const name = (sel.name || '').toLowerCase();
      if (!name) return;
      m[name] = (m[name] || 0) + 1;
    });
  });
  return m;
}

// --- All known (unregistered) supplier names (from SupplierManagement.jsx) ---
function findUnregisteredSuppliers(items, purchaseInvoices, suppliers) {
  const s = new Set();
  items.forEach(item => (item.sellers || []).forEach(sel => { if (sel.name?.trim()) s.add(sel.name.trim()); }));
  purchaseInvoices.forEach(inv => { if (inv.supplier?.trim()) s.add(inv.supplier.trim()); });
  const registered = new Set(suppliers.map(x => x.name.toLowerCase()));
  return [...s].filter(n => !registered.has(n.toLowerCase())).sort((a, b) => a.localeCompare(b));
}

// --- Upcoming catering events (from Dashboard.jsx) ---
function getUpcomingEvents(cateringInvoices, today, thirtyDaysLater) {
  return cateringInvoices
    .filter(inv => {
      const eventDate = inv.useRange ? inv.dateStart : inv.date;
      return eventDate && eventDate >= today && eventDate <= thirtyDaysLater;
    })
    .sort((a, b) => {
      const da = (a.useRange ? a.dateStart : a.date) || '';
      const db = (b.useRange ? b.dateStart : b.date) || '';
      return da.localeCompare(db);
    });
}

describe('buildSupplierStats', () => {
  it('returns empty object for no invoices', () => {
    expect(buildSupplierStats([])).toEqual({});
  });

  it('aggregates spend and orders for same supplier (case-insensitive key)', () => {
    const stats = buildSupplierStats([
      { supplier: 'Sysco', total: 200 },
      { supplier: 'sysco', total: 300 },
    ]);
    expect(stats['sysco'].spend).toBe(500);
    expect(stats['sysco'].orders).toBe(2);
  });

  it('tracks multiple suppliers independently', () => {
    const stats = buildSupplierStats([
      { supplier: 'Sysco', total: 100 },
      { supplier: 'US Foods', total: 150 },
      { supplier: 'Sysco', total: 50 },
    ]);
    expect(stats['sysco'].spend).toBe(150);
    expect(stats['us foods'].spend).toBe(150);
    expect(stats['us foods'].orders).toBe(1);
  });

  it('skips invoices with empty supplier', () => {
    const stats = buildSupplierStats([
      { supplier: '', total: 999 },
      { supplier: null, total: 999 },
    ]);
    expect(Object.keys(stats)).toHaveLength(0);
  });

  it('handles missing total as 0', () => {
    const stats = buildSupplierStats([{ supplier: 'A' }]);
    expect(stats['a'].spend).toBe(0);
    expect(stats['a'].orders).toBe(1);
  });
});

describe('buildItemsPerSupplier', () => {
  it('returns empty object for no items', () => {
    expect(buildItemsPerSupplier([])).toEqual({});
  });

  it('counts items supplied correctly per seller name', () => {
    const items = [
      { sellers: [{ name: 'Sysco' }, { name: 'US Foods' }] },
      { sellers: [{ name: 'Sysco' }] },
    ];
    const m = buildItemsPerSupplier(items);
    expect(m['sysco']).toBe(2);
    expect(m['us foods']).toBe(1);
  });

  it('skips sellers with no name', () => {
    const m = buildItemsPerSupplier([{ sellers: [{ name: '' }, { price: 5 }] }]);
    expect(Object.keys(m)).toHaveLength(0);
  });
});

describe('findUnregisteredSuppliers', () => {
  it('returns empty when all are registered', () => {
    const items = [{ sellers: [{ name: 'Sysco' }] }];
    const invoices = [{ supplier: 'Sysco' }];
    const suppliers = [{ name: 'Sysco' }];
    expect(findUnregisteredSuppliers(items, invoices, suppliers)).toEqual([]);
  });

  it('finds names in items not yet registered', () => {
    const items = [{ sellers: [{ name: 'Sysco' }, { name: 'US Foods' }] }];
    const suppliers = [{ name: 'Sysco' }];
    const result = findUnregisteredSuppliers(items, [], suppliers);
    expect(result).toEqual(['US Foods']);
  });

  it('finds names from invoices not yet registered', () => {
    const invoices = [{ supplier: 'New Vendor' }];
    const result = findUnregisteredSuppliers([], invoices, []);
    expect(result).toEqual(['New Vendor']);
  });

  it('is case-insensitive when checking registered suppliers', () => {
    const items = [{ sellers: [{ name: 'SYSCO' }] }];
    const suppliers = [{ name: 'sysco' }];
    expect(findUnregisteredSuppliers(items, [], suppliers)).toEqual([]);
  });

  it('deduplicates across items and invoices', () => {
    const items = [{ sellers: [{ name: 'Sysco' }] }];
    const invoices = [{ supplier: 'Sysco' }];
    const result = findUnregisteredSuppliers(items, invoices, []);
    expect(result).toEqual(['Sysco']);
  });

  it('returns results sorted alphabetically', () => {
    const items = [{ sellers: [{ name: 'Zeta' }, { name: 'Alpha' }, { name: 'Mango' }] }];
    const result = findUnregisteredSuppliers(items, [], []);
    expect(result).toEqual(['Alpha', 'Mango', 'Zeta']);
  });
});

describe('getUpcomingEvents', () => {
  const today = '2026-05-08';
  const thirtyDaysLater = '2026-06-07';

  it('returns empty for no invoices', () => {
    expect(getUpcomingEvents([], today, thirtyDaysLater)).toEqual([]);
  });

  it('includes invoices with future dates within window', () => {
    const invs = [{ id: '1', date: '2026-05-15', customerName: 'A' }];
    const result = getUpcomingEvents(invs, today, thirtyDaysLater);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('1');
  });

  it('excludes past events', () => {
    const invs = [{ id: '1', date: '2026-05-07', customerName: 'A' }];
    expect(getUpcomingEvents(invs, today, thirtyDaysLater)).toHaveLength(0);
  });

  it('excludes events beyond 30 days', () => {
    const invs = [{ id: '1', date: '2026-06-08', customerName: 'A' }];
    expect(getUpcomingEvents(invs, today, thirtyDaysLater)).toHaveLength(0);
  });

  it('includes today event (boundary)', () => {
    const invs = [{ id: '1', date: today, customerName: 'A' }];
    expect(getUpcomingEvents(invs, today, thirtyDaysLater)).toHaveLength(1);
  });

  it('uses dateStart for range events', () => {
    const invs = [{ id: '1', useRange: true, dateStart: '2026-05-20', dateEnd: '2026-05-22' }];
    const result = getUpcomingEvents(invs, today, thirtyDaysLater);
    expect(result).toHaveLength(1);
  });

  it('sorts events by date ascending', () => {
    const invs = [
      { id: '3', date: '2026-06-01' },
      { id: '1', date: '2026-05-10' },
      { id: '2', date: '2026-05-20' },
    ];
    const result = getUpcomingEvents(invs, today, thirtyDaysLater);
    expect(result.map(r => r.id)).toEqual(['1', '2', '3']);
  });
});
