import React, { useState, useMemo, useId } from 'react';
import * as XLSX from 'xlsx';
import { showToast } from '../toastContext.jsx';
import Confirm from '../ui/Confirm.jsx';
import Modal from '../ui/Modal.jsx';
import { fmt$, fmtDate, uniqSuggestions } from '../formatters.js';
import { today } from '../utils/storage.js';
import { logActivity } from '../tabUtils.js';

function FI({ label, suggestions, fieldStyle, ...props }) {
  const listId = useId();
  const hasSuggestions = Array.isArray(suggestions) && suggestions.length > 0;
  return (
    <div className="field" style={{ ...(label ? {} : { marginBottom: 0 }), ...fieldStyle }}>
      {label && <label>{label}</label>}
      <input className="input" {...props} list={hasSuggestions ? listId : undefined} />
      {hasSuggestions && (
        <datalist id={listId}>
          {suggestions.map(s => <option key={s} value={s} />)}
        </datalist>
      )}
    </div>
  );
}

function Btn({ className = '', children, ...p }) {
  return <button className={`btn ${className}`} {...p}>{children}</button>;
}

export default function CustomerManagement({ customers, setCustomers, cateringInvoices, save }) {
  const blank = () => ({ name: '', phone: '', email: '', address: '', notes: '' });
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(blank());
  const [viewId, setViewId] = useState(null);
  const [confirmId, setConfirmId] = useState(null);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('name'); // 'name' | 'revenue' | 'invoices'

  const nameSuggestions = useMemo(() => uniqSuggestions(...customers.map(c => c.name)), [customers]);
  const phoneSuggestions = useMemo(() => uniqSuggestions(...customers.map(c => c.phone)), [customers]);
  const emailSuggestions = useMemo(() => uniqSuggestions(...customers.map(c => c.email)), [customers]);

  const custRevMap = useMemo(() => {
    const m = {};
    customers.forEach(c => {
      const invs = cateringInvoices.filter(i => i.customerId === c.id);
      m[c.id] = { count: invs.length, rev: invs.reduce((s, i) => s + (i.grandTotal || 0), 0) };
    });
    return m;
  }, [customers, cateringInvoices]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    const list = customers.filter(c =>
      c.name.toLowerCase().includes(q) ||
      (c.phone || '').includes(q) ||
      (c.email || '').toLowerCase().includes(q)
    );
    if (sortBy === 'revenue') return [...list].sort((a, b) => (custRevMap[b.id]?.rev || 0) - (custRevMap[a.id]?.rev || 0));
    if (sortBy === 'invoices') return [...list].sort((a, b) => (custRevMap[b.id]?.count || 0) - (custRevMap[a.id]?.count || 0));
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  }, [customers, search, sortBy, custRevMap]);

  function exportCsv() {
    if (!customers.length) { showToast('No customers to export.', 'error'); return; }
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = ['Name', 'Phone', 'Email', 'Address', 'Invoices', 'Total Revenue', 'Notes'];
    const rows = customers.map(c => {
      const cm = custRevMap[c.id] || { count: 0, rev: 0 };
      return [c.name, c.phone || '', c.email || '', c.address || '', cm.count, +cm.rev.toFixed(2), c.notes || ''];
    });
    const csv = [header.map(esc).join(','), ...rows.map(r => r.map(esc).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'customers-' + today() + '.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    showToast('Customer list exported.');
    logActivity('export_csv', `Exported ${customers.length} customers`);
  }

  function exportCustomersExcel() {
    if (!customers.length) { showToast('No customers to export.', 'error'); return; }
    const wb = XLSX.utils.book_new();
    const header = ['Name', 'Phone', 'Email', 'Address', 'Invoices', 'Total Revenue', 'Notes'];
    const rows = customers.map(c => {
      const cm = custRevMap[c.id] || { count: 0, rev: 0 };
      return [c.name, c.phone || '', c.email || '', c.address || '', cm.count, +cm.rev.toFixed(2), c.notes || ''];
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header, ...rows]), 'Customers');
    XLSX.writeFile(wb, 'customers-' + today() + '.xlsx');
    showToast('Customer list exported as Excel.');
    logActivity('export_xlsx', `Exported ${customers.length} customers Excel`);
  }

  const pendingDeleteCustomer = useMemo(
    () => (confirmId ? customers.find(c => c.id === confirmId) : null),
    [confirmId, customers]
  );

  function openEdit(c) {
    setForm({ name: c.name, phone: c.phone, email: c.email, address: c.address, notes: c.notes });
    setEditId(c.id);
    setShowForm(true);
  }

  function saveCust() {
    if (!form.name.trim()) { showToast('Customer name is required. [DMG-E006]', 'error'); return; }
    let u;
    if (editId) {
      u = customers.map(c => c.id === editId ? { ...c, ...form } : c);
      showToast('Customer updated.');
      logActivity('edit_customer', 'Updated customer ' + form.name);
    } else {
      u = [...customers, { id: crypto.randomUUID(), ...form, createdAt: new Date().toISOString().split('T')[0] }];
      showToast('Customer added.');
      logActivity('add_customer', 'Added customer ' + form.name);
    }
    setCustomers(u);
    save('customers', u);
    setShowForm(false);
    setEditId(null);
  }

  function delCust(id) {
    const removed = customers.find(c => c.id === id);
    const u = customers.filter(c => c.id !== id);
    setCustomers(u);
    save('customers', u);
    setConfirmId(null);
    showToast('Customer deleted.');
    logActivity('delete_customer', 'Deleted customer ' + (removed?.name || id));
  }

  const viewCust = customers.find(c => c.id === viewId);
  const custInvs = useMemo(() => cateringInvoices.filter(i => i.customerId === viewId), [viewId, cateringInvoices]);

  return (
    <div>
      <div className="flex-between mb-4 flex-wrap gap-2">
        <div className="section-title" style={{ margin: 0 }}>Customers ({customers.length})</div>
        <div className="flex gap-2 flex-wrap" style={{ alignItems: 'center' }}>
          <Btn className="btn-outline" onClick={exportCsv}>⬇ CSV</Btn>
          <Btn className="btn-outline" onClick={exportCustomersExcel}>⬇ Excel</Btn>
          <Btn className="btn-primary" onClick={() => { setForm(blank()); setEditId(null); setShowForm(true); }}>+ Add Customer</Btn>
        </div>
      </div>
      <div className="flex gap-2 mb-4" style={{ flexWrap: 'wrap' }}>
        <input className="input" style={{ flex: '1 1 200px' }} placeholder="Search customers…" value={search} onChange={e => setSearch(e.target.value)} />
        <select className="input" style={{ width: 'auto' }} value={sortBy} onChange={e => setSortBy(e.target.value)}>
          <option value="name">Sort: Name A–Z</option>
          <option value="revenue">Sort: Revenue ↓</option>
          <option value="invoices">Sort: Invoice count ↓</option>
        </select>
      </div>

      {filtered.length === 0
        ? <div className="card empty-state">No customers yet.</div>
        : (
          <div className="card" style={{ padding: 0 }}>
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>Name</th><th>Phone</th><th>Email</th><th>Invoices</th><th>Total Revenue</th><th>Actions</th></tr></thead>
                <tbody>
                  {filtered.map(c => {
                    const invs = cateringInvoices.filter(i => i.customerId === c.id);
                    const rev = invs.reduce((s, i) => s + (i.grandTotal || 0), 0);
                    return (
                      <tr key={c.id}>
                        <td style={{ fontWeight: 600 }}>{c.name}</td>
                        <td>{c.phone || '—'}</td>
                        <td>{c.email || '—'}</td>
                        <td>{invs.length}</td>
                        <td style={{ fontWeight: 600, color: 'var(--brown)' }}>{fmt$(rev)}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <Btn className="btn-outline btn-sm" style={{ marginRight: 4 }} onClick={() => setViewId(c.id)}>History</Btn>
                          <Btn className="btn-secondary btn-sm" style={{ marginRight: 4 }} onClick={() => openEdit(c)}>Edit</Btn>
                          <Btn className="btn-danger btn-sm" onClick={() => setConfirmId(c.id)}>Delete</Btn>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )
      }

      <Modal open={showForm} onClose={() => setShowForm(false)} title={editId ? 'Edit Customer' : 'Add Customer'}>
        <FI label="Full Name *" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} suggestions={nameSuggestions} />
        <div className="grid-2">
          <FI label="Phone" value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} suggestions={phoneSuggestions} />
          <FI label="Email" type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} suggestions={emailSuggestions} />
        </div>
        <FI label="Address" value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} />
        <div className="field"><label>Notes</label><textarea className="input" rows={2} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} /></div>
        <div className="flex gap-2" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
          <Btn className="btn-outline" onClick={() => setShowForm(false)}>Cancel</Btn>
          <Btn className="btn-primary" onClick={saveCust}>Save</Btn>
        </div>
      </Modal>

      <Modal open={!!viewCust} onClose={() => setViewId(null)} title={`${viewCust?.name || ''} — Account Statement`} wide closeOnBackdrop>
        {viewCust && (() => {
          const totalRevenue = custInvs.reduce((s, inv) => s + (inv.grandTotal || inv.total || 0), 0);
          const outstanding = custInvs.filter(inv => inv.status !== 'paid').reduce((s, inv) => s + (inv.balanceDue || 0), 0);
          const sorted = [...custInvs].sort((a, b) => (b.date || b.dateStart || '').localeCompare(a.date || a.dateStart || ''));
          const lastDate = sorted[0]?.date || sorted[0]?.dateStart;

          function printStatement() {
            const rows = sorted.map(inv => `<tr>
              <td>${inv.id}</td>
              <td>${inv.useRange ? `${fmtDate(inv.dateStart)} – ${fmtDate(inv.dateEnd)}` : fmtDate(inv.date)}</td>
              <td>${inv.eventType || ''}</td>
              <td style="text-align:right">${fmt$(inv.grandTotal)}</td>
              <td style="text-align:right;color:${inv.balanceDue > 0 ? '#DC2626' : '#15803D'}">${fmt$(inv.balanceDue)}</td>
              <td>${inv.status}</td>
            </tr>`).join('');
            const html = `<!DOCTYPE html><html><head><title>Statement — ${viewCust.name}</title><style>
              body{font-family:Arial,sans-serif;font-size:13px;padding:20px;color:#333}
              h2{color:#8B4513;margin-bottom:4px} .meta{color:#666;font-size:12px;margin-bottom:16px}
              table{border-collapse:collapse;width:100%} th{background:#FFF0D4;padding:7px 10px;text-align:left;border-bottom:2px solid #D2691E}
              td{padding:6px 10px;border-bottom:1px solid #eee} .totals{text-align:right;margin-top:14px;font-size:14px}
              @media print{body{padding:0}}
            </style></head><body>
              <h2>${viewCust.name}</h2>
              <div class="meta">${viewCust.phone ? `📞 ${viewCust.phone}  ` : ''}${viewCust.email ? `✉ ${viewCust.email}  ` : ''}${viewCust.address ? `📍 ${viewCust.address}` : ''}</div>
              <table><thead><tr><th>Invoice #</th><th>Date</th><th>Event</th><th style="text-align:right">Total</th><th style="text-align:right">Balance</th><th>Status</th></tr></thead>
              <tbody>${rows}</tbody></table>
              <div class="totals">
                Total Invoiced: <strong>${fmt$(totalRevenue)}</strong> &nbsp;|&nbsp;
                Outstanding: <strong style="color:${outstanding > 0 ? '#DC2626' : '#15803D'}">${fmt$(outstanding)}</strong>
              </div>
              <div style="margin-top:20px;font-size:11px;color:#aaa">Printed ${new Date().toLocaleString()}</div>
            </body></html>`;
            const w = window.open('', '_blank');
            if (!w) { showToast('Pop-up blocked. Allow pop-ups for printing.', 'error'); return; }
            w.document.write(html); w.document.close(); w.focus(); w.print();
          }

          function exportStatementExcel() {
            const wb = XLSX.utils.book_new();
            const header = ['Invoice #','Date','Event','Total','Balance Due','Status'];
            const rows = sorted.map(inv => [
              inv.id, inv.useRange ? `${inv.dateStart} – ${inv.dateEnd}` : (inv.date || ''),
              inv.eventType || '', +(inv.grandTotal||0).toFixed(2), +(inv.balanceDue||0).toFixed(2), inv.status || ''
            ]);
            XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header, ...rows]), 'Statement');
            XLSX.writeFile(wb, `statement-${viewCust.name.replace(/\s+/g,'-')}-${today()}.xlsx`);
            showToast('Statement exported as Excel.');
          }

          function exportStatementCsv() {
            const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
            const rows = sorted.map(inv => [
              inv.id, inv.useRange ? `${inv.dateStart} – ${inv.dateEnd}` : (inv.date || ''),
              inv.eventType || '', +(inv.grandTotal||0).toFixed(2), +(inv.balanceDue||0).toFixed(2), inv.status || ''
            ]);
            const csv = [['Invoice #','Date','Event','Total','Balance Due','Status'].map(esc).join(','),
              ...rows.map(r => r.map(esc).join(','))].join('\n');
            const blob = new Blob([csv], { type:'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = `statement-${viewCust.name.replace(/\s+/g,'-')}-${today()}.csv`;
            document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
            showToast('Statement exported as CSV.');
          }

          return (
            <div>
              <div style={{ padding: '10px 14px', background: 'var(--cream)', borderRadius: 6, marginBottom: 14, fontSize: 14 }}>
                {viewCust.phone && <div>📞 {viewCust.phone}</div>}
                {viewCust.email && <div>✉️ {viewCust.email}</div>}
                {viewCust.address && <div>📍 {viewCust.address}</div>}
                {viewCust.notes && <div style={{ color: '#888', marginTop: 4 }}>📝 {viewCust.notes}</div>}
              </div>
              {custInvs.length === 0
                ? <p style={{ color: '#aaa', textAlign: 'center', padding: 24 }}>No invoices for this customer yet.</p>
                : <>
                  <div style={{display:'flex', gap:16, marginBottom:10, fontSize:13, color:'#555', flexWrap:'wrap'}}>
                    <span>Total invoiced: <strong style={{color:'var(--brown)'}}>{fmt$(totalRevenue)}</strong></span>
                    <span>Outstanding: <strong style={{color: outstanding > 0 ? '#DC2626' : '#16A34A'}}>{fmt$(outstanding)}</strong></span>
                    <span>{custInvs.length} invoice{custInvs.length!==1?'s':''}</span>
                    {lastDate && <span>Last order: <strong>{fmtDate(lastDate)}</strong></span>}
                  </div>
                  <div className="tbl-wrap">
                    <table>
                      <thead><tr><th>Invoice #</th><th>Date</th><th>Event</th><th>Total</th><th>Balance</th><th>Status</th></tr></thead>
                      <tbody>
                        {sorted.map(inv => (
                          <tr key={inv.id}>
                            <td style={{ fontFamily: 'monospace', fontWeight: 600 }}>{inv.id}</td>
                            <td>{inv.useRange ? `${fmtDate(inv.dateStart)} – ${fmtDate(inv.dateEnd)}` : fmtDate(inv.date)}</td>
                            <td>{inv.eventType}</td>
                            <td style={{ fontWeight: 600 }}>{fmt$(inv.grandTotal)}</td>
                            <td style={{ color: inv.balanceDue > 0 ? 'var(--danger)' : 'var(--success)', fontWeight: 600 }}>{fmt$(inv.balanceDue)}</td>
                            <td><span className={`badge badge-${inv.status}`}>{inv.status}</span></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex gap-2" style={{justifyContent:'flex-end',marginTop:12,flexWrap:'wrap'}}>
                    <button className="btn btn-outline btn-sm" onClick={exportStatementCsv}>⬇ CSV</button>
                    <button className="btn btn-outline btn-sm" onClick={exportStatementExcel}>⬇ Excel</button>
                    <button className="btn btn-outline btn-sm" onClick={printStatement}>🖨 Print Statement</button>
                    {viewCust.email && outstanding > 0 && (() => {
                      const invList = sorted.filter(i => i.status !== 'paid').map(i => `  • ${i.id} (${i.useRange ? i.dateStart : i.date}): ${fmt$(i.balanceDue)} due`).join('\n');
                      const subj = encodeURIComponent(`Payment Reminder — ${viewCust.name}`);
                      const body = encodeURIComponent(`Dear ${viewCust.name},\n\nThis is a friendly reminder that you have an outstanding balance of ${fmt$(outstanding)}.\n\nUnpaid invoices:\n${invList}\n\nPlease contact us to arrange payment at your earliest convenience.\n\nThank you,\nThe Team`);
                      return <a className="btn btn-outline btn-sm" href={`mailto:${viewCust.email}?subject=${subj}&body=${body}`}>✉ Send Reminder</a>;
                    })()}
                  </div>
                </>
              }
            </div>
          );
        })()}
      </Modal>

      <Confirm
        open={!!confirmId}
        title="Delete customer?"
        message={
          pendingDeleteCustomer
            ? `Remove "${pendingDeleteCustomer.name}" from the customer list on this device?`
            : 'Remove this customer from the customer list on this device?'
        }
        detail="Existing catering invoices in the archive still reference this customer by ID; only the saved customer card is removed."
        dangerCode="DMG-E012 (local data change)"
        confirmLabel="Delete customer"
        onConfirm={() => delCust(confirmId)}
        onCancel={() => setConfirmId(null)}
      />
    </div>
  );
}
