import React, { useState, useMemo, useId, useEffect } from 'react';
import * as XLSX from 'xlsx';
import { showToast } from '../toastContext.jsx';
import Confirm from '../ui/Confirm.jsx';
import Modal from '../ui/Modal.jsx';
import { fmt$, fmtDate, uniqSuggestions } from '../formatters.js';
import { today } from '../utils/storage.js';
import { logActivity } from '../tabUtils.js';
import { printHtmlDocument } from '../utils/print.js';
import { moveToTrash } from '../utils/trash.js';
import { buildProfessionalDoc, docSection, docMoney, esc } from '../utils/professionalDoc.js';

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

export default function CustomerManagement({ customers, setCustomers, cateringInvoices, save, brandingMap = null, selectedBusiness = 'degrill', pendingOpen, onConsumePending }) {
  const blank = () => ({ name: '', phone: '', email: '', address: '', notes: '' });
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(blank());
  const [viewId, setViewId] = useState(null);
  useEffect(() => {
    if (pendingOpen?.id) {
      setViewId(pendingOpen.id);
      onConsumePending?.();
    }
  }, [pendingOpen]);
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
    if (removed) moveToTrash('customers', `Customer — ${removed.name || id}`, removed);
    const u = customers.filter(c => c.id !== id);
    setCustomers(u);
    save('customers', u);
    setConfirmId(null);
    showToast('Customer deleted. Restore from Settings → Recently Deleted if needed.');
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
          {!readOnly && <Btn className="btn-primary" onClick={() => { setForm(blank()); setEditId(null); setShowForm(true); }}>+ Add Customer</Btn>}
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
        ? (customers.length === 0 ? (
            <div className="card empty-state" style={{padding:'36px 24px',color:'#7a5c20'}}>
              <div style={{fontSize:48,marginBottom:12}}>👥</div>
              <div style={{fontWeight:700,fontSize:18,color:'var(--brown)',marginBottom:6}}>No customers yet</div>
              <div style={{fontSize:14,lineHeight:1.6,maxWidth:420,margin:'0 auto 16px'}}>
                Your customers will appear here automatically the first time you create a catering invoice for them. You can also add one manually below.
              </div>
              <button className="btn btn-primary" onClick={() => { setForm(blank()); setEditId(null); setShowForm(true); }}>+ Add your first customer</button>
            </div>
          ) : (
            <div className="card empty-state">No customers match your search.</div>
          ))
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
            // Professional customer statement on letterhead. Picks the
            // business letterhead from the most-frequent business across
            // this customer's invoices, falling back to the currently
            // selected business.
            const counts = {};
            custInvs.forEach(i => { const b = i.business || ''; if (b) counts[b] = (counts[b] || 0) + 1; });
            const dominantBiz = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || selectedBusiness || 'degrill';
            const branding = (brandingMap?.[dominantBiz]) || { name: 'Statement of Account', address: '', phone: '', email: '', logo: '' };

            // Invoice list table.
            const head = `<tr style="background:#FBF6EC">
              <th style="text-align:left;padding:7px 10px;border-bottom:1.5px solid #8B4513;font-size:11px;letter-spacing:.5px;color:#8B4513;">INVOICE</th>
              <th style="text-align:left;padding:7px 10px;border-bottom:1.5px solid #8B4513;font-size:11px;letter-spacing:.5px;color:#8B4513;">DATE</th>
              <th style="text-align:left;padding:7px 10px;border-bottom:1.5px solid #8B4513;font-size:11px;letter-spacing:.5px;color:#8B4513;">EVENT</th>
              <th style="text-align:right;padding:7px 10px;border-bottom:1.5px solid #8B4513;font-size:11px;letter-spacing:.5px;color:#8B4513;">TOTAL</th>
              <th style="text-align:right;padding:7px 10px;border-bottom:1.5px solid #8B4513;font-size:11px;letter-spacing:.5px;color:#8B4513;">BALANCE</th>
              <th style="text-align:left;padding:7px 10px;border-bottom:1.5px solid #8B4513;font-size:11px;letter-spacing:.5px;color:#8B4513;">STATUS</th>
            </tr>`;
            const rowsHtml = sorted.map(inv => {
              const dateStr = inv.useRange ? `${fmtDate(inv.dateStart)} – ${fmtDate(inv.dateEnd)}` : fmtDate(inv.date);
              const bal = Number(inv.balanceDue || 0);
              const status = String(inv.status || 'unpaid').toLowerCase();
              const badgeColor = status === 'paid' ? '#15803D' : status === 'partial' ? '#1D4ED8' : '#b91c1c';
              return `<tr>
                <td style="padding:6px 10px;border-bottom:1px solid #eee;font-family:Menlo,Consolas,monospace;font-size:12px;color:#444;">${esc(inv.id)}</td>
                <td style="padding:6px 10px;border-bottom:1px solid #eee;font-size:12.5px;color:#444;">${esc(dateStr)}</td>
                <td style="padding:6px 10px;border-bottom:1px solid #eee;font-size:12.5px;color:#444;">${esc(inv.eventType || '')}</td>
                <td style="padding:6px 10px;border-bottom:1px solid #eee;font-size:13px;text-align:right;font-variant-numeric:tabular-nums;">${esc(docMoney(inv.grandTotal))}</td>
                <td style="padding:6px 10px;border-bottom:1px solid #eee;font-size:13px;text-align:right;font-weight:700;font-variant-numeric:tabular-nums;color:${bal > 0 ? '#b91c1c' : '#15803D'};">${esc(docMoney(bal))}</td>
                <td style="padding:6px 10px;border-bottom:1px solid #eee;font-size:11.5px;color:${badgeColor};text-transform:uppercase;letter-spacing:.4px;font-weight:700;">${esc(status)}</td>
              </tr>`;
            }).join('');
            const totalsRow = `<tr>
              <td colspan="3" style="padding:9px 10px;border-top:2px solid #333;font-weight:800;font-size:13px;">TOTAL ON THIS STATEMENT</td>
              <td style="padding:9px 10px;border-top:2px solid #333;text-align:right;font-weight:800;font-size:13px;font-variant-numeric:tabular-nums;">${esc(docMoney(totalRevenue))}</td>
              <td style="padding:9px 10px;border-top:2px solid #333;text-align:right;font-weight:800;font-size:14px;color:${outstanding > 0 ? '#b91c1c' : '#15803D'};font-variant-numeric:tabular-nums;">${esc(docMoney(outstanding))}</td>
              <td style="padding:9px 10px;border-top:2px solid #333;"></td>
            </tr>`;
            const table = `<table style="width:100%;border-collapse:collapse;">${head}${rowsHtml}${totalsRow}</table>`;

            const callout = outstanding > 0
              ? `<div style="margin-top:14px;padding:12px 16px;background:#FEF2F2;border:1px solid #FCA5A5;border-radius:8px;">
                  <span style="font-size:13px;color:#444;">Balance due:</span>
                  <span style="font-size:18px;font-weight:800;color:#b91c1c;margin-left:8px;">${esc(docMoney(outstanding))}</span>
                  <div style="margin-top:6px;font-size:11.5px;color:#7a5c20;">Please remit at your earliest convenience. Reach out with any questions.</div>
                </div>`
              : `<div style="margin-top:14px;padding:12px 16px;background:#F0FDF4;border:1px solid #86EFAC;border-radius:8px;font-size:13px;color:#15803d;">Account is current. Thank you for your business.</div>`;

            const html = buildProfessionalDoc({
              branding,
              docType: 'STATEMENT OF ACCOUNT',
              docNumber: `STM-${today().replace(/-/g, '')}-${(viewCust.name || 'customer').replace(/[^a-z0-9]/gi, '').slice(0, 10).toUpperCase()}`,
              periodLabel: 'All recorded invoices',
              recipient: {
                title: 'Statement For',
                lines: [viewCust.name, viewCust.address, [viewCust.phone, viewCust.email].filter(Boolean).join(' · ')].filter(Boolean),
              },
              bodyHtml: table + callout,
              footerNote: 'This statement summarizes invoices recorded under this account. If you believe an entry is incorrect, please contact us so we can review it.',
            });
            printHtmlDocument(html, `Statement — ${viewCust.name}`);
            logActivity('print_statement', `Printed customer statement for ${viewCust.name}`);
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
