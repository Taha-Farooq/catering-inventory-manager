import React, { useState, useMemo, useEffect } from 'react';
import * as XLSX from 'xlsx';
import { showToast } from '../toastContext.jsx';
import Confirm from '../ui/Confirm.jsx';

function load(key, def) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : def; } catch { return def; }
}
function Btn({ className = '', children, ...p }) {
  return <button className={`btn ${className}`} {...p}>{children}</button>;
}

const ACTION_LABELS = {
  login: 'Logged In', logout: 'Logged Out', view_tab: 'Viewed Page',
  tab_change: 'Viewed Page', update_prices: 'Updated Prices', add_item: 'Added Item',
  edit_item: 'Edited Item', delete_item: 'Deleted Item', create_invoice: 'Created Invoice',
  delete_invoice: 'Deleted Invoice', mark_paid: 'Marked Paid', add_customer: 'Added Customer',
  edit_customer: 'Edited Customer', delete_customer: 'Deleted Customer',
  profile_update: 'Updated Profile', restore_backup: 'Restored Backup',
  export_backup: 'Exported Backup', export_csv: 'Exported CSV',
  export_xlsx: 'Exported Excel', admin_password_reset: 'Admin Password Reset',
  import_items: 'Bulk Item Import',
  quick_stock_adjust: 'Quick Stock Adjust',
  transfer_stock: 'Stock Transfer',
  adjustment_saved: 'Stock Adjustment Saved',
  adjustment_deleted: 'Adjustment Deleted',
  update_stock_from_invoice: 'Updated Stock from Invoice',
  add_custom_category: 'Added Custom Category',
  remove_custom_category: 'Removed Custom Category',
  bulk_mark_paid: 'Bulk Marked Paid',
};
const fmtAction = a => ACTION_LABELS[a] || (a ? a.charAt(0).toUpperCase() + a.slice(1) : '');

export default function ActivityLog({ save }) {
  const [log, setLog] = useState(() => load('_activityLog', []));
  const [userF, setUserF] = useState('all');
  const [actionF, setActionF] = useState('all');
  const [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [showClearLogConfirm, setShowClearLogConfirm] = useState(false);
  const [page, setPage] = useState(1);
  const pageSize = 50;

  function refresh() { setLog(load('_activityLog', [])); showToast('Log refreshed'); }

  function confirmClearLog() {
    setShowClearLogConfirm(false);
    save('_activityLog', []);
    setLog([]);
    showToast('Activity log cleared');
  }

  function exportCsv() {
    if (!filtered.length) { showToast('No entries to export.', 'error'); return; }
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = filtered.map(e => [
      e.timestamp ? new Date(e.timestamp).toLocaleString() : '',
      e.username || '',
      fmtAction(e.action),
      e.details || '',
    ]);
    const csv = [['Timestamp','User','Action','Details'].map(esc).join(','), ...rows.map(r => r.map(esc).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'activity-log-' + new Date().toISOString().slice(0,10) + '.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    showToast('Activity log exported.');
  }

  function exportExcel() {
    if (!filtered.length) { showToast('No entries to export.', 'error'); return; }
    const header = ['Timestamp', 'User', 'Action', 'Details'];
    const rows = filtered.map(e => [
      e.timestamp ? new Date(e.timestamp).toLocaleString() : '',
      e.username || '',
      fmtAction(e.action),
      e.details || '',
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header, ...rows]), 'Activity Log');
    XLSX.writeFile(wb, 'activity-log-' + new Date().toISOString().slice(0, 10) + '.xlsx');
    showToast('Activity log exported as Excel.');
  }

  useEffect(() => { setPage(1); }, [userF, actionF, search, dateFrom, dateTo]);

  const users = useMemo(() => [...new Set(log.map(e => e.username))].filter(Boolean).sort(), [log]);
  const actions = useMemo(() => [...new Set(log.map(e => e.action))].filter(Boolean).sort(), [log]);

  const filtered = useMemo(() => {
    let r = [...log].reverse();
    if (userF !== 'all') r = r.filter(e => e.username === userF);
    if (actionF !== 'all') r = r.filter(e => e.action === actionF);
    if (search.trim()) { const q = search.toLowerCase(); r = r.filter(e => (e.details||'').toLowerCase().includes(q) || (e.username||'').toLowerCase().includes(q)); }
    if (dateFrom) r = r.filter(e => e.timestamp && e.timestamp.slice(0, 10) >= dateFrom);
    if (dateTo)   r = r.filter(e => e.timestamp && e.timestamp.slice(0, 10) <= dateTo);
    return r;
  }, [log, userF, actionF, search, dateFrom, dateTo]);

  const paginated = useMemo(() => filtered.slice((page-1)*pageSize, page*pageSize), [filtered, page]);

  return (
    <div>
      <div className="flex-between mb-3 flex-wrap gap-2">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="section-title" style={{ margin: 0 }}>🔍 Activity Log</span>
          <span className="badge badge-user">{log.length} entries</span>
        </div>
        <div className="flex gap-2">
          <Btn className="btn-outline btn-sm" onClick={refresh}>↻ Refresh</Btn>
          <Btn className="btn-outline btn-sm" onClick={exportCsv}>⬇ CSV</Btn>
          <Btn className="btn-outline btn-sm" onClick={exportExcel}>⬇ Excel</Btn>
          <Btn className="btn-danger btn-sm" onClick={() => setShowClearLogConfirm(true)}>🗑 Clear Log</Btn>
        </div>
      </div>
      <p style={{ fontSize: 13, color: '#666', marginBottom: 14 }}>All user actions are automatically recorded here. Use filters to find specific activity.</p>

      <div className="card mb-3" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(145px,1fr))', gap: 12 }}>
        <div className="field" style={{ margin: 0 }}>
          <label>User</label>
          <select className="input" value={userF} onChange={e => setUserF(e.target.value)}>
            <option value="all">All Users</option>
            {users.map(u => <option key={u} value={u}>{u}</option>)}
          </select>
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label>Action Type</label>
          <select className="input" value={actionF} onChange={e => setActionF(e.target.value)}>
            <option value="all">All Actions</option>
            {actions.map(a => <option key={a} value={a}>{fmtAction(a)}</option>)}
          </select>
        </div>
        <div className="field" style={{ margin: 0 }}><label>Search Details</label><input className="input" placeholder="Keyword…" value={search} onChange={e => setSearch(e.target.value)} /></div>
        <div className="field" style={{ margin: 0 }}><label>From Date</label><input className="input" type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} /></div>
        <div className="field" style={{ margin: 0 }}><label>To Date</label><input className="input" type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} /></div>
      </div>

      <div style={{ fontSize: 13, color: '#666', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span>Showing <strong>{filtered.length}</strong> of {log.length} entries</span>
        {(userF !== 'all' || actionF !== 'all' || search || dateFrom || dateTo) && (
          <Btn className="btn-sm" style={{ background: '#eee', color: '#666' }} onClick={() => { setUserF('all'); setActionF('all'); setSearch(''); setDateFrom(''); setDateTo(''); }}>✕ Clear Filters</Btn>
        )}
      </div>

      {log.length === 0 && <div className="card empty-state">No activity logged yet. Actions are recorded automatically as users interact with the app.</div>}
      {log.length > 0 && filtered.length === 0 && <div className="card empty-state">No entries match the current filters.</div>}
      {filtered.length > 0 && (
        <div className="card" style={{ padding: 0 }}>
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Time</th><th>User</th><th>Action</th><th>Details</th></tr></thead>
              <tbody>
                {paginated.map((e, i) => (
                  <tr key={e.id || i}>
                    <td style={{ fontFamily: 'monospace', fontSize: 12, whiteSpace: 'nowrap' }}>{e.timestamp ? new Date(e.timestamp).toLocaleString() : ''}</td>
                    <td><span className={`badge badge-${e.username === 'admin' ? 'admin' : 'user'}`}>{e.username}</span></td>
                    <td style={{ fontWeight: 600, fontSize: 13 }}>{fmtAction(e.action)}</td>
                    <td style={{ fontSize: 13, color: '#666' }}>{e.details}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {(() => { const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize)); return totalPages > 1 ? (
        <div style={{display:'flex',alignItems:'center',justifyContent:'center',gap:8,marginTop:12,fontSize:13}}>
          <Btn className="btn-outline btn-sm" disabled={page<=1} onClick={()=>setPage(p=>Math.max(1,p-1))}>← Prev</Btn>
          <span style={{color:'#666'}}>Page <strong>{Math.min(page,totalPages)}</strong> of <strong>{totalPages}</strong></span>
          <Btn className="btn-outline btn-sm" disabled={page>=totalPages} onClick={()=>setPage(p=>Math.min(totalPages,p+1))}>Next →</Btn>
        </div>
      ) : null; })()}

      <Confirm
        open={showClearLogConfirm}
        title="Clear activity log?"
        message="Remove all recorded actions from this device's activity log."
        detail="This cannot be undone. Invoices and other business data are not deleted — only the audit trail here."
        dangerCode="DMG-E012 (local data change)"
        confirmLabel="Clear log"
        confirmClass="btn-danger"
        onConfirm={confirmClearLog}
        onCancel={() => setShowClearLogConfirm(false)}
      />
    </div>
  );
}
