import React, { useState, useMemo, useId } from 'react';
import * as XLSX from 'xlsx';
import { showToast } from '../toastContext.jsx';
import Confirm from '../ui/Confirm.jsx';
import Modal from '../ui/Modal.jsx';
import { fmt$, fmtDate, uniqSuggestions } from '../formatters.js';
import { load, save, uid, today } from '../utils/storage.js';
import { logActivity } from '../utils/activity.js';

const SUPPLIERS_KEY = '_suppliers';
const PAYMENT_TERMS = ['Net 7', 'Net 15', 'Net 30', 'Net 60', 'COD', 'Prepaid', 'Other'];

function Btn({ className = '', children, ...p }) {
  return <button className={`btn ${className}`} {...p}>{children}</button>;
}
function FI({ label, suggestions, ...props }) {
  const listId = useId();
  const hasSugg = Array.isArray(suggestions) && suggestions.length > 0;
  return (
    <div className="field">
      {label && <label>{label}</label>}
      <input className="input" {...props} list={hasSugg ? listId : undefined} />
      {hasSugg && <datalist id={listId}>{suggestions.map(s => <option key={s} value={s} />)}</datalist>}
    </div>
  );
}
function FS({ label, children, ...props }) {
  return (
    <div className="field">
      {label && <label>{label}</label>}
      <select className="input" {...props}>{children}</select>
    </div>
  );
}

const blank = () => ({ name: '', phone: '', email: '', address: '', website: '', notes: '', paymentTerms: '' });

export default function SupplierManagement({ suppliers, setSuppliers, items = [], purchaseInvoices = [] }) {
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(blank());
  const [viewId, setViewId] = useState(null);
  const [confirmId, setConfirmId] = useState(null);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('name');
  const [showDiscover, setShowDiscover] = useState(false);

  const nameSuggs = useMemo(() => uniqSuggestions(...suppliers.map(s => s.name)), [suppliers]);

  // Build spend and order stats per supplier
  const supplierStats = useMemo(() => {
    const m = {};
    purchaseInvoices.forEach(inv => {
      const name = (inv.supplier || '').toLowerCase();
      if (!name) return;
      if (!m[name]) m[name] = { spend: 0, orders: 0 };
      m[name].spend += inv.total || 0;
      m[name].orders += 1;
    });
    return m;
  }, [purchaseInvoices]);

  // Count items per supplier (by seller name)
  const itemsPerSupplier = useMemo(() => {
    const m = {};
    items.forEach(item => {
      (item.sellers || []).forEach(sel => {
        const name = (sel.name || '').toLowerCase();
        if (!name) return;
        m[name] = (m[name] || 0) + 1;
      });
    });
    return m;
  }, [items]);

  // All known supplier names (from items + invoices), not yet registered
  const allKnownNames = useMemo(() => {
    const s = new Set();
    items.forEach(item => (item.sellers || []).forEach(sel => { if (sel.name?.trim()) s.add(sel.name.trim()); }));
    purchaseInvoices.forEach(inv => { if (inv.supplier?.trim()) s.add(inv.supplier.trim()); });
    const registered = new Set(suppliers.map(x => x.name.toLowerCase()));
    return [...s].filter(n => !registered.has(n.toLowerCase())).sort((a, b) => a.localeCompare(b));
  }, [items, purchaseInvoices, suppliers]);

  function statsFor(sup) {
    const k = sup.name.toLowerCase();
    return {
      spend: supplierStats[k]?.spend || 0,
      orders: supplierStats[k]?.orders || 0,
      itemCount: itemsPerSupplier[k] || 0,
      lastInv: purchaseInvoices.filter(i => (i.supplier || '').toLowerCase() === k).sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0]?.date || null,
    };
  }

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    let list = suppliers.filter(s =>
      s.name.toLowerCase().includes(q) ||
      (s.phone || '').includes(q) ||
      (s.email || '').toLowerCase().includes(q)
    );
    if (sortBy === 'spend') return [...list].sort((a, b) => (supplierStats[b.name.toLowerCase()]?.spend || 0) - (supplierStats[a.name.toLowerCase()]?.spend || 0));
    if (sortBy === 'orders') return [...list].sort((a, b) => (supplierStats[b.name.toLowerCase()]?.orders || 0) - (supplierStats[a.name.toLowerCase()]?.orders || 0));
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  }, [suppliers, search, sortBy, supplierStats]);

  function openEdit(s) {
    setForm({ name: s.name, phone: s.phone || '', email: s.email || '', address: s.address || '', website: s.website || '', notes: s.notes || '', paymentTerms: s.paymentTerms || '' });
    setEditId(s.id);
    setShowForm(true);
  }

  function saveSupplier() {
    if (!form.name.trim()) { showToast('Supplier name is required.', 'error'); return; }
    const dup = suppliers.find(s => s.name.toLowerCase() === form.name.toLowerCase().trim() && s.id !== editId);
    if (dup) { showToast('A supplier with that name already exists.', 'error'); return; }
    let next;
    if (editId) {
      next = suppliers.map(s => s.id === editId ? { ...s, ...form, name: form.name.trim() } : s);
      showToast('Supplier updated.');
      logActivity('edit_item', 'Updated supplier ' + form.name);
    } else {
      next = [...suppliers, { id: uid(), ...form, name: form.name.trim(), createdAt: today() }];
      showToast('Supplier added.');
      logActivity('add_item', 'Added supplier ' + form.name);
    }
    setSuppliers(next);
    save(SUPPLIERS_KEY, next);
    setShowForm(false);
    setEditId(null);
  }

  function delSupplier(id) {
    const removed = suppliers.find(s => s.id === id);
    const next = suppliers.filter(s => s.id !== id);
    setSuppliers(next);
    save(SUPPLIERS_KEY, next);
    setConfirmId(null);
    showToast('Supplier removed.');
    logActivity('delete_item', 'Removed supplier ' + (removed?.name || id));
  }

  function discoverAdd(names) {
    const toAdd = names.map(name => ({ id: uid(), name, phone: '', email: '', website: '', notes: '', paymentTerms: '', createdAt: today() }));
    const next = [...suppliers, ...toAdd];
    setSuppliers(next);
    save(SUPPLIERS_KEY, next);
    showToast(`Added ${toAdd.length} supplier${toAdd.length !== 1 ? 's' : ''}.`);
    logActivity('add_item', `Bulk-added ${toAdd.length} suppliers from discovery`);
    setShowDiscover(false);
  }

  function exportCsv() {
    if (!suppliers.length) { showToast('No suppliers to export.', 'error'); return; }
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = ['Name', 'Phone', 'Email', 'Address', 'Website', 'Payment Terms', 'Total Spend', 'Orders', 'Items Supplied', 'Notes'];
    const rows = suppliers.map(s => {
      const st = statsFor(s);
      return [s.name, s.phone || '', s.email || '', s.address || '', s.website || '', s.paymentTerms || '', +st.spend.toFixed(2), st.orders, st.itemCount, s.notes || ''];
    });
    const csv = [header.map(esc).join(','), ...rows.map(r => r.map(esc).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'suppliers-' + today() + '.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    showToast('Suppliers exported as CSV.');
    logActivity('export_csv', `Exported ${suppliers.length} suppliers`);
  }

  function exportExcel() {
    if (!suppliers.length) { showToast('No suppliers to export.', 'error'); return; }
    const wb = XLSX.utils.book_new();
    const header = ['Name', 'Phone', 'Email', 'Address', 'Website', 'Payment Terms', 'Total Spend', 'Orders', 'Items Supplied', 'Notes'];
    const rows = suppliers.map(s => {
      const st = statsFor(s);
      return [s.name, s.phone || '', s.email || '', s.address || '', s.website || '', s.paymentTerms || '', +st.spend.toFixed(2), st.orders, st.itemCount, s.notes || ''];
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header, ...rows]), 'Suppliers');
    XLSX.writeFile(wb, 'suppliers-' + today() + '.xlsx');
    showToast('Suppliers exported as Excel.');
    logActivity('export_xlsx', `Exported ${suppliers.length} suppliers`);
  }

  const viewSup = suppliers.find(s => s.id === viewId);
  const viewStats = viewSup ? statsFor(viewSup) : null;
  const viewInvoices = viewSup ? purchaseInvoices.filter(i => (i.supplier || '').toLowerCase() === viewSup.name.toLowerCase()).sort((a, b) => (b.date || '').localeCompare(a.date || '')) : [];
  const viewItems = viewSup ? items.filter(item => (item.sellers || []).some(sel => sel.name?.toLowerCase() === viewSup.name.toLowerCase())) : [];
  const pendingDelete = confirmId ? suppliers.find(s => s.id === confirmId) : null;

  return (
    <div>
      <div className="flex-between mb-4 flex-wrap gap-2">
        <div className="section-title" style={{ margin: 0 }}>Suppliers ({suppliers.length})</div>
        <div className="flex gap-2 flex-wrap" style={{ alignItems: 'center' }}>
          {allKnownNames.length > 0 && <Btn className="btn-outline" onClick={() => setShowDiscover(true)}>🔍 Discover ({allKnownNames.length})</Btn>}
          <Btn className="btn-outline" onClick={exportCsv}>⬇ CSV</Btn>
          <Btn className="btn-outline" onClick={exportExcel}>⬇ Excel</Btn>
          <Btn className="btn-primary" onClick={() => { setForm(blank()); setEditId(null); setShowForm(true); }}>+ Add Supplier</Btn>
        </div>
      </div>

      <div className="flex gap-2 mb-4" style={{ flexWrap: 'wrap' }}>
        <input className="input" style={{ flex: '1 1 200px' }} placeholder="Search suppliers…" value={search} onChange={e => setSearch(e.target.value)} />
        <select className="input" style={{ width: 'auto' }} value={sortBy} onChange={e => setSortBy(e.target.value)}>
          <option value="name">Sort: Name A–Z</option>
          <option value="spend">Sort: Spend ↓</option>
          <option value="orders">Sort: Orders ↓</option>
        </select>
      </div>

      {suppliers.length === 0 && allKnownNames.length === 0 && (
        <div className="card empty-state">No suppliers yet. Add supplier contact info here, or use "Discover" after adding items with seller data.</div>
      )}
      {suppliers.length === 0 && allKnownNames.length > 0 && (
        <div className="card empty-state">
          <p>No suppliers registered yet.</p>
          <p style={{ fontSize: 13, color: '#888' }}>Found {allKnownNames.length} supplier name{allKnownNames.length !== 1 ? 's' : ''} from your items and invoices. Click <strong>Discover</strong> to add them.</p>
        </div>
      )}

      {filtered.length > 0 && (
        <div className="card" style={{ padding: 0 }}>
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Name</th><th>Phone</th><th>Email</th><th>Terms</th><th>Orders</th><th>Total Spend</th><th>Items</th><th>Actions</th></tr></thead>
              <tbody>
                {filtered.map(s => {
                  const st = statsFor(s);
                  return (
                    <tr key={s.id}>
                      <td style={{ fontWeight: 600 }}>{s.name}</td>
                      <td>{s.phone || '—'}</td>
                      <td>{s.email ? <a href={`mailto:${s.email}`} style={{ color: 'var(--brown)' }}>{s.email}</a> : '—'}</td>
                      <td>{s.paymentTerms || '—'}</td>
                      <td>{st.orders}</td>
                      <td style={{ fontWeight: 600, color: 'var(--brown)' }}>{fmt$(st.spend)}</td>
                      <td>{st.itemCount}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <Btn className="btn-outline btn-sm" style={{ marginRight: 4 }} onClick={() => setViewId(s.id)}>View</Btn>
                        <Btn className="btn-secondary btn-sm" style={{ marginRight: 4 }} onClick={() => openEdit(s)}>Edit</Btn>
                        <Btn className="btn-danger btn-sm" onClick={() => setConfirmId(s.id)}>Delete</Btn>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Add/Edit Form */}
      <Modal open={showForm} onClose={() => { setShowForm(false); setEditId(null); }} title={editId ? 'Edit Supplier' : 'Add Supplier'}>
        <FI label="Supplier Name *" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} suggestions={nameSuggs} placeholder="e.g. Sysco Foods" />
        <div className="grid-2">
          <FI label="Phone" value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} placeholder="(555) 123-4567" />
          <FI label="Email" type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder="orders@supplier.com" />
        </div>
        <FI label="Address" value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} placeholder="123 Main St, City, State" />
        <div className="grid-2">
          <FI label="Website" value={form.website} onChange={e => setForm(f => ({ ...f, website: e.target.value }))} placeholder="https://..." />
          <FS label="Payment Terms" value={form.paymentTerms} onChange={e => setForm(f => ({ ...f, paymentTerms: e.target.value }))}>
            <option value="">— Select —</option>
            {PAYMENT_TERMS.map(t => <option key={t} value={t}>{t}</option>)}
          </FS>
        </div>
        <div className="field"><label>Notes</label><textarea className="input" rows={2} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} /></div>
        <div className="flex gap-2" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
          <Btn className="btn-outline" onClick={() => { setShowForm(false); setEditId(null); }}>Cancel</Btn>
          <Btn className="btn-primary" onClick={saveSupplier}>Save</Btn>
        </div>
      </Modal>

      {/* View Modal */}
      <Modal open={!!viewSup} onClose={() => setViewId(null)} title={viewSup?.name || ''} wide closeOnBackdrop>
        {viewSup && viewStats && (
          <div>
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 14, fontSize: 14 }}>
              <div>
                {viewSup.phone && <div>📞 {viewSup.phone}</div>}
                {viewSup.email && <div>✉️ <a href={`mailto:${viewSup.email}`} style={{ color: 'var(--brown)' }}>{viewSup.email}</a></div>}
                {viewSup.address && <div>📍 {viewSup.address}</div>}
                {viewSup.website && <div>🌐 <a href={viewSup.website} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--brown)' }}>{viewSup.website}</a></div>}
                {viewSup.paymentTerms && <div>💳 {viewSup.paymentTerms}</div>}
                {viewSup.notes && <div style={{ color: '#888', marginTop: 4 }}>📝 {viewSup.notes}</div>}
              </div>
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 13, color: '#555' }}>
                <span>Total spend: <strong style={{ color: 'var(--brown)' }}>{fmt$(viewStats.spend)}</strong></span>
                <span>Orders: <strong>{viewStats.orders}</strong></span>
                <span>Items supplied: <strong>{viewStats.itemCount}</strong></span>
                {viewStats.lastInv && <span>Last order: <strong>{fmtDate(viewStats.lastInv)}</strong></span>}
              </div>
            </div>

            {viewInvoices.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 13 }}>Recent Purchase Orders</div>
                <div className="tbl-wrap">
                  <table>
                    <thead><tr><th>Invoice #</th><th>Date</th><th>Total</th><th>Status</th></tr></thead>
                    <tbody>
                      {viewInvoices.slice(0, 10).map(inv => (
                        <tr key={inv.id}>
                          <td style={{ fontFamily: 'monospace' }}>{inv.id}</td>
                          <td>{fmtDate(inv.date)}</td>
                          <td style={{ fontWeight: 600 }}>{fmt$(inv.total)}</td>
                          <td><span className={`badge badge-${inv.status || 'unpaid'}`}>{inv.status || 'unpaid'}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {viewItems.length > 0 && (
              <div>
                <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 13 }}>Items Supplied</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {viewItems.map(item => (
                    <span key={item.id} style={{ background: '#FFF0D4', padding: '2px 8px', borderRadius: 10, fontSize: 12, color: '#7A3B00' }}>{item.name}</span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* Discover Suppliers Modal */}
      <Modal open={showDiscover} onClose={() => setShowDiscover(false)} title="Discover Unregistered Suppliers">
        <p style={{ fontSize: 13, color: '#555', marginBottom: 12 }}>
          These {allKnownNames.length} supplier name{allKnownNames.length !== 1 ? 's' : ''} were found in your item database and purchase invoices but haven't been added as supplier contacts yet.
        </p>
        <div style={{ maxHeight: 300, overflowY: 'auto', marginBottom: 12 }}>
          {allKnownNames.map(name => {
            const k = name.toLowerCase();
            return (
              <div key={name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #f0f0f0', fontSize: 13 }}>
                <span style={{ fontWeight: 600 }}>{name}</span>
                <span style={{ color: '#888', fontSize: 12 }}>
                  {supplierStats[k]?.orders || 0} orders · {fmt$(supplierStats[k]?.spend || 0)} · {itemsPerSupplier[k] || 0} items
                </span>
              </div>
            );
          })}
        </div>
        <div className="flex gap-2" style={{ justifyContent: 'flex-end' }}>
          <Btn className="btn-outline" onClick={() => setShowDiscover(false)}>Cancel</Btn>
          <Btn className="btn-primary" onClick={() => discoverAdd(allKnownNames)}>Add All ({allKnownNames.length})</Btn>
        </div>
      </Modal>

      <Confirm
        open={!!confirmId}
        title="Delete supplier?"
        message={pendingDelete ? `Remove "${pendingDelete.name}" from your supplier list?` : ''}
        detail="This only removes the contact record. Items and purchase invoices that reference this supplier are not affected."
        dangerCode="DMG-E012 (local data change)"
        confirmLabel="Delete supplier"
        onConfirm={() => delSupplier(confirmId)}
        onCancel={() => setConfirmId(null)}
      />
    </div>
  );
}
