import React, { useState, useMemo, useId } from 'react';
import { showToast } from '../toastContext.jsx';
import Confirm from '../ui/Confirm.jsx';
import { LOCATIONS, INVENTORY_ADJUSTMENTS_KEY } from '../constants.js';
import { fmtDate } from '../formatters.js';
import { load, save, uid, today } from '../utils/storage.js';

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

export default function InventoryAdjustments({ items, setItems }) {
  const [adjustments, setAdjustments] = useState(() => load(INVENTORY_ADJUSTMENTS_KEY, []));
  const [form, setForm] = useState(blankForm());
  const [filterName, setFilterName] = useState('');
  const [filterLocation, setFilterLocation] = useState('');
  const [filterReason, setFilterReason] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

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
    showToast('Adjustment logged.', 'success');
  }

  function handleDelete(id) {
    const updated = adjustments.filter(a => a.id !== id);
    save(INVENTORY_ADJUSTMENTS_KEY, updated);
    setAdjustments(updated);
    setConfirmDeleteId(null);
    showToast('Adjustment deleted.', 'success');
  }

  const filtered = useMemo(() => {
    const q = filterName.toLowerCase();
    return adjustments.filter(a => {
      if (q && !a.itemName.toLowerCase().includes(q)) return false;
      if (filterLocation && a.location !== filterLocation) return false;
      if (filterReason && a.reason !== filterReason) return false;
      return true;
    }).sort((a, b) => {
      if (b.date !== a.date) return b.date.localeCompare(a.date);
      return b.createdAt.localeCompare(a.createdAt);
    });
  }, [adjustments, filterName, filterLocation, filterReason]);

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

      {/* Filters + Table */}
      <div className="card">
        <div className="flex-between mb-4" style={{ flexWrap: 'wrap', gap: 8 }}>
          <div className="section-title" style={{ margin: 0 }}>
            Adjustment Log <span style={{ fontWeight: 400, fontSize: 13, color: '#888' }}>({adjustments.length})</span>
          </div>
          <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
            <input
              className="input"
              style={{ width: 160 }}
              placeholder="Filter by item…"
              value={filterName}
              onChange={e => setFilterName(e.target.value)}
            />
            <select className="input" style={{ width: 140 }} value={filterLocation} onChange={e => setFilterLocation(e.target.value)}>
              <option value="">All Locations</option>
              {LOCATIONS.map(l => <option key={l} value={l}>{l}</option>)}
            </select>
            <select className="input" style={{ width: 160 }} value={filterReason} onChange={e => setFilterReason(e.target.value)}>
              <option value="">All Reasons</option>
              {REASONS.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
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
                {filtered.map(a => (
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
