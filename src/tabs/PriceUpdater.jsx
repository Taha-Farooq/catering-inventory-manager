import React, { useState, useMemo } from 'react';
import { showToast } from '../toastContext.jsx';
import { fmt$, sellerKey, safePrice } from '../formatters.js';
import { save, uid, today } from '../utils/storage.js';
import { logActivity } from '../utils/activity.js';

function Btn({ className='', children, ...p }) {
  return <button className={`btn ${className}`} {...p}>{children}</button>;
}

export default function PriceUpdater({ items, setItems, priceHistory, setPriceHistory }) {
  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState('');
  const [edits, setEdits] = useState({});
  const sellerEditKey = (itemId, sellerName, sellerIdx) => itemId+'|'+sellerKey(sellerName)+'|'+sellerIdx;

  const allCategories = useMemo(() => [...new Set(items.map(i => i.category).filter(Boolean))].sort(), [items]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return items.filter(i => {
      if (catFilter && i.category !== catFilter) return false;
      if (!q) return true;
      return i.name.toLowerCase().includes(q) || (i.category||'').toLowerCase().includes(q);
    });
  }, [items, search, catFilter]);

  function setPrice(itemId, sellerName, val, sellerIdx) {
    setEdits(prev => ({ ...prev, [sellerEditKey(itemId, sellerName, sellerIdx)]: val }));
  }
  function hasChanges(item) { return Object.keys(edits).some(k => k.startsWith(item.id+'|')); }
  function hasSellerChange(itemId, sellerName, sellerIdx) { return edits[sellerEditKey(itemId, sellerName, sellerIdx)] !== undefined; }

  function saveItem(item) {
    let valid = true;
    const newSellers = item.sellers.map((s, sellerIdx) => {
      const key = sellerEditKey(item.id, s.name, sellerIdx);
      if (edits[key] !== undefined) {
        const val = edits[key];
        if (val !== '' && safePrice(val) === null) { showToast('Invalid price for ' + s.name + ' [DMG-E006]', 'error'); valid = false; return s; }
        return { ...s, price: val==='' ? null : safePrice(val) };
      }
      return s;
    });
    if (!valid) return;

    const newHist = [];
    item.sellers.forEach((s, sellerIdx) => {
      const key = sellerEditKey(item.id, s.name, sellerIdx);
      if (edits[key] !== undefined) {
        const newPrice = edits[key]==='' ? null : safePrice(edits[key]);
        const oldPrice = s.price !== undefined ? s.price : null;
        if (oldPrice !== newPrice && oldPrice !== null && newPrice !== null)
          newHist.push({ id:uid(), itemId:item.id, itemName:item.name, seller:s.name, oldPrice, newPrice, date:today() });
      }
    });
    if (newHist.length) { const h=[...priceHistory,...newHist]; setPriceHistory(h); save('priceHistory',h); }

    const updated = items.map(i => i.id===item.id ? {...i, sellers:newSellers} : i);
    setItems(updated); save('items', updated);

    const remaining = {...edits};
    Object.keys(remaining).forEach(k => { if (k.startsWith(item.id+'|')) delete remaining[k]; });
    setEdits(remaining);
    logActivity('update_prices', item.name);
    showToast('Prices saved for ' + item.name);
  }

  const pendingCount = useMemo(() => filtered.filter(i => hasChanges(i)).length, [filtered, edits]);

  function saveAll() {
    const changed = filtered.filter(i => hasChanges(i));
    if (!changed.length) return;
    let valid = true;
    let nextItems = [...items];
    const allNewHist = [];
    const remainingEdits = { ...edits };
    changed.forEach(item => {
      const newSellers = item.sellers.map((s, sellerIdx) => {
        const key = sellerEditKey(item.id, s.name, sellerIdx);
        if (edits[key] !== undefined) {
          const val = edits[key];
          if (val !== '' && safePrice(val) === null) { showToast('Invalid price for ' + s.name + ' [DMG-E006]', 'error'); valid = false; return s; }
          return { ...s, price: val==='' ? null : safePrice(val) };
        }
        return s;
      });
      if (!valid) return;
      item.sellers.forEach((s, sellerIdx) => {
        const key = sellerEditKey(item.id, s.name, sellerIdx);
        if (edits[key] !== undefined) {
          const newPrice = edits[key]==='' ? null : safePrice(edits[key]);
          const oldPrice = s.price !== undefined ? s.price : null;
          if (oldPrice !== newPrice && oldPrice !== null && newPrice !== null)
            allNewHist.push({ id: uid(), itemId: item.id, itemName: item.name, seller: s.name, oldPrice, newPrice, date: today() });
        }
      });
      nextItems = nextItems.map(i => i.id === item.id ? { ...i, sellers: newSellers } : i);
      Object.keys(remainingEdits).forEach(k => { if (k.startsWith(item.id+'|')) delete remainingEdits[k]; });
      logActivity('update_prices', item.name);
    });
    if (!valid) return;
    if (allNewHist.length) { const h = [...priceHistory, ...allNewHist]; setPriceHistory(h); save('priceHistory', h); }
    setItems(nextItems); save('items', nextItems);
    setEdits(remainingEdits);
    showToast(`Saved prices for ${changed.length} item${changed.length !== 1 ? 's' : ''}.`);
  }

  return (
    <div>
      <div className="section-title">💰 Price Updater</div>
      <div style={{background:'#dbeafe',color:'#1d4ed8',borderRadius:8,padding:'12px 16px',marginBottom:16,fontSize:13.5,lineHeight:1.6}}>
        Update prices for each supplier below. Changed fields are highlighted. Click <strong>Save Prices</strong> to save an item's changes — price history is recorded automatically.
      </div>
      <div className="flex gap-2 mb-4 flex-wrap" style={{alignItems:'center'}}>
        <input className="input" style={{flex:'3 1 200px'}} placeholder="Search items by name or category…" value={search} onChange={e=>setSearch(e.target.value)} />
        <select className="input" style={{flex:'1 1 130px'}} value={catFilter} onChange={e=>setCatFilter(e.target.value)}>
          <option value="">All categories</option>
          {allCategories.map(c=><option key={c}>{c}</option>)}
        </select>
        {(search||catFilter) && <Btn className="btn-outline btn-sm" style={{alignSelf:'center'}} onClick={()=>{setSearch('');setCatFilter('');}}>✕ Clear</Btn>}
        {pendingCount > 0 && (
          <Btn className="btn-primary btn-sm" style={{marginLeft:'auto'}} onClick={saveAll}>
            💾 Save All ({pendingCount})
          </Btn>
        )}
      </div>
      {items.length===0 && <div className="card empty-state">No items yet. Use the Add Items tab to add items first.</div>}
      {items.length>0 && filtered.length===0 && <div className="card empty-state">No items match your search.</div>}
      {filtered.map(item=>(
        <div key={item.id} className="card mb-3">
          <div className="flex-between mb-3">
            <div>
              <div style={{fontWeight:700,fontSize:15,color:'var(--brown)'}}>{item.name}</div>
              <div style={{fontSize:12,color:'#888'}}>{item.category} · per {item.unit}</div>
            </div>
            <Btn className={'btn-primary btn-sm'+(hasChanges(item)?'':' btn-disabled')} onClick={()=>saveItem(item)} disabled={!hasChanges(item)} title={hasChanges(item)?'Save changes':'No changes to save'}>
              💾 Save Prices
            </Btn>
          </div>
          {(!item.sellers||item.sellers.length===0)
            ? <div style={{fontSize:13,color:'#aaa'}}>No suppliers added. Edit this item in the Item Database to add suppliers.</div>
            : item.sellers.map((s, sellerIdx) => {
                const key = sellerEditKey(item.id, s.name, sellerIdx);
                const changed = hasSellerChange(item.id, s.name, sellerIdx);
                const val = changed ? edits[key] : (s.price!=null ? String(s.price) : '');
                return (
                  <div key={s.name} style={{display:'flex',alignItems:'center',gap:10,marginBottom:8,padding:'8px 12px',borderRadius:6,background:changed?'#FFF8DC':'#f9f9f9',border:changed?'1px solid #DEB887':'1px solid #eee'}}>
                    <span style={{flex:2,fontWeight:600,color:'#5a3010',fontSize:14}}>{s.name}</span>
                    <input className="input" type="number" min="0" step="0.01" value={val} placeholder="Enter price"
                      onChange={e=>setPrice(item.id,s.name,e.target.value,sellerIdx)}
                      style={{flex:1.5,borderColor:changed?'var(--brown)':undefined}} />
                    <span style={{fontSize:13,color:'#888',minWidth:40}}>/{item.unit}</span>
                    {s.price!=null && <span style={{fontSize:11,color:'#aaa',whiteSpace:'nowrap'}}>saved: {fmt$(s.price)}</span>}
                  </div>
                );
              })
          }
        </div>
      ))}
    </div>
  );
}

