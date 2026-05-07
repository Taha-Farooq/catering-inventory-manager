import React, { useState, useMemo } from 'react';
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
};
const fmtAction = a => ACTION_LABELS[a] || (a ? a.charAt(0).toUpperCase() + a.slice(1) : '');

export default function ActivityLog({ save }) {
  const [log, setLog] = useState(() => load('_activityLog', []));
  const [userF, setUserF] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [showClearLogConfirm, setShowClearLogConfirm] = useState(false);

  function refresh() { setLog(load('_activityLog', [])); showToast('Log refreshed'); }

  function confirmClearLog() {
    setShowClearLogConfirm(false);
    save('_activityLog', []);
    setLog([]);
    showToast('Activity log cleared');
  }

  const users = useMemo(() => [...new Set(log.map(e => e.username))], [log]);

  const filtered = useMemo(() => {
    let r = [...log].reverse();
    if (userF !== 'all') r = r.filter(e => e.username === userF);
    if (dateFrom) r = r.filter(e => e.timestamp && e.timestamp.slice(0, 10) >= dateFrom);
    if (dateTo)   r = r.filter(e => e.timestamp && e.timestamp.slice(0, 10) <= dateTo);
    return r;
  }, [log, userF, dateFrom, dateTo]);

  return (
    <div>
      <div className="flex-between mb-3 flex-wrap gap-2">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="section-title" style={{ margin: 0 }}>🔍 Activity Log</span>
          <span className="badge badge-user">{log.length} entries</span>
        </div>
        <div className="flex gap-2">
          <Btn className="btn-outline btn-sm" onClick={refresh}>↻ Refresh</Btn>
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
        <div className="field" style={{ margin: 0 }}><label>From Date</label><input className="input" type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} /></div>
        <div className="field" style={{ margin: 0 }}><label>To Date</label><input className="input" type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} /></div>
      </div>

      <div style={{ fontSize: 13, color: '#666', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span>Showing <strong>{filtered.length}</strong> of {log.length} entries</span>
        {(userF !== 'all' || dateFrom || dateTo) && (
          <Btn className="btn-sm" style={{ background: '#eee', color: '#666' }} onClick={() => { setUserF('all'); setDateFrom(''); setDateTo(''); }}>✕ Clear Filters</Btn>
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
                {filtered.map((e, i) => (
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
