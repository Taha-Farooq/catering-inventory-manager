import React, { useState, useMemo, useId } from 'react';
import { showToast } from '../toastContext.jsx';
import Confirm from '../ui/Confirm.jsx';
import Modal from '../ui/Modal.jsx';
import { fmt$, fmtDate, uniqSuggestions } from '../formatters.js';
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

  const nameSuggestions = useMemo(() => uniqSuggestions(...customers.map(c => c.name)), [customers]);
  const phoneSuggestions = useMemo(() => uniqSuggestions(...customers.map(c => c.phone)), [customers]);
  const emailSuggestions = useMemo(() => uniqSuggestions(...customers.map(c => c.email)), [customers]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return customers.filter(c =>
      c.name.toLowerCase().includes(q) ||
      (c.phone || '').includes(q) ||
      (c.email || '').toLowerCase().includes(q)
    );
  }, [customers, search]);

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
    if (!form.name.trim()) { showToast('Customer name is required.', 'error'); return; }
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
        <Btn className="btn-primary" onClick={() => { setForm(blank()); setEditId(null); setShowForm(true); }}>+ Add Customer</Btn>
      </div>
      <input className="input mb-4" placeholder="Search customers…" value={search} onChange={e => setSearch(e.target.value)} />

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

      <Modal open={!!viewCust} onClose={() => setViewId(null)} title={`${viewCust?.name || ''} — Invoice History`} wide closeOnBackdrop>
        {viewCust && (
          <div>
            <div style={{ padding: '10px 14px', background: 'var(--cream)', borderRadius: 6, marginBottom: 16, fontSize: 14 }}>
              {viewCust.phone && <div>📞 {viewCust.phone}</div>}
              {viewCust.email && <div>✉️ {viewCust.email}</div>}
              {viewCust.address && <div>📍 {viewCust.address}</div>}
              {viewCust.notes && <div style={{ color: '#888', marginTop: 4 }}>📝 {viewCust.notes}</div>}
            </div>
            {custInvs.length === 0
              ? <p style={{ color: '#aaa', textAlign: 'center', padding: 24 }}>No invoices for this customer yet.</p>
              : (
                <>
                  <div style={{ marginBottom: 10, fontSize: 14 }}>
                    <strong>Total Revenue: </strong>
                    <span style={{ color: 'var(--brown)', fontWeight: 700 }}>{fmt$(custInvs.reduce((s, i) => s + (i.grandTotal || 0), 0))}</span>
                    <span style={{ marginLeft: 16, color: '#888' }}>{custInvs.length} invoice{custInvs.length !== 1 ? 's' : ''}</span>
                  </div>
                  <div className="tbl-wrap">
                    <table>
                      <thead><tr><th>Invoice #</th><th>Date</th><th>Event</th><th>Total</th><th>Balance</th><th>Status</th></tr></thead>
                      <tbody>
                        {[...custInvs].reverse().map(inv => (
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
                </>
              )
            }
          </div>
        )}
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
