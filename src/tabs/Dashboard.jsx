import React, { useMemo } from 'react';
import { LOCATIONS } from '../constants.js';
import { fmt$, fmtDate } from '../formatters.js';
import { load, save, uid } from '../utils/storage.js';
import { showToast } from '../toastContext.jsx';

const ACTION_LABELS = {
  login: 'Logged In', logout: 'Logged Out', view_tab: 'Viewed Page',
  tab_change: 'Viewed Page', add_item: 'Added Item', edit_item: 'Edited Item',
  delete_item: 'Deleted Item', import_items: 'Bulk Import', export_items_csv: 'Exported CSV',
  quick_stock_adjust: 'Quick Stock Adjust', transfer_stock: 'Stock Transfer',
  adjustment_saved: 'Adjustment Saved', update_stock_from_invoice: 'Stock from Invoice',
  create_invoice: 'Created Invoice', mark_paid: 'Marked Paid', export_csv: 'Exported CSV',
  export_xlsx: 'Exported Excel',
};

function isItemLowStock(item) {
  const cur = parseFloat(item.currentQty);
  const min = parseFloat(item.minQty);
  if (!isNaN(cur) && !isNaN(min) && cur <= min) return true;
  return LOCATIONS.some(loc => {
    const lc = loc.toLowerCase();
    const q = parseFloat(item.locQty?.[lc]);
    const m = parseFloat(item.locMinQty?.[lc]);
    return !isNaN(q) && !isNaN(m) && q <= m;
  });
}

export default function Dashboard({ items = [], purchaseInvoices = [], cateringInvoices = [], setTab, shoppingList = [], setShoppingList }) {
  const stats = useMemo(() => {
    const totalItems = items.length;

    const lowStock = items.filter(isItemLowStock).length;

    const inventoryValue = items.reduce((sum, item) => {
      const price = item.sellers?.[0]?.price || 0;
      const locSum = LOCATIONS.reduce((ls, loc) => {
        const lc = loc.toLowerCase();
        const qty = item.locQty?.[lc];
        if (qty === '' || qty == null) return ls;
        return ls + (parseFloat(qty) || 0) * price;
      }, 0);
      return sum + locSum;
    }, 0);

    const outstanding = cateringInvoices
      .filter(i => i.status !== 'paid')
      .reduce((s, i) => s + (i.balanceDue || 0), 0);

    return { totalItems, lowStock, inventoryValue, outstanding };
  }, [items, cateringInvoices]);

  const lowStockRows = useMemo(() => {
    const rows = [];
    items.forEach(item => {
      LOCATIONS.forEach(loc => {
        const lc = loc.toLowerCase();
        const qty = item.locQty?.[lc];
        const minQ = item.locMinQty?.[lc];
        if (qty !== '' && qty != null && minQ !== '' && minQ != null) {
          if (parseFloat(qty) <= parseFloat(minQ)) {
            rows.push({ item, loc, qty, minQ });
          }
        }
      });
      // Legacy fallback: only add if no per-location data produced rows
      const hasLocData = LOCATIONS.some(loc => {
        const lc = loc.toLowerCase();
        return item.locQty?.[lc] !== '' && item.locQty?.[lc] != null;
      });
      if (!hasLocData) {
        const cur = parseFloat(item.currentQty);
        const min = parseFloat(item.minQty);
        if (!isNaN(cur) && !isNaN(min) && cur <= min) {
          rows.push({ item, loc: 'Overall', qty: item.currentQty, minQ: item.minQty });
        }
      }
    });
    return rows;
  }, [items]);

  const activityLog = useMemo(() => {
    const log = load('_activityLog', []);
    return [...log].reverse().slice(0, 10);
  }, []);

  const purchasesThisMonth = useMemo(() => {
    const now = new Date();
    const ym = now.toISOString().slice(0, 7);
    const matching = purchaseInvoices.filter(inv => {
      const d = inv.date || inv.createdAt || '';
      return d.slice(0, 7) === ym;
    });
    const total = matching.reduce((s, inv) => s + (inv.total || 0), 0);
    return { count: matching.length, total };
  }, [purchaseInvoices]);

  function addLowStockToShoppingList() {
    const lowItems = items.filter(item => {
      return LOCATIONS.some(loc => {
        const lc = loc.toLowerCase();
        const q = parseFloat(item.locQty?.[lc]);
        const m = parseFloat(item.locMinQty?.[lc]);
        return !isNaN(q) && !isNaN(m) && q <= m;
      }) || (() => {
        const cur = parseFloat(item.currentQty);
        const min = parseFloat(item.minQty);
        return !isNaN(cur) && !isNaN(min) && cur <= min;
      })();
    });
    if (!lowItems.length) { showToast('No low-stock items found.'); return; }
    let added = 0, skipped = 0;
    let nextList = [...shoppingList];
    lowItems.forEach(item => {
      const sellerList = Array.isArray(item.sellers) ? item.sellers : [];
      const sel = sellerList[0] || { name: '', price: null };
      const dup = nextList.find(s => s.itemId === item.id && s.selectedSeller === sel.name);
      if (dup) { skipped++; return; }
      nextList = [...nextList, {
        id: uid(), itemId: item.id, itemName: item.name, unit: item.unit, upc: item.upc || '',
        selectedSeller: sel.name, price: sel.price, quantity: 1, sellers: sellerList
      }];
      added++;
    });
    setShoppingList(nextList);
    save('shoppingList', nextList);
    showToast(`Added ${added} item${added !== 1 ? 's' : ''} to shopping list${skipped ? ` (${skipped} already there)` : ''}.`);
  }

  return (
    <div>
      <div className="section-title">Dashboard</div>

      {/* Stat cards */}
      <div className="stat-grid">
        <div
          className="stat-card"
          onClick={() => setTab && setTab('items')}
          style={setTab ? { cursor: 'pointer' } : {}}
          title={setTab ? 'Go to Items' : undefined}
        >
          <div className="stat-val">{stats.totalItems}</div>
          <div className="stat-lbl">Total Items</div>
        </div>
        <div className="stat-card">
          <div className="stat-val" style={stats.lowStock > 0 ? { color: '#DC2626' } : {}}>
            {stats.lowStock}
          </div>
          <div className="stat-lbl">Low Stock</div>
        </div>
        <div className="stat-card">
          <div className="stat-val">{fmt$(stats.inventoryValue)}</div>
          <div className="stat-lbl">Inventory Value</div>
        </div>
        <div className="stat-card">
          <div className="stat-val">{fmt$(stats.outstanding)}</div>
          <div className="stat-lbl">Outstanding (Catering)</div>
        </div>
      </div>

      {/* Low Stock Items */}
      <div className="card mb-4">
        <div className="flex-between mb-2">
          <div className="section-title" style={{ margin: 0 }}>&#9888; Low Stock Items</div>
          {lowStockRows.length > 0 && (
            <button className="btn btn-outline btn-sm" onClick={addLowStockToShoppingList}>
              ➕ Add all to Shopping List
            </button>
          )}
        </div>
        {lowStockRows.length === 0 ? (
          <div className="empty-state">All items are above reorder points.</div>
        ) : (
          <div className="tbl-wrap" style={{ maxHeight: 300, overflowY: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Category</th>
                  <th>Location</th>
                  <th>Qty</th>
                  <th>Min</th>
                </tr>
              </thead>
              <tbody>
                {lowStockRows.map(({ item, loc, qty, minQ }, idx) => (
                  <tr key={item.id + '-' + loc + '-' + idx} style={{ background: '#FFF5F5' }}>
                    <td style={{ fontWeight: 600 }}>{item.name}</td>
                    <td>
                      <span style={{ fontSize: 11.5, background: '#FFF0D4', color: 'var(--brown)', padding: '2px 7px', borderRadius: 10 }}>
                        {item.category}
                      </span>
                    </td>
                    <td style={{ fontSize: 13 }}>{loc}</td>
                    <td style={{ color: '#DC2626', fontWeight: 700 }}>{qty}</td>
                    <td style={{ color: '#888' }}>{minQ}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Recent Activity */}
      <div className="card mb-4">
        <div className="section-title" style={{ marginBottom: 12 }}>&#128269; Recent Activity</div>
        {activityLog.length === 0 ? (
          <div className="empty-state">No activity yet.</div>
        ) : (
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>User</th>
                  <th>Action</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {activityLog.map((entry, idx) => (
                  <tr key={idx}>
                    <td style={{ fontSize: 12, color: '#888', whiteSpace: 'nowrap' }}>
                      {entry.timestamp ? new Date(entry.timestamp).toLocaleString() : '—'}
                    </td>
                    <td style={{ fontSize: 13 }}>{entry.user || '—'}</td>
                    <td style={{ fontSize: 13 }}>
                      {ACTION_LABELS[entry.action] || (entry.action ? entry.action.charAt(0).toUpperCase() + entry.action.slice(1) : '—')}
                    </td>
                    <td style={{ fontSize: 12, color: '#555' }}>{entry.details || entry.label || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Purchases This Month */}
      <div className="card mb-4">
        <div className="section-title" style={{ marginBottom: 12 }}>&#128203; Purchases This Month</div>
        <div style={{ fontSize: 14, color: '#555' }}>
          {purchasesThisMonth.count} invoice{purchasesThisMonth.count !== 1 ? 's' : ''}, total{' '}
          <strong>{fmt$(purchasesThisMonth.total)}</strong>
        </div>
      </div>
    </div>
  );
}
