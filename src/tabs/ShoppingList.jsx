import React, { useState, useMemo } from 'react';
import * as XLSX from 'xlsx';
import { LOCATIONS } from '../constants.js';
import { showToast } from '../toastContext.jsx';
import { reportError } from '../errors.js';
import { fmt$, safeQty } from '../formatters.js';
import { load, save, uid, today } from '../utils/storage.js';
import { logActivity } from '../utils/activity.js';

function Btn({ className='', children, ...p }) {
  return <button className={`btn ${className}`} {...p}>{children}</button>;
}

export default function ShoppingList({ items, shoppingList, setShoppingList }) {
  const [search, setSearch] = useState('');
  const [showDrop, setShowDrop] = useState(false);
  const [dragFromIdx, setDragFromIdx] = useState(null);
  const [dragOverIdx, setDragOverIdx] = useState(null);
  const [showClearListConfirm, setShowClearListConfirm] = useState(false);

  function reorderRows(from, to) {
    if (from === to) return;
    if (from < 0 || to < 0 || from >= shoppingList.length || to >= shoppingList.length) return;
    const next = [...shoppingList];
    const [row] = next.splice(from, 1);
    next.splice(to, 0, row);
    setShoppingList(next);
    save('shoppingList', next);
  }

  function upcForEntry(e) {
    const inv = items.find(i => i.id === e.itemId);
    const raw = String((inv && inv.upc != null ? inv.upc : e.upc) ?? '').trim();
    return raw || 'NOT-LISTED';
  }

  const results = useMemo(()=>{
    if (!search.trim()) return [];
    const q=search.toLowerCase();
    return items.filter(i=>i.name.toLowerCase().includes(q)||i.category.toLowerCase().includes(q)).slice(0,10);
  },[search,items]);

  function addItem(item) {
    const sellerList = Array.isArray(item.sellers) ? item.sellers : [];
    const sel=sellerList[0]||{name:'',price:null};
    const dup=shoppingList.find(s=>s.itemId===item.id&&s.selectedSeller===sel.name);
    if (dup) { updateQty(dup.id, dup.quantity+1); }
    else {
      const u=[...shoppingList,{id:uid(),itemId:item.id,itemName:item.name,unit:item.unit,upc:item.upc||'',
        selectedSeller:sel.name,price:sel.price,quantity:1,sellers:sellerList}];
      setShoppingList(u); save('shoppingList',u);
    }
    setSearch(''); setShowDrop(false);
  }

  function updateQty(id, raw) {
    const n=parseFloat(raw);
    if (isNaN(n)||n<0) return;
    const u=shoppingList.map(s=>s.id===id?{...s,quantity:n}:s);
    setShoppingList(u); save('shoppingList',u);
  }

  function changeSeller(id, name) {
    const e=shoppingList.find(s=>s.id===id);
    const sel=(e.sellers||[]).find(s=>s.name===name);
    const u=shoppingList.map(s=>s.id===id?{...s,selectedSeller:name,price:sel?.price??null}:s);
    setShoppingList(u); save('shoppingList',u);
  }

  function removeItem(id) { const u=shoppingList.filter(s=>s.id!==id); setShoppingList(u); save('shoppingList',u); }

  function addLowStockItems() {
    const lowStock = items.filter(i => {
      const cur = parseFloat(i.currentQty);
      const min = parseFloat(i.minQty);
      if (!isNaN(cur) && !isNaN(min) && cur <= min) return true;
      return LOCATIONS.some(loc => {
        const lc = loc.toLowerCase();
        const q = parseFloat(i.locQty?.[lc]);
        const m = parseFloat(i.locMinQty?.[lc]);
        return !isNaN(q) && !isNaN(m) && q <= m;
      });
    });
    if (!lowStock.length) { showToast('No items are currently at or below their reorder point.'); return; }
    let added = 0;
    let updated = 0;
    let nextList = [...shoppingList];
    lowStock.forEach(item => {
      const sellerList = Array.isArray(item.sellers) ? item.sellers : [];
      const sel = sellerList[0] || { name:'', price: null };
      const dup = nextList.find(s => s.itemId === item.id && s.selectedSeller === sel.name);
      if (dup) { updated++; return; }
      nextList = [...nextList, { id: uid(), itemId: item.id, itemName: item.name, unit: item.unit, upc: item.upc||'', selectedSeller: sel.name, price: sel.price, quantity: 1, sellers: sellerList }];
      added++;
    });
    setShoppingList(nextList);
    save('shoppingList', nextList);
    showToast(`Added ${added} low-stock item${added!==1?'s':''}${updated?` (${updated} already on list)`:''}.`);
  }

  function clearAll() {
    setShowClearListConfirm(true);
  }
  function confirmClearAll() {
    setShowClearListConfirm(false);
    setShoppingList([]); save('shoppingList',[]);
  }

  const grandTotal = useMemo(()=>shoppingList.reduce((s,e)=>s+safeQty(e.quantity)*(e.price??0),0),[shoppingList]);

  function exportXlsx() {
    if (!shoppingList.length) { showToast('Shopping list is empty.', 'error'); return; }
    try {
      const header = ['Item', 'UPC', 'Seller', 'Quantity', 'Unit', 'Unit Price', 'Total'];
      const dataRows = shoppingList.map((s) => {
        const upc = upcForEntry(s);
        const qty = safeQty(s.quantity);
        const unitPrice = s.price != null && Number.isFinite(Number(s.price)) ? +Number(s.price).toFixed(2) : '';
        const lineTotal =
          s.price != null && Number.isFinite(Number(s.price)) ? +(qty * Number(s.price)).toFixed(2) : '';
        return [s.itemName, upc, s.selectedSeller || '', qty, s.unit || '', unitPrice, lineTotal];
      });
      const grand = +grandTotal.toFixed(2);
      const aoa = [header, ...dataRows, ['', '', '', '', '', 'GRAND TOTAL', grand]];
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Shopping List');
      XLSX.writeFile(wb, 'shopping-list-' + today() + '.xlsx');
      showToast('Shopping list exported as Excel.');
      logActivity('export_xlsx', 'Exported shopping list Excel');
    } catch (e) {
      reportError('DMG-E041', { phase: 'shopping_xlsx', message: String(e?.message || e) });
      showToast('Excel export failed (DMG-E041). Try CSV export or retry.', 'error');
    }
  }

  function exportCsv() {
    if (!shoppingList.length) { showToast('Shopping list is empty.', 'error'); return; }
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = shoppingList.map(s => [
      s.itemName,
      upcForEntry(s),
      s.selectedSeller || '',
      safeQty(s.quantity),
      s.unit || '',
      (s.price ?? 0).toFixed(2),
      (safeQty(s.quantity) * (s.price ?? 0)).toFixed(2),
      s.notes || ''
    ]);
    const csv = [
      ['Item Name','UPC','Seller','Quantity','Unit','Unit Price','Total','Notes'].map(esc).join(','),
      ...rows.map(r => r.map(esc).join(','))
    ].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'shopping-list-' + today() + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('Shopping list exported as CSV.');
    logActivity('export_csv', 'Exported shopping list CSV');
  }

  return (
    <div>
      <div className="flex-between mb-4 flex-wrap gap-2">
        <div className="section-title" style={{margin:0}}>Shopping List ({shoppingList.length})</div>
        <div className="flex gap-2 flex-wrap">
          <Btn className="btn-outline btn-sm" onClick={addLowStockItems} title="Add all items at or below their reorder point">⚠ Low Stock</Btn>
          <Btn className="btn-outline" onClick={exportCsv}>⬇ Export CSV</Btn>
          <Btn className="btn-success" onClick={exportXlsx}>⬇ Export Excel</Btn>
          <Btn className="btn-danger" onClick={clearAll}>🗑 Clear All</Btn>
        </div>
      </div>
      {shoppingList.length > 0 && (
        <p className="text-muted" style={{marginTop:-8,marginBottom:12}}>Tip: Drag the ⋮⋮ handle on the left to reorder rows. Order is saved automatically.</p>
      )}

      <div className="card mb-4" style={{position:'relative',overflow:'visible'}}>
        <label>Search &amp; Add Items</label>
        <input className="input" placeholder="Type item name to search…" value={search}
          onChange={e=>{setSearch(e.target.value);setShowDrop(true);}}
          onFocus={()=>setShowDrop(true)} onBlur={()=>setTimeout(()=>setShowDrop(false),180)} />
        {showDrop && results.length>0 && (
          <div style={{position:'absolute',top:'100%',left:0,right:0,background:'white',border:'1.5px solid var(--border)',
            borderRadius:'0 0 6px 6px',boxShadow:'0 8px 24px rgba(0,0,0,.15)',zIndex:300}}>
            {results.map(item=>(
              <div key={item.id} onMouseDown={()=>addItem(item)}
                style={{padding:'10px 16px',cursor:'pointer',borderBottom:'1px solid #f5ead5',fontSize:14}}>
                <strong>{item.name}</strong>
                <span style={{color:'#999',fontSize:12,marginLeft:8}}>({item.category} · {item.unit})</span>
                {item.sellers[0]?.price!=null&&<span style={{color:'var(--brown)',float:'right',fontSize:12,fontWeight:600}}>{fmt$(item.sellers[0].price)}/{item.unit}</span>}
              </div>
            ))}
          </div>
        )}
        {showDrop&&search.trim()&&results.length===0&&(
          <div style={{position:'absolute',top:'100%',left:0,right:0,background:'white',border:'1.5px solid var(--border)',
            borderRadius:'0 0 6px 6px',padding:'12px 16px',color:'#aaa',fontSize:14}}>
            No items found. Add it in the Item Database tab first.
          </div>
        )}
      </div>

      {shoppingList.length===0
        ? <div className="card empty-state">Search for an item above and click to add it to your shopping list.</div>
        : (
          <>
            <div className="card" style={{padding:0}}>
              <div className="tbl-wrap">
                <table>
                  <thead><tr><th title="Drag to reorder" aria-label="Reorder" style={{width:36}}>⋮⋮</th><th>Item</th><th>UPC</th><th>Seller</th><th>Qty</th><th>Unit</th><th>Unit Price</th><th>Total</th><th></th></tr></thead>
                  <tbody>
                    {shoppingList.map((e, idx)=>{
                      const lt=safeQty(e.quantity)*(e.price??0);
                      const upcDisp = upcForEntry(e);
                      return (
                        <tr
                          key={e.id}
                          style={{
                            opacity: dragFromIdx === idx ? 0.55 : 1,
                            boxShadow: dragOverIdx === idx && dragFromIdx !== idx ? 'inset 0 0 0 2px var(--brown)' : undefined,
                            transition: 'opacity .12s ease'
                          }}
                          onDragOver={(ev) => {
                            ev.preventDefault();
                            ev.dataTransfer.dropEffect = 'move';
                            setDragOverIdx(idx);
                          }}
                          onDragLeave={(ev) => {
                            if (!ev.currentTarget.contains(ev.relatedTarget)) setDragOverIdx(null);
                          }}
                          onDrop={(ev) => {
                            ev.preventDefault();
                            const from = Number(ev.dataTransfer.getData('text/plain'));
                            if (Number.isNaN(from)) return;
                            reorderRows(from, idx);
                            setDragFromIdx(null);
                            setDragOverIdx(null);
                          }}
                        >
                          <td
                            className="shopping-drag-handle"
                            title="Drag to reorder"
                            draggable
                            onDragStart={(ev) => {
                              ev.dataTransfer.setData('text/plain', String(idx));
                              ev.dataTransfer.effectAllowed = 'move';
                              setDragFromIdx(idx);
                            }}
                            onDragEnd={() => { setDragFromIdx(null); setDragOverIdx(null); }}
                          >⋮⋮</td>
                          <td style={{fontWeight:600}}>{e.itemName}</td>
                          <td style={{fontFamily:'monospace',fontSize:12,color:upcDisp==='NOT-LISTED'?'#999':'#333'}}>{upcDisp}</td>
                          <td>
                            {(e.sellers||[]).length>1
                              ?<select className="input" style={{padding:'3px 6px',width:'auto',fontSize:13}} value={e.selectedSeller} onChange={ev=>changeSeller(e.id,ev.target.value)}>
                                {(e.sellers||[]).map(s=><option key={s.name} value={s.name}>{s.name}{s.price!=null?' ('+fmt$(s.price)+')':''}</option>)}
                              </select>
                              :<span>{e.selectedSeller||'—'}</span>}
                          </td>
                          <td>
                            <input type="number" className="input" style={{width:80,padding:'4px 8px'}} min="0" step="0.5"
                              value={e.quantity} onChange={ev=>updateQty(e.id,ev.target.value)} />
                          </td>
                          <td>{e.unit}</td>
                          <td>{e.price!=null?fmt$(e.price):<span style={{color:'#bbb'}}>—</span>}</td>
                          <td style={{fontWeight:600,color:'var(--brown)'}}>{e.price!=null?fmt$(lt):'—'}</td>
                          <td><Btn className="btn-danger btn-sm" onClick={()=>removeItem(e.id)}>✕</Btn></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="card" style={{textAlign:'right'}}>
              <span style={{fontSize:13,color:'#888',marginRight:16}}>{shoppingList.length} item{shoppingList.length!==1?'s':''}</span>
              <span style={{fontSize:20,fontWeight:700,color:'var(--brown)'}}>Total: {fmt$(grandTotal)}</span>
            </div>
          </>
        )
      }
      <Confirm
        open={showClearListConfirm}
        title="Clear shopping list?"
        message="Remove every line from the shopping list on this device."
        detail="You can rebuild the list from the Item Database. This only affects the shopping list, not invoices or inventory."
        dangerCode="DMG-E012 (local data change)"
        confirmLabel="Clear list"
        confirmClass="btn-danger"
        onConfirm={confirmClearAll}
        onCancel={() => setShowClearListConfirm(false)}
      />
    </div>
  );
}

