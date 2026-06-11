import React, { useEffect, useMemo, useState } from 'react';
import { LOCATIONS } from '../constants.js';
import { fmt$, fmtDate } from '../formatters.js';
import { load, save, uid, today } from '../utils/storage.js';
import { showToast } from '../toastContext.jsx';
import { logActivity } from '../utils/activity.js';

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

export default function Dashboard({ items = [], purchaseInvoices = [], cateringInvoices = [], payrollInvoices = [], setTab, shoppingList = [], setShoppingList, onOpenSettings }) {
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

    const payrollOutstanding = payrollInvoices
      .filter(i => (i.status || 'unpaid') !== 'paid')
      .reduce((s, i) => s + (i.total || 0), 0);

    return { totalItems, lowStock, inventoryValue, outstanding, payrollOutstanding };
  }, [items, cateringInvoices, payrollInvoices]);

  useEffect(() => {
    const todayStr = today();
    const snaps = load('_inventorySnapshots', []);
    if (!snaps.find(s => s.date === todayStr)) {
      const updated = [...snaps, { date: todayStr, value: stats.inventoryValue }].slice(-30);
      save('_inventorySnapshots', updated);
    }
  }, [stats.inventoryValue]);

  const snapshots = useMemo(() => {
    const snaps = load('_inventorySnapshots', []);
    return [...snaps].sort((a, b) => a.date.localeCompare(b.date)).slice(-7);
  }, []);

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

  // ── Today summary, backup nudge, overdue customers (added in the security+UX release) ──
  const todayStr = today();
  const todayStats = useMemo(() => {
    const cInvToday = cateringInvoices.filter(i => String(i.date || i.createdAt || '').slice(0,10) === todayStr);
    const pInvToday = purchaseInvoices.filter(i => String(i.date || i.createdAt || '').slice(0,10) === todayStr);
    const cRevToday = cInvToday.reduce((s, i) => s + (i.grandTotal || i.total || 0), 0);
    const paymentsToday = cateringInvoices.reduce((s, i) => {
      const ps = (i.payments || []).filter(p => String(p.date || '').slice(0,10) === todayStr);
      return s + ps.reduce((acc, p) => acc + (Number(p.amount) || 0), 0);
    }, 0);
    let checkInsToday = 0;
    try {
      const cache = load('_attendanceCache', []);
      checkInsToday = (Array.isArray(cache) ? cache : []).filter(e => String(e?.at || e?.checkInAt || '').slice(0,10) === todayStr).length;
    } catch {}
    return {
      invoicesToday: cInvToday.length + pInvToday.length,
      cateringBookedToday: cRevToday,
      paymentsToday,
      checkInsToday,
    };
  }, [cateringInvoices, purchaseInvoices, todayStr]);

  const lastBackupDays = useMemo(() => {
    const log = load('_activityLog', []);
    const last = [...log].reverse().find(e => e?.action === 'export_backup');
    if (!last?.timestamp) return null;
    const diff = Date.now() - new Date(last.timestamp).getTime();
    return Math.floor(diff / (1000 * 60 * 60 * 24));
  }, []);
  const needsBackupNudge = lastBackupDays === null || lastBackupDays > 7;

  const overdueCustomers = useMemo(() => {
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - THIRTY_DAYS;
    const byCust = {};
    cateringInvoices.forEach(inv => {
      if ((inv.status || 'unpaid') === 'paid') return;
      const dStr = inv.date || inv.createdAt || '';
      const d = new Date(dStr).getTime();
      if (!isFinite(d) || d > cutoff) return;
      const name = inv.customerName || inv.customer || 'Unknown';
      const email = inv.customerEmail || inv.email || '';
      const balance = (inv.balanceDue != null ? inv.balanceDue : (inv.grandTotal || inv.total || 0));
      if (!byCust[name]) byCust[name] = { name, email, count: 0, total: 0, oldestDays: 0 };
      byCust[name].count++;
      byCust[name].total += balance;
      byCust[name].oldestDays = Math.max(byCust[name].oldestDays, Math.floor((Date.now() - d) / (1000 * 60 * 60 * 24)));
    });
    return Object.values(byCust).sort((a, b) => b.oldestDays - a.oldestDays).slice(0, 5);
  }, [cateringInvoices]);

  function emailReminder(c) {
    if (!c?.email) return;
    const subject = encodeURIComponent('Friendly reminder — outstanding balance');
    const body = encodeURIComponent(
`Hi ${c.name},

We noticed an unpaid balance of ${fmt$(c.total)} from your recent catering order${c.count > 1 ? 's' : ''}. Could you let us know when we can expect payment?

Thanks!`
    );
    window.location.href = `mailto:${c.email}?subject=${subject}&body=${body}`;
    logActivity('customer_reminder_sent', `Reminder sent to ${c.name} (${fmt$(c.total)} overdue)`);
  }

  const topSuppliers = useMemo(() => {
    const m = {};
    purchaseInvoices.forEach(inv => {
      const s = inv.supplier || 'Unknown';
      if (!m[s]) m[s] = { name: s, count: 0, total: 0 };
      m[s].count++;
      m[s].total += inv.total || 0;
    });
    return Object.values(m).sort((a, b) => b.total - a.total).slice(0, 5).map(s => ({ ...s, total: +s.total.toFixed(2) }));
  }, [purchaseInvoices]);

  const inventoryByCategory = useMemo(() => {
    const m = {};
    items.forEach(item => {
      const cat = item.category || 'Other';
      const price = item.sellers?.[0]?.price || 0;
      const totalQty = LOCATIONS.reduce((s, loc) => {
        const qty = parseFloat(item.locQty?.[loc.toLowerCase()]);
        return s + (isNaN(qty) ? 0 : qty);
      }, 0);
      const val = totalQty * price;
      if (!m[cat]) m[cat] = { category: cat, value: 0, items: 0 };
      m[cat].value += val;
      m[cat].items++;
    });
    return Object.values(m).sort((a, b) => b.value - a.value).map(c => ({ ...c, value: +c.value.toFixed(2) }));
  }, [items]);

  const catalogWarnings = useMemo(() => {
    return items.flatMap(item => {
      const issues = [];
      const hasPrice = (item.sellers || []).some(s => s.price != null && s.price > 0);
      if (!hasPrice) issues.push('No price set');
      if (!item.category || item.category === 'Other') issues.push('Category is Other/unset');
      const hasStock = LOCATIONS.some(loc => {
        const lc = loc.toLowerCase();
        return item.locQty?.[lc] !== '' && item.locQty?.[lc] != null;
      }) || (item.currentQty !== '' && item.currentQty != null);
      if (!hasStock) issues.push('No stock data');
      return issues.length ? [{ id: item.id, name: item.name, issue: issues.join('; ') }] : [];
    }).slice(0, 20);
  }, [items]);

  const monthlyRevenue = useMemo(() => {
    const months = [];
    const now = new Date();
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const ym = d.toISOString().slice(0, 7);
      const label = d.toLocaleString('default', { month: 'short', year: '2-digit' });
      const matching = cateringInvoices.filter(inv => {
        const ds = inv.date || inv.createdAt || '';
        return ds.slice(0, 7) === ym;
      });
      const total = matching.reduce((s, inv) => s + (inv.grandTotal || inv.total || 0), 0);
      months.push({ ym, label, total, count: matching.length });
    }
    return months;
  }, [cateringInvoices]);

  const monthlySpending = useMemo(() => {
    const months = [];
    const now = new Date();
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const ym = d.toISOString().slice(0, 7);
      const label = d.toLocaleString('default', { month: 'short', year: '2-digit' });
      const matching = purchaseInvoices.filter(inv => {
        const ds = inv.date || inv.createdAt || '';
        return ds.slice(0, 7) === ym;
      });
      const total = matching.reduce((s, inv) => s + (inv.total || 0), 0);
      months.push({ ym, label, total, count: matching.length });
    }
    return months;
  }, [purchaseInvoices]);

  const upcomingDue = useMemo(() => {
    const t = today();
    const twoWeeksOut = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    return purchaseInvoices
      .filter(inv => inv.dueDate && inv.status !== 'paid' && inv.dueDate <= twoWeeksOut)
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
      .slice(0, 10)
      .map(inv => ({ ...inv, isOverdue: inv.dueDate < t }));
  }, [purchaseInvoices]);

  const upcomingEvents = useMemo(() => {
    const t = today();
    const thirtyDaysOut = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    return cateringInvoices
      .filter(inv => {
        const eventDate = inv.useRange ? inv.dateStart : inv.date;
        return eventDate && eventDate >= t && eventDate <= thirtyDaysOut;
      })
      .sort((a, b) => {
        const da = (a.useRange ? a.dateStart : a.date) || '';
        const db = (b.useRange ? b.dateStart : b.date) || '';
        return da.localeCompare(db);
      })
      .slice(0, 10);
  }, [cateringInvoices]);

  function exportLowStockCsv() {
    if (!lowStockRows.length) { showToast('No low-stock items.', 'error'); return; }
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = ['Item', 'Category', 'Location', 'Current Qty', 'Min Qty'];
    const rows = lowStockRows.map(({ item, loc, qty, minQ }) => [item.name, item.category || '', loc, qty, minQ]);
    const csv = [header.map(esc).join(','), ...rows.map(r => r.map(esc).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'low-stock-' + today() + '.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    showToast('Low-stock list exported.');
    logActivity('export_csv', `Exported ${lowStockRows.length} low-stock items`);
  }

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
    if (added > 0) logActivity('add_item', `Added ${added} low-stock items to shopping list from Dashboard`);
  }

  return (
    <div>
      <div className="section-title">Dashboard</div>

      {/* Today summary */}
      <div className="card mb-4" style={{ borderLeft: '4px solid #15803D' }}>
        <div style={{ fontWeight: 700, color: '#15803D', marginBottom: 10, fontSize: 14 }}>
          📅 Today — {fmtDate(todayStr)}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
          <div className="stat-card" style={{ background: '#F0FDF4' }}>
            <div className="stat-val" style={{ color: '#15803D' }}>{todayStats.invoicesToday}</div>
            <div className="stat-lbl">Invoices created</div>
          </div>
          <div className="stat-card" style={{ background: '#F0FDF4' }}>
            <div className="stat-val" style={{ color: '#15803D' }}>{fmt$(todayStats.cateringBookedToday)}</div>
            <div className="stat-lbl">Catering booked</div>
          </div>
          <div className="stat-card" style={{ background: '#F0FDF4' }}>
            <div className="stat-val" style={{ color: '#15803D' }}>{fmt$(todayStats.paymentsToday)}</div>
            <div className="stat-lbl">Payments received</div>
          </div>
          <div className="stat-card" style={{ background: '#F0FDF4' }}>
            <div className="stat-val" style={{ color: '#15803D' }}>{todayStats.checkInsToday}</div>
            <div className="stat-lbl">Check-in events</div>
          </div>
        </div>
      </div>

      {/* Backup nudge — only shown when overdue */}
      {needsBackupNudge && (
        <div className="card mb-4" style={{ background: '#FFF8DC', border: '1px solid #DEB887', borderLeft: '4px solid #B8860B' }}>
          <div style={{ fontWeight: 700, color: '#7a5c00', marginBottom: 6 }}>💾 Time for a backup</div>
          <div style={{ fontSize: 13.5, color: '#6b4b20', marginBottom: 10, lineHeight: 1.5 }}>
            {lastBackupDays === null
              ? 'You haven’t exported a backup yet. Click below to download one — keep it somewhere safe.'
              : `It’s been ${lastBackupDays} days since your last backup. A quick export keeps your data safe.`}
          </div>
          {onOpenSettings && (
            <button className="btn btn-primary btn-sm" onClick={onOpenSettings}>
              ⬇ Back up now
            </button>
          )}
        </div>
      )}

      {/* Overdue customers — only shown when any */}
      {overdueCustomers.length > 0 && (
        <div className="card mb-4" style={{ borderLeft: '4px solid #DC2626' }}>
          <div style={{ fontWeight: 700, color: '#991b1b', marginBottom: 6, fontSize: 15 }}>
            📬 Customers overdue 30+ days
          </div>
          <div style={{ fontSize: 12.5, color: '#7a5c20', marginBottom: 10 }}>
            {overdueCustomers.length} customer{overdueCustomers.length === 1 ? '' : 's'} with unpaid catering invoices over 30 days old.
          </div>
          {overdueCustomers.map(c => (
            <div key={c.name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: '1px solid #fee2e2' }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 600, color: 'var(--text)' }}>{c.name}</div>
                <div style={{ fontSize: 12, color: '#7f1d1d' }}>
                  {c.count} invoice{c.count === 1 ? '' : 's'} · {fmt$(c.total)} overdue · oldest {c.oldestDays} days
                </div>
              </div>
              {c.email ? (
                <button className="btn btn-outline btn-sm" onClick={() => emailReminder(c)}>
                  ✉ Email reminder
                </button>
              ) : (
                <span style={{ fontSize: 11.5, color: '#999' }}>no email on file</span>
              )}
            </div>
          ))}
          {setTab && (
            <button className="btn btn-outline btn-sm" style={{ marginTop: 10 }} onClick={() => setTab('customers')}>
              View all customers →
            </button>
          )}
        </div>
      )}

      {/* Quick Actions */}
      {setTab && (
        <div className="card mb-4">
          <div style={{fontWeight:700,color:'var(--brown)',marginBottom:10,fontSize:14}}>Quick Actions</div>
          <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
            <button className="btn btn-primary btn-sm" onClick={()=>setTab('catering')}>🍽 New Catering Invoice</button>
            <button className="btn btn-outline btn-sm" onClick={()=>setTab('purchase')}>📋 New Purchase Invoice</button>
            <button className="btn btn-outline btn-sm" onClick={()=>setTab('shopping')}>🛒 Shopping List</button>
            <button className="btn btn-outline btn-sm" onClick={()=>setTab('invadj')}>📝 Log Adjustment</button>
            <button className="btn btn-outline btn-sm" onClick={()=>setTab('items')}>📦 Item Database</button>
          </div>
        </div>
      )}

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
          {snapshots.length >= 2 && (() => {
            const max = Math.max(...snapshots.map(s => s.value), 1);
            return (
              <div style={{display:'flex',alignItems:'flex-end',gap:2,height:28,marginTop:6}}>
                {snapshots.map((s, i) => (
                  <div key={s.date} title={`${fmtDate(s.date)}: ${fmt$(s.value)}`}
                    style={{flex:1,background:i===snapshots.length-1?'var(--brown)':'#D2691E55',
                      height:Math.max(3, (s.value/max)*28)+'px',borderRadius:'2px 2px 0 0',minWidth:6}} />
                ))}
              </div>
            );
          })()}
          <div className="stat-lbl">Inventory Value</div>
        </div>
        <div className="stat-card" onClick={() => setTab && setTab('catering')} style={setTab ? {cursor:'pointer'} : {}} title={setTab ? 'Go to Catering Invoices' : undefined}>
          <div className="stat-val" style={stats.outstanding > 0 ? {color:'#DC2626'} : {}}>{fmt$(stats.outstanding)}</div>
          <div className="stat-lbl">Outstanding (Catering)</div>
        </div>
        {stats.payrollOutstanding > 0 && (
          <div className="stat-card" onClick={() => setTab && setTab('payroll')} style={setTab ? {cursor:'pointer'} : {}} title={setTab ? 'Go to Payroll' : undefined}>
            <div className="stat-val" style={{color:'#DC2626'}}>{fmt$(stats.payrollOutstanding)}</div>
            <div className="stat-lbl">Unpaid Payroll</div>
          </div>
        )}
      </div>

      {upcomingEvents.length > 0 && (
        <div className="card mb-4" style={{ borderLeft: '4px solid #15803D' }}>
          <div className="section-title" style={{ marginBottom: 12, color: '#15803D' }}>
            🍽️ Upcoming Catering Events — Next 30 Days
          </div>
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Event Date</th><th>Customer</th><th>Event Type</th><th>Total</th><th>Status</th></tr></thead>
              <tbody>
                {upcomingEvents.map(inv => (
                  <tr key={inv.id} style={{ background: '#F0FDF4' }}>
                    <td style={{ fontWeight: 600, color: '#15803D', whiteSpace: 'nowrap' }}>
                      {inv.useRange
                        ? `${fmtDate(inv.dateStart)} – ${fmtDate(inv.dateEnd)}`
                        : fmtDate(inv.date)}
                    </td>
                    <td style={{ fontWeight: 600 }}>{inv.customerName || '—'}</td>
                    <td style={{ fontSize: 13, color: '#555' }}>{inv.eventType || 'Catering'}</td>
                    <td style={{ fontWeight: 600 }}>{fmt$(inv.grandTotal || inv.total || 0)}</td>
                    <td><span className={`badge badge-${inv.status || 'unpaid'}`}>{inv.status || 'unpaid'}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {setTab && (
            <div style={{ textAlign: 'right', marginTop: 8 }}>
              <button className="btn btn-outline btn-sm" onClick={() => setTab('catering')}>View All Events →</button>
            </div>
          )}
        </div>
      )}

      {upcomingDue.length > 0 && (
        <div className="card mb-4" style={{borderLeft: `4px solid ${upcomingDue.some(i=>i.isOverdue)?'#DC2626':'#F59E0B'}`}}>
          <div className="section-title" style={{marginBottom:12,color:upcomingDue.some(i=>i.isOverdue)?'#DC2626':'#92400E'}}>
            {upcomingDue.some(i=>i.isOverdue) ? '🔴' : '🟡'} {upcomingDue.filter(i=>i.isOverdue).length > 0 ? `${upcomingDue.filter(i=>i.isOverdue).length} Overdue` : ''}{upcomingDue.filter(i=>i.isOverdue).length > 0 && upcomingDue.filter(i=>!i.isOverdue).length > 0 ? ' + ' : ''}{upcomingDue.filter(i=>!i.isOverdue).length > 0 ? `${upcomingDue.filter(i=>!i.isOverdue).length} Due Soon` : ''} — Purchase Invoices
          </div>
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Invoice #</th><th>Supplier</th><th>Due Date</th><th>Total</th><th>Status</th></tr></thead>
              <tbody>
                {upcomingDue.map(inv => (
                  <tr key={inv.id} style={{background: inv.isOverdue ? '#FEF2F2' : '#FFFBEB'}}>
                    <td style={{fontFamily:'monospace',fontWeight:700}}>{inv.id}</td>
                    <td>{inv.supplier}</td>
                    <td style={{fontWeight:600,color:inv.isOverdue?'#DC2626':'#92400E'}}>
                      {fmtDate(inv.dueDate)}{inv.isOverdue?' ⚠ Overdue':''}
                    </td>
                    <td style={{fontWeight:600}}>{fmt$(inv.total)}</td>
                    <td><span className={`badge badge-${inv.status}`}>{inv.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {setTab && <div style={{textAlign:'right',marginTop:8}}><button className="btn btn-outline btn-sm" onClick={()=>setTab('purchase')}>View All Invoices →</button></div>}
        </div>
      )}

      {/* Inventory Value by Category */}
      {inventoryByCategory.length > 0 && stats.inventoryValue > 0 && (
        <div className="card mb-4">
          <div className="section-title" style={{ marginBottom: 12 }}>&#128200; Inventory Value by Category</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {inventoryByCategory.map(c => (
              <div key={c.category} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
                <div style={{ width: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#555', flexShrink: 0 }}>{c.category}</div>
                <div style={{ flex: 1, background: '#F5ECD7', borderRadius: 4, overflow: 'hidden', height: 16 }}>
                  <div style={{
                    width: `${stats.inventoryValue > 0 ? (c.value / stats.inventoryValue * 100) : 0}%`,
                    background: 'var(--brown)', height: '100%', borderRadius: 4,
                  }} />
                </div>
                <div style={{ width: 68, fontWeight: 600, color: 'var(--brown)', textAlign: 'right', flexShrink: 0 }}>{fmt$(c.value)}</div>
                <div style={{ width: 40, color: '#888', textAlign: 'right', fontSize: 11, flexShrink: 0 }}>{c.items} item{c.items !== 1 ? 's' : ''}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Low Stock Items */}
      <div className="card mb-4">
        <div className="flex-between mb-2">
          <div className="section-title" style={{ margin: 0 }}>&#9888; Low Stock Items</div>
          {lowStockRows.length > 0 && (
            <div className="flex gap-2">
              <button className="btn btn-outline btn-sm" onClick={exportLowStockCsv}>⬇ Export CSV</button>
              <button className="btn btn-outline btn-sm" onClick={addLowStockToShoppingList}>➕ Add all to Shopping List</button>
            </div>
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

      {/* Monthly Spending (last 6 months) */}
      {purchaseInvoices.length > 0 && (
        <div className="card mb-4">
          <div className="section-title" style={{ marginBottom: 12 }}>&#128203; Purchase Spending — Last 6 Months</div>
          {(() => {
            const maxTotal = Math.max(...monthlySpending.map(m => m.total), 1);
            const thisMonthTotal = monthlySpending[monthlySpending.length - 1]?.total || 0;
            const prevMonthTotal = monthlySpending[monthlySpending.length - 2]?.total || 0;
            const trend = thisMonthTotal > prevMonthTotal ? '▲' : thisMonthTotal < prevMonthTotal ? '▼' : '—';
            const trendColor = thisMonthTotal > prevMonthTotal ? '#DC2626' : '#15803D';
            return (
              <>
                <div style={{ display: 'flex', gap: 16, marginBottom: 14, fontSize: 13 }}>
                  <div>This month: <strong style={{ color: 'var(--brown)' }}>{fmt$(thisMonthTotal)}</strong></div>
                  <div style={{ color: trendColor }}>{trend} vs last month ({fmt$(prevMonthTotal)})</div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {monthlySpending.map(m => (
                    <div key={m.ym} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
                      <div style={{ width: 52, color: '#888', textAlign: 'right', flexShrink: 0 }}>{m.label}</div>
                      <div style={{ flex: 1, background: '#F5ECD7', borderRadius: 4, overflow: 'hidden', height: 18 }}>
                        <div style={{
                          width: `${maxTotal > 0 ? (m.total / maxTotal * 100) : 0}%`,
                          background: 'var(--brown)', height: '100%', borderRadius: 4,
                          transition: 'width 0.3s',
                        }} />
                      </div>
                      <div style={{ width: 68, fontWeight: 600, color: 'var(--brown)', flexShrink: 0 }}>{fmt$(m.total)}</div>
                      <div style={{ width: 40, color: '#888', textAlign: 'right', flexShrink: 0, fontSize: 11 }}>{m.count} inv</div>
                    </div>
                  ))}
                </div>
              </>
            );
          })()}
        </div>
      )}

      {/* Catering Revenue (last 6 months) */}
      {cateringInvoices.length > 0 && (
        <div className="card mb-4">
          <div className="section-title" style={{ marginBottom: 12 }}>&#127860; Catering Revenue — Last 6 Months</div>
          {(() => {
            const maxTotal = Math.max(...monthlyRevenue.map(m => m.total), 1);
            const thisMonthTotal = monthlyRevenue[monthlyRevenue.length - 1]?.total || 0;
            const prevMonthTotal = monthlyRevenue[monthlyRevenue.length - 2]?.total || 0;
            const trend = thisMonthTotal > prevMonthTotal ? '▲' : thisMonthTotal < prevMonthTotal ? '▼' : '—';
            const trendColor = thisMonthTotal > prevMonthTotal ? '#15803D' : thisMonthTotal < prevMonthTotal ? '#DC2626' : '#888';
            return (
              <>
                <div style={{ display: 'flex', gap: 16, marginBottom: 14, fontSize: 13 }}>
                  <div>This month: <strong style={{ color: '#15803D' }}>{fmt$(thisMonthTotal)}</strong></div>
                  <div style={{ color: trendColor }}>{trend} vs last month ({fmt$(prevMonthTotal)})</div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {monthlyRevenue.map(m => (
                    <div key={m.ym} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
                      <div style={{ width: 52, color: '#888', textAlign: 'right', flexShrink: 0 }}>{m.label}</div>
                      <div style={{ flex: 1, background: '#F0FDF4', borderRadius: 4, overflow: 'hidden', height: 18 }}>
                        <div style={{
                          width: `${maxTotal > 0 ? (m.total / maxTotal * 100) : 0}%`,
                          background: '#15803D', height: '100%', borderRadius: 4,
                          transition: 'width 0.3s',
                        }} />
                      </div>
                      <div style={{ width: 68, fontWeight: 600, color: '#15803D', flexShrink: 0 }}>{fmt$(m.total)}</div>
                      <div style={{ width: 40, color: '#888', textAlign: 'right', flexShrink: 0, fontSize: 11 }}>{m.count} inv</div>
                    </div>
                  ))}
                </div>
              </>
            );
          })()}
        </div>
      )}

      {/* Top Suppliers */}
      {topSuppliers.length > 0 && (
        <div className="card mb-4">
          <div className="section-title" style={{ marginBottom: 12 }}>&#128232; Top Suppliers (All Time)</div>
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Supplier</th><th>Invoices</th><th>Total Spend</th></tr></thead>
              <tbody>
                {topSuppliers.map(s => (
                  <tr key={s.name}>
                    <td style={{ fontWeight: 600 }}>{s.name || '—'}</td>
                    <td style={{ color: '#888', fontSize: 13 }}>{s.count}</td>
                    <td style={{ fontWeight: 600, color: 'var(--brown)' }}>{fmt$(s.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Catalog health */}
      {/* Today's attendance from local cache */}
      {(() => {
        const todayStr = today();
        const cache = load('_attendanceCache', []);
        const todayRecords = cache.filter(e => e.timestamp && e.timestamp.startsWith(todayStr));
        if (!todayRecords.length) return null;
        // Build current-status map: last action per username
        const statusMap = {};
        [...todayRecords].reverse().forEach(e => {
          if (!statusMap[e.username]) statusMap[e.username] = e;
        });
        const currentlyIn = Object.values(statusMap).filter(e => e.action === 'in');
        const checkedOut  = Object.values(statusMap).filter(e => e.action === 'out');
        return (
          <div className="card mb-4" style={{ borderLeft: '4px solid #3B82F6' }}>
            <div className="section-title" style={{ marginBottom: 10, color: '#1D4ED8' }}>
              👷 Today's Attendance ({todayStr})
            </div>
            <div style={{ display: 'flex', gap: 20, marginBottom: 12 }}>
              <span style={{ fontWeight: 700, color: '#15803D' }}>{currentlyIn.length} currently in</span>
              <span style={{ fontWeight: 700, color: '#6B7280' }}>{checkedOut.length} checked out</span>
              <span style={{ fontWeight: 700, color: '#1D4ED8' }}>{todayRecords.length} total events</span>
            </div>
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>Employee</th><th>Status</th><th>Last Event</th><th>Business</th></tr></thead>
                <tbody>
                  {Object.values(statusMap).sort((a,b) => (b.timestamp||'').localeCompare(a.timestamp||'')).map((e,i) => (
                    <tr key={i}>
                      <td style={{ fontWeight: 600 }}>{e.displayName}{e.username !== e.displayName && <span style={{ fontSize: 11, color: '#888', marginLeft: 6 }}>@{e.username}</span>}</td>
                      <td>
                        <span style={{ padding: '2px 10px', borderRadius: 10, fontSize: 12, fontWeight: 600, background: e.action === 'in' ? '#DCFCE7' : '#F3F4F6', color: e.action === 'in' ? '#15803D' : '#6B7280' }}>
                          {e.action === 'in' ? '✅ In' : '⏹ Out'}
                        </span>
                      </td>
                      <td style={{ fontSize: 12, color: '#555' }}>{new Date(e.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
                      <td style={{ fontSize: 12, color: '#777' }}>{e.business || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}

      {catalogWarnings.length > 0 && (
        <div className="card mb-4">
          <div className="section-title" style={{ marginBottom: 12 }}>&#9888; Catalog Completeness</div>
          <div style={{ fontSize: 13, color: '#666', marginBottom: 8 }}>
            {catalogWarnings.length} item{catalogWarnings.length !== 1 ? 's' : ''} missing price or category data:
          </div>
          <div className="tbl-wrap" style={{ maxHeight: 200, overflowY: 'auto' }}>
            <table>
              <thead><tr><th>Item</th><th>Issue</th></tr></thead>
              <tbody>
                {catalogWarnings.map(w => (
                  <tr key={w.id}>
                    <td style={{ fontWeight: 600 }}>{w.name}</td>
                    <td style={{ color: '#DC2626', fontSize: 13 }}>{w.issue}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
