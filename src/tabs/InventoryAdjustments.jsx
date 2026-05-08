import React, { useState, useMemo, useEffect, useId } from 'react';
import * as XLSX from 'xlsx';
import { showToast } from '../toastContext.jsx';
import Confirm from '../ui/Confirm.jsx';
import { LOCATIONS, INVENTORY_ADJUSTMENTS_KEY } from '../constants.js';
import { fmtDate } from '../formatters.js';
import { load, save, uid, today } from '../utils/storage.js';
import { logActivity } from '../utils/activity.js';

const REASONS = ['Received', 'Used/Consumed', 'Waste/Spoilage', 'Count Correction', 'Transfer', 'Other'];

function Btn({ className = '', children, ...p }) {
  return <button className={`btn ${className}`} {...p}>{children}</button>;
}

function FI({ label, suggestions, fieldStyle, ...props }) {
  const listId = useId();
  const hasSuggestions = Array.isArray(suggestions) && suggestions.length > 0;
  const baseFieldStyle = label ? {} : { marginBottom: 0 };
  return (
    <div className="field" style={{ ...baseFieldStyle, ...fieldStyle }}>
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

function FS({ label, children, ...props }) {
  return (
    <div className="field">
      {label && <label>{label}</label>}
      <select className="input" {...props}>{children}</select>
    </div>
  );
}

const blankForm = () => ({
  itemId: '',
  itemName: '',
  location: LOCATIONS[0],
  delta: '',
  reason: REASONS[0],
  notes: '',
  date: today(),
});

const PAGE_SIZE = 50;

export default function InventoryAdjustments({ items, setItems }) {
  const [adjustments, setAdjustments] = useState(() => load(INVENTORY_ADJUSTMENTS_KEY, []));
  const [form, setForm] = useState(blankForm());
  const [filterName, setFilterName] = useState('');
  const [filterLocation, setFilterLocation] = useState('');
  const [filterReason, setFilterReason] = useState('');
  const [filterDateFrom, setFilterDateFrom] = useState('');
  const [filterDateTo, setFilterDateTo] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [page, setPage] = useState(1);

  const itemNameSuggestions = useMemo(() => {
    const seen = new Set();
    return items.map(i => i.name).filter(n => { if (seen.has(n)) return false; seen.add(n); return true; });
  }, [items]);

  function setField(key, val) {
    setForm(f => ({ ...f, [key]: val }));
  }

  function handleItemNameChange(name) {
    const match = items.find(i => i.name.toLowerCase() === name.toLowerCase());
    setForm(f => ({ ...f, itemName: name, itemId: match ? match.id : '' }));
  }

  function handleSave() {
    const delta = parseFloat(form.delta);
    if (!form.itemName.trim()) { showToast('Please select an item.', 'error'); return; }
    if (!form.itemId) { showToast('Item not found in database. Please select a valid item.', 'error'); return; }
    if (isNaN(delta) || form.delta === '') { showToast('Please enter a quantity change.', 'error'); return; }
    if (!form.date) { showToast('Please enter a date.', 'error'); return; }

    const record = {
      id: uid(),
      itemId: form.itemId,
      itemName: form.itemName.trim(),
      location: form.location,
      delta,
      reason: form.reason,
      notes: form.notes.trim(),
      date: form.date,
      createdAt: new Date().toISOString(),
    };

    // Update item locQty
    const locKey = form.location.toLowerCase();
    const updatedItems = items.map(item => {
      if (item.id !== form.itemId) return item;
      const current = parseFloat(item.locQty?.[locKey]) || 0;
      return {
        ...item,
        locQty: { ...(item.locQty || {}), [locKey]: String(current + delta) },
      };
    });

    const updatedAdj = [record, ...adjustments];
    save(INVENTORY_ADJUSTMENTS_KEY, updatedAdj);
    save('items', updatedItems);
    setAdjustments(updatedAdj);
    setItems(updatedItems);
    setForm(blankForm());
    logActivity('adjustment_saved', `${delta > 0 ? '+' : ''}${delta} ${form.itemName} @ ${form.location} (${form.reason})`);
    showToast('Adjustment logged.', 'success');
  }

  const [transferForm, setTransferForm] = useState(() => ({
    itemName: '', itemId: '', fromLoc: LOCATIONS[0], toLoc: LOCATIONS[1],
    qty: '', notes: '', date: today(),
  }));

  function setTransferField(key, val) {
    setTransferForm(f => ({ ...f, [key]: val }));
  }

  function handleTransferItemName(name) {
    const match = items.find(i => i.name.toLowerCase() === name.toLowerCase());
    setTransferForm(f => ({ ...f, itemName: name, itemId: match ? match.id : '' }));
  }

  function handleTransfer() {
    const qty = parseFloat(transferForm.qty);
    if (!transferForm.itemName.trim()) { showToast('Please select an item.', 'error'); return; }
    if (!transferForm.itemId) { showToast('Item not found in database. Please select a valid item.', 'error'); return; }
    if (transferForm.fromLoc === transferForm.toLoc) { showToast('From and To locations must differ.', 'error'); return; }
    if (isNaN(qty) || qty <= 0) { showToast('Please enter a positive quantity.', 'error'); return; }
    if (!transferForm.date) { showToast('Please enter a date.', 'error'); return; }

    const { itemId, itemName, fromLoc, toLoc, notes, date } = transferForm;
    const createdAt = new Date().toISOString();
    const trimmedNotes = notes.trim();

    const outRecord = {
      id: uid(), itemId, itemName: itemName.trim(),
      location: fromLoc, delta: -qty, reason: 'Transfer',
      notes: `Transfer to ${toLoc}${trimmedNotes ? ': ' + trimmedNotes : ''}`,
      date, createdAt,
    };
    const inRecord = {
      id: uid(), itemId, itemName: itemName.trim(),
      location: toLoc, delta: qty, reason: 'Transfer',
      notes: `Transfer from ${fromLoc}${trimmedNotes ? ': ' + trimmedNotes : ''}`,
      date, createdAt,
    };

    const fromKey = fromLoc.toLowerCase();
    const toKey = toLoc.toLowerCase();
    const updatedItems = items.map(item => {
      if (item.id !== itemId) return item;
      const fromCurrent = parseFloat(item.locQty?.[fromKey]) || 0;
      const toCurrent = parseFloat(item.locQty?.[toKey]) || 0;
      return {
        ...item,
        locQty: {
          ...(item.locQty || {}),
          [fromKey]: String(fromCurrent - qty),
          [toKey]: String(toCurrent + qty),
        },
      };
    });

    const updatedAdj = [outRecord, inRecord, ...adjustments];
    save(INVENTORY_ADJUSTMENTS_KEY, updatedAdj);
    save('items', updatedItems);
    setAdjustments(updatedAdj);
    setItems(updatedItems);

    const matchedItem = items.find(i => i.id === itemId);
    logActivity('transfer_stock', `Transfer ${qty} ${matchedItem?.unit || ''} ${itemName.trim()}: ${fromLoc} → ${toLoc}`);
    showToast(`Transferred ${qty}${matchedItem?.unit ? ' ' + matchedItem.unit : ''} from ${fromLoc} to ${toLoc}.`, 'success');
    setTransferForm({ itemName: '', itemId: '', fromLoc: LOCATIONS[0], toLoc: LOCATIONS[1], qty: '', notes: '', date: today() });
  }

  function handleDelete(id) {
    const rec = adjustments.find(a => a.id === id);
    const updated = adjustments.filter(a => a.id !== id);
    save(INVENTORY_ADJUSTMENTS_KEY, updated);
    setAdjustments(updated);
    setConfirmDeleteId(null);
    if (rec) logActivity('adjustment_deleted', `Deleted adj for ${rec.itemName} (${rec.delta > 0 ? '+' : ''}${rec.delta})`);
    showToast('Adjustment deleted.', 'success');
  }

  function exportCsv() {
    if (!filtered.length) { showToast('No adjustments to export.', 'error'); return; }
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = filtered.map(a => [fmtDate(a.date), a.itemName, a.location, a.delta > 0 ? `+${a.delta}` : String(a.delta), a.reason, a.notes || '']);
    const csv = [['Date','Item','Location','Qty Change','Reason','Notes'].map(esc).join(','), ...rows.map(r => r.map(esc).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'inventory-adjustments-' + today() + '.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    showToast('Adjustments exported.');
  }

  function exportExcel() {
    if (!filtered.length) { showToast('No adjustments to export.', 'error'); return; }
    const header = ['Date','Item','Location','Qty Change','Reason','Notes'];
    const rows = filtered.map(a => [a.date, a.itemName, a.location, a.delta > 0 ? `+${a.delta}` : String(a.delta), a.reason, a.notes || '']);
    const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Adjustments');
    XLSX.writeFile(wb, 'inventory-adjustments-' + today() + '.xlsx');
    showToast('Adjustments exported as Excel.');
  }

  const filtered = useMemo(() => {
    const q = filterName.toLowerCase();
    return adjustments.filter(a => {
      if (q && !a.itemName.toLowerCase().includes(q)) return false;
      if (filterLocation && a.location !== filterLocation) return false;
      if (filterReason && a.reason !== filterReason) return false;
      if (filterDateFrom && a.date < filterDateFrom) return false;
      if (filterDateTo && a.date > filterDateTo) return false;
      return true;
    }).sort((a, b) => {
      if (b.date !== a.date) return b.date.localeCompare(a.date);
      return b.createdAt.localeCompare(a.createdAt);
    });
  }, [adjustments, filterName, filterLocation, filterReason, filterDateFrom, filterDateTo]);

  useEffect(() => { setPage(1); }, [filterName, filterLocation, filterReason, filterDateFrom, filterDateTo]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paginated = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const pendingDelete = adjustments.find(a => a.id === confirmDeleteId);

  return (
    <div>
      {/* Add Adjustment Form */}
      <div className="card mb-4">
        <div className="section-title" style={{ marginBottom: 12 }}>Log Inventory Adjustment</div>
        <div className="grid-2">
          <FI
            label="Item"
            value={form.itemName}
            onChange={e => handleItemNameChange(e.target.value)}
            suggestions={itemNameSuggestions}
            placeholder="Search item…"
          />
          <FS label="Location" value={form.location} onChange={e => setField('location', e.target.value)}>
            {LOCATIONS.map(l => <option key={l} value={l}>{l}</option>)}
          </FS>
          <FI
            label="Qty Change (+ or -)"
            type="number"
            value={form.delta}
            onChange={e => setField('delta', e.target.value)}
            placeholder="e.g. 10 or -3"
            step="any"
          />
          <FS label="Reason" value={form.reason} onChange={e => setField('reason', e.target.value)}>
            {REASONS.map(r => <option key={r} value={r}>{r}</option>)}
          </FS>
          <FI
            label="Notes (optional)"
            value={form.notes}
            onChange={e => setField('notes', e.target.value)}
            placeholder="Optional notes…"
          />
          <FI
            label="Date"
            type="date"
            value={form.date}
            onChange={e => setField('date', e.target.value)}
          />
        </div>
        <div style={{ marginTop: 8 }}>
          <Btn className="btn-primary" onClick={handleSave}>Save Adjustment</Btn>
        </div>
      </div>

      {/* Transfer Between Locations */}
      <div className="card mb-4">
        <div className="section-title" style={{ marginBottom: 12 }}>Transfer Stock Between Locations</div>
        <div className="grid-2">
          <FI
            label="Item"
            value={transferForm.itemName}
            onChange={e => handleTransferItemName(e.target.value)}
            suggestions={itemNameSuggestions}
            placeholder="Search item…"
          />
          <FS label="From Location" value={transferForm.fromLoc} onChange={e => setTransferField('fromLoc', e.target.value)}>
            {LOCATIONS.map(l => <option key={l} value={l}>{l}</option>)}
          </FS>
          <FS label="To Location" value={transferForm.toLoc} onChange={e => setTransferField('toLoc', e.target.value)}>
            {LOCATIONS.map(l => <option key={l} value={l}>{l}</option>)}
          </FS>
          <FI
            label="Quantity to Transfer"
            type="number"
            value={transferForm.qty}
            onChange={e => setTransferField('qty', e.target.value)}
            placeholder="e.g. 5"
            min="0"
            step="any"
          />
          <FI
            label="Notes (optional)"
            value={transferForm.notes}
            onChange={e => setTransferField('notes', e.target.value)}
            placeholder="Optional notes…"
          />
          <FI
            label="Date"
            type="date"
            value={transferForm.date}
            onChange={e => setTransferField('date', e.target.value)}
          />
        </div>
        <div style={{ marginTop: 8 }}>
          <Btn className="btn-primary" onClick={handleTransfer}>Transfer Stock</Btn>
        </div>
        <p style={{ marginTop: 8, fontSize: 13, color: '#666' }}>
          Both a deduction from [{transferForm.fromLoc}] and an addition to [{transferForm.toLoc}] are recorded in the log.
        </p>
      </div>

      {/* Filters + Table */}
      <div className="card">
        <div className="flex-between mb-4" style={{ flexWrap: 'wrap', gap: 8 }}>
          <div className="section-title" style={{ margin: 0 }}>
            Adjustment Log <span style={{ fontWeight: 400, fontSize: 13, color: '#888' }}>({adjustments.length})</span>
          </div>
          <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
            <Btn className="btn-outline btn-sm" onClick={exportCsv}>⬇ CSV</Btn>
            <Btn className="btn-outline btn-sm" onClick={exportExcel}>⬇ Excel</Btn>
            <input
              className="input"
              style={{ width: 140 }}
              placeholder="Filter by item…"
              value={filterName}
              onChange={e => setFilterName(e.target.value)}
            />
            <select className="input" style={{ width: 130 }} value={filterLocation} onChange={e => setFilterLocation(e.target.value)}>
              <option value="">All Locations</option>
              {LOCATIONS.map(l => <option key={l} value={l}>{l}</option>)}
            </select>
            <select className="input" style={{ width: 150 }} value={filterReason} onChange={e => setFilterReason(e.target.value)}>
              <option value="">All Reasons</option>
              {REASONS.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
            <input className="input" type="date" style={{width:'auto'}} value={filterDateFrom} onChange={e=>setFilterDateFrom(e.target.value)} title="From date" />
            <input className="input" type="date" style={{width:'auto'}} value={filterDateTo} onChange={e=>setFilterDateTo(e.target.value)} title="To date" />
            {(filterName||filterLocation||filterReason||filterDateFrom||filterDateTo) && (
              <Btn className="btn-sm" style={{background:'#eee',color:'#666',borderRadius:12,padding:'2px 10px'}} onClick={()=>{setFilterName('');setFilterLocation('');setFilterReason('');setFilterDateFrom('');setFilterDateTo('');}}>✕ Clear</Btn>
            )}
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="empty-state">No adjustments found.</div>
        ) : (
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Item</th>
                  <th>Location</th>
                  <th>Qty Change</th>
                  <th>Reason</th>
                  <th>Notes</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {paginated.map(a => (
                  <tr key={a.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(a.date)}</td>
                    <td>{a.itemName}</td>
                    <td>{a.location}</td>
                    <td style={{ fontWeight: 600, color: a.delta > 0 ? '#2a7a2a' : '#b00' }}>
                      {a.delta > 0 ? `+${a.delta}` : String(a.delta)}
                    </td>
                    <td>{a.reason}</td>
                    <td style={{ color: '#666', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {a.notes || '—'}
                    </td>
                    <td>
                      <Btn className="btn-danger btn-sm" onClick={() => setConfirmDeleteId(a.id)}>Delete</Btn>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {totalPages > 1 && (
          <div className="flex-between" style={{ marginTop: 12, alignItems: 'center' }}>
            <Btn className="btn-sm btn-outline" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}>← Prev</Btn>
            <span style={{ fontSize: 13, color: '#666' }}>Page {page} of {totalPages} ({filtered.length} records)</span>
            <Btn className="btn-sm btn-outline" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}>Next →</Btn>
          </div>
        )}
      </div>

      <Confirm
        open={!!confirmDeleteId}
        title="Delete adjustment?"
        message={pendingDelete ? `Delete the adjustment for "${pendingDelete.itemName}" on ${fmtDate(pendingDelete.date)}?` : ''}
        detail="This removes the log entry only. The stock quantity change will NOT be reversed."
        confirmLabel="Delete"
        confirmClass="btn-danger"
        onConfirm={() => handleDelete(confirmDeleteId)}
        onCancel={() => setConfirmDeleteId(null)}
      />
    </div>
  );
}
