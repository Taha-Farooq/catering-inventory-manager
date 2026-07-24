// Grocery quick-picker — scroll through every known pantry item, check
// the ones to shop for, set quantity and unit, and bulk-add to the
// shopping list. The fast path when she knows what she's running low on
// without typing each name.

import React, { useMemo, useState } from 'react';
import Modal from './Modal.jsx';
import { PURCHASE_UNITS } from '../constants.js';

export default function QuickPickerModal({ open, onClose, items = [], shoppingList = [], shoppingLoc, onConfirm }) {
  const [search, setSearch] = useState('');
  const [picks, setPicks] = useState({}); // { itemId: { qty: number, unit: string } }
  const [collapsedCats, setCollapsedCats] = useState({});

  // Reset when the modal opens.
  React.useEffect(() => {
    if (open) {
      setSearch('');
      setPicks({});
      setCollapsedCats({});
    }
  }, [open]);

  // Group items by category for visual scanning. Within each category,
  // sort low-stock items first so what she's already running out of
  // surfaces at the top of each section.
  const grouped = useMemo(() => {
    const q = search.toLowerCase().trim();
    const filtered = q
      ? items.filter(i => i.name.toLowerCase().includes(q) || (i.category || '').toLowerCase().includes(q))
      : items;
    const byCat = new Map();
    for (const it of filtered) {
      const cat = it.category || 'Other';
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat).push(it);
    }
    for (const list of byCat.values()) {
      list.sort((a, b) => {
        const aLow = isLowAt(a, shoppingLoc) ? 1 : 0;
        const bLow = isLowAt(b, shoppingLoc) ? 1 : 0;
        if (aLow !== bLow) return bLow - aLow;
        return String(a.name || '').localeCompare(String(b.name || ''));
      });
    }
    return [...byCat.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [items, search, shoppingLoc]);

  // For "already in list" annotations.
  const alreadyOnList = useMemo(() => {
    const ids = new Set();
    for (const s of shoppingList) if (s.itemId) ids.add(s.itemId);
    return ids;
  }, [shoppingList]);

  function togglePick(item) {
    setPicks(p => {
      const next = { ...p };
      if (next[item.id]) {
        delete next[item.id];
      } else {
        next[item.id] = { qty: 1, unit: item.unit || 'each' };
      }
      return next;
    });
  }
  function setQty(itemId, qty) {
    setPicks(p => p[itemId] ? { ...p, [itemId]: { ...p[itemId], qty } } : p);
  }
  function setUnit(itemId, unit) {
    setPicks(p => p[itemId] ? { ...p, [itemId]: { ...p[itemId], unit } } : p);
  }
  function selectAllInCat(catName) {
    const list = grouped.find(([c]) => c === catName)?.[1] || [];
    setPicks(p => {
      const next = { ...p };
      for (const it of list) if (!next[it.id]) next[it.id] = { qty: 1, unit: it.unit || 'each' };
      return next;
    });
  }
  function clearAllInCat(catName) {
    const ids = new Set((grouped.find(([c]) => c === catName)?.[1] || []).map(i => i.id));
    setPicks(p => {
      const next = { ...p };
      for (const id of ids) delete next[id];
      return next;
    });
  }
  function selectAllLow() {
    setPicks(p => {
      const next = { ...p };
      for (const it of items) {
        if (isLowAt(it, shoppingLoc) && !next[it.id]) next[it.id] = { qty: 1, unit: it.unit || 'each' };
      }
      return next;
    });
  }

  const pickCount = Object.keys(picks).length;
  const allowedUnits = Array.from(new Set([...PURCHASE_UNITS, 'each', 'lb', 'oz', 'gal', 'case']));

  function confirm() {
    if (pickCount === 0) return;
    const entries = Object.entries(picks).map(([id, p]) => {
      const item = items.find(i => i.id === id);
      return item ? { item, qty: Number(p.qty) || 1, unit: p.unit || item.unit || 'each' } : null;
    }).filter(Boolean);
    onConfirm?.(entries);
    onClose?.();
  }

  return (
    <Modal open={open} onClose={onClose} title="🛒 Quick-pick from Pantry & Supplies" maxW={760} closeOnBackdrop>
      <div style={{ position: 'sticky', top: 0, background: '#fff', zIndex: 2, paddingBottom: 10, borderBottom: '1px solid #f3f3f3', marginBottom: 6 }}>
        <input
          className="input"
          placeholder="Filter by name or category…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ fontSize: 15 }}
          autoFocus
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="btn btn-outline btn-sm" onClick={selectAllLow}>⚠ Pick all low-stock</button>
          <span style={{ fontSize: 12, color: '#888' }}>{pickCount > 0 ? `${pickCount} selected` : 'Nothing selected yet'}</span>
        </div>
      </div>

      <div style={{ maxHeight: '55vh', overflowY: 'auto', paddingRight: 6, marginTop: 4 }}>
        {grouped.length === 0 && (
          <div style={{ padding: 20, color: '#999', textAlign: 'center' }}>
            {items.length === 0 ? 'No pantry items yet — add some in the Pantry & Supplies tab.' : 'No items match the search.'}
          </div>
        )}
        {grouped.map(([cat, list]) => {
          const collapsed = !!collapsedCats[cat];
          const catPicked = list.filter(i => picks[i.id]).length;
          return (
            <div key={cat} style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px', borderBottom: '1.5px solid #DEB887', background: '#FBF6EC', position: 'sticky', top: 0, zIndex: 1 }}>
                <button onClick={() => setCollapsedCats(c => ({ ...c, [cat]: !collapsed }))}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: '#8B4513', fontWeight: 700, flex: 1, textAlign: 'left' }}>
                  {collapsed ? '▸' : '▾'} {cat} <span style={{ fontSize: 11, color: '#888', fontWeight: 400 }}>· {list.length} item{list.length !== 1 ? 's' : ''}{catPicked ? ` · ${catPicked} picked` : ''}</span>
                </button>
                <button className="btn btn-outline btn-sm" onClick={() => selectAllInCat(cat)} title={`Pick every ${cat} item`}>All</button>
                {catPicked > 0 && (
                  <button className="btn btn-outline btn-sm" onClick={() => clearAllInCat(cat)} title={`Unpick all in ${cat}`}>Clear</button>
                )}
              </div>
              {!collapsed && list.map(it => {
                const picked = !!picks[it.id];
                const already = alreadyOnList.has(it.id);
                const low = isLowAt(it, shoppingLoc);
                return (
                  <div key={it.id}
                    onClick={() => togglePick(it)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '8px 6px', borderBottom: '1px solid #f3f3f3', cursor: 'pointer',
                      background: picked ? '#F0FDF4' : 'transparent',
                    }}>
                    <input type="checkbox" checked={picked} readOnly tabIndex={-1} style={{ cursor: 'pointer', width: 18, height: 18 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13.5, color: '#222', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span>{it.name}</span>
                        {low && <span style={{ background: '#FEF2F2', color: '#b91c1c', fontSize: 10.5, padding: '1px 6px', borderRadius: 10, fontWeight: 700 }}>LOW</span>}
                        {already && <span style={{ background: '#EFF6FF', color: '#1D4ED8', fontSize: 10.5, padding: '1px 6px', borderRadius: 10, fontWeight: 700 }}>already on list</span>}
                      </div>
                      <div style={{ fontSize: 11, color: '#888' }}>{stockSummary(it, shoppingLoc)}</div>
                    </div>
                    {picked && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }} onClick={e => e.stopPropagation()}>
                        <input type="number" min="0" step="0.5" value={picks[it.id].qty}
                          onChange={e => setQty(it.id, Number(e.target.value))}
                          style={{ width: 64, padding: '4px 6px', border: '1px solid #ccc', borderRadius: 4, fontSize: 14 }} />
                        <select value={picks[it.id].unit} onChange={e => setUnit(it.id, e.target.value)}
                          style={{ padding: '4px 6px', border: '1px solid #ccc', borderRadius: 4, fontSize: 13 }}>
                          {allowedUnits.map(u => <option key={u} value={u}>{u}</option>)}
                        </select>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14, paddingTop: 10, borderTop: '1px solid #eee' }}>
        <div style={{ fontSize: 12, color: '#888' }}>
          {pickCount > 0 ? `Will add ${pickCount} item${pickCount !== 1 ? 's' : ''} to the shopping list.` : 'Tap an item row to pick it.'}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={pickCount === 0} onClick={confirm}>
            ✓ Add {pickCount > 0 ? `${pickCount} ` : ''}to shopping list
          </button>
        </div>
      </div>
    </Modal>
  );
}

function isLowAt(item, loc) {
  const cur = Number(item.locQty?.[loc] ?? item.currentQty ?? 0);
  const min = Number(item.locMinQty?.[loc] ?? item.minQty ?? 0);
  return min > 0 && cur < min;
}

function stockSummary(item, loc) {
  const parts = [];
  if (item.category) parts.push(item.category);
  if (item.unit) parts.push(item.unit);
  const cur = item.locQty?.[loc] ?? item.currentQty;
  if (cur != null && cur !== '') parts.push(`${cur} on hand at ${loc}`);
  return parts.join(' · ');
}
