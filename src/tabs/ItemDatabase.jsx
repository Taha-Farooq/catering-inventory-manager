import React, { useState, useMemo, useId, useRef } from 'react';
import * as XLSX from 'xlsx';
import { showToast } from '../toastContext.jsx';
import Modal from '../ui/Modal.jsx';
import Confirm from '../ui/Confirm.jsx';
import { CATEGORIES, LOCATIONS, CUSTOM_CATEGORIES_KEY, INTERNAL_SELLER_NAME_KEYS } from '../constants.js';
import { fmt$, sellerKey, uniqSuggestions, safePrice } from '../formatters.js';
import { load, save, uid, today } from '../utils/storage.js';
import { logActivity } from '../utils/activity.js';

const IMPORT_COL = {
  name: ['name','item name','item'],
  category: ['category','cat'],
  unit: ['unit','uom','unit of measure'],
  upc: ['upc','barcode'],
  seller: ['seller','supplier','vendor'],
  price: ['price','unit price','cost','$/unit'],
};
function normalizeImportHeaders(headers) {
  const map = {};
  headers.forEach((h, i) => {
    const lc = String(h).toLowerCase().trim();
    for (const [key, aliases] of Object.entries(IMPORT_COL)) {
      if (aliases.includes(lc) && !(key in map)) { map[key] = i; break; }
    }
  });
  return map;
}

function FI({ label, suggestions, fieldStyle, ...props }) {
  const listId = useId();
  const hasSuggestions = Array.isArray(suggestions) && suggestions.length > 0;
  const baseFieldStyle = label ? {} : { marginBottom: 0 };
  return (
    <div className="field" style={{ ...baseFieldStyle, ...fieldStyle }}>
      {label&&<label>{label}</label>}
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
  return <div className="field">{label&&<label>{label}</label>}<select className="input" {...props}>{children}</select></div>;
}
function Btn({ className='', children, ...p }) {
  return <button className={`btn ${className}`} {...p}>{children}</button>;
}

export default function ItemDatabase({ items, setItems, priceHistory, setPriceHistory, userRole }) {
  const isAdmin = userRole === 'admin';
  const locQtyBlank = Object.fromEntries(LOCATIONS.map(l => [l.toLowerCase(), '']));
  const BLANK = {name:'',category:'Produce',upc:'',unit:'lb',notes:'',sellers:[{name:'',price:''}],currentQty:'',minQty:'',locQty:{...locQtyBlank},locMinQty:{...locQtyBlank}};
  const blank = () => ({...BLANK, sellers:[{name:'',price:''}]});
  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(blank());
  const [confirmId, setConfirmId] = useState(null);
  const [importRows, setImportRows] = useState([]);
  const [showImport, setShowImport] = useState(false);
  const importFileRef = useRef(null);

  const allCategories = useMemo(() => {
    const custom = load(CUSTOM_CATEGORIES_KEY, []);
    const merged = [...CATEGORIES];
    custom.forEach(c => { if (c && !merged.includes(c)) merged.push(c); });
    return merged;
  }, []);

  const sellerSuggestions = useMemo(()=>uniqSuggestions(...items.flatMap(i=>(i.sellers||[]).map(s=>s.name))),[items]);
  const unitSuggestions = useMemo(()=>uniqSuggestions(...items.map(i=>i.unit)),[items]);
  const itemNameSuggestions = useMemo(()=>uniqSuggestions(...items.map(i=>i.name)),[items]);

  const isLowStock = (item) => {
    const cur = parseFloat(item.currentQty);
    const min = parseFloat(item.minQty);
    if (!isNaN(cur) && !isNaN(min) && cur <= min) return true;
    return LOCATIONS.some(loc => {
      const lc = loc.toLowerCase();
      const q = parseFloat(item.locQty?.[lc]);
      const m = parseFloat(item.locMinQty?.[lc]);
      return !isNaN(q) && !isNaN(m) && q <= m;
    });
  };
  const lowStockCount = useMemo(() => items.filter(isLowStock).length, [items]);

  const filtered = useMemo(()=>{
    const q=search.toLowerCase();
    return items.filter(i=>{
      if (catFilter && i.category !== catFilter) return false;
      const sellerNames = (i.sellers||[]).map(s=>(s.name||'').toLowerCase()).join(' ');
      return i.name.toLowerCase().includes(q)||i.category.toLowerCase().includes(q)||(i.upc||'').includes(q)||sellerNames.includes(q);
    });
  },[items,search,catFilter]);

  const pendingDeleteItem = useMemo(
    () => (confirmId ? items.find((i) => i.id === confirmId) : null),
    [confirmId, items]
  );

  function openEdit(item) {
    const sellers = Array.isArray(item.sellers) ? item.sellers : [];
    const locQtyBlank2 = Object.fromEntries(LOCATIONS.map(l => [l.toLowerCase(), '']));
    setForm({...item,
      sellers: sellers.length ? sellers.map(s=>({...s})) : [{name:'',price:''}],
      locQty: { ...locQtyBlank2, ...(item.locQty || {}) },
      locMinQty: { ...locQtyBlank2, ...(item.locMinQty || {}) },
    });
    setEditId(item.id);
    setShowForm(true);
  }
  function setSeller(i,f2,v) { setForm(f=>{const s=[...f.sellers];s[i]={...s[i],[f2]:v};return{...f,sellers:s};}); }

  function saveItem() {
    if (!form.name.trim()) { showToast('Item name is required. [DMG-E006]', 'error'); return; }
    const sellers = [];
    const seenSellerKeys = new Set();
    for (const s of form.sellers) {
      const sellerName = (s.name || '').trim();
      if (!sellerName) continue;
      const sk = sellerKey(sellerName);
      if (INTERNAL_SELLER_NAME_KEYS.has(sk)) {
        showToast(`"${sellerName}" looks like one of your own companies, not an external supplier. Please use the actual vendor name.`, 'warning');
        return;
      }
      if (seenSellerKeys.has(sk)) { showToast(`Duplicate seller "${sellerName}" for this item. Use unique seller names. [DMG-E006]`, 'error'); return; }
      seenSellerKeys.add(sk);
      const p = safePrice(s.price);
      if (s.price!==''&&p===null) { showToast(`Invalid price for "${sellerName}". Must be a positive number or left blank. [DMG-E006]`, 'error'); return; }
      sellers.push({name:sellerName,price:p});
    }
    if (editId) {
      const old = items.find(x=>x.id===editId);
      const newHist = [];
      sellers.forEach(s => {
        const prev=(old.sellers||[]).find(os=>sellerKey(os.name)===sellerKey(s.name));
        if (prev&&prev.price!==null&&s.price!==null&&prev.price!==s.price)
          newHist.push({id:uid(),itemId:editId,itemName:form.name,seller:s.name,oldPrice:prev.price,newPrice:s.price,date:today()});
      });
      if (newHist.length) { const u=[...priceHistory,...newHist]; setPriceHistory(u); save('priceHistory',u); }
      const u=items.map(x=>x.id===editId?{...x,...form,sellers}:x);
      setItems(u); save('items',u);
    } else {
      const u=[...items,{id:uid(),...form,sellers,createdAt:today()}];
      setItems(u); save('items',u);
    }
    setShowForm(false);
    logActivity(editId ? 'edit_item' : 'add_item', form.name);
    showToast(editId ? 'Item updated!' : 'Item added to database!');
  }

  function deleteItem(id) { const u=items.filter(x=>x.id!==id); setItems(u); save('items',u); setConfirmId(null); showToast('Item deleted.'); logActivity('delete_item','Deleted item'); }
  function cleanupInternalSellers() {
    let removed = 0;
    const next = items.map(it => {
      const sellers = Array.isArray(it.sellers) ? it.sellers : [];
      const filteredSellers = sellers.filter(s => {
        const keep = !INTERNAL_SELLER_NAME_KEYS.has(sellerKey(s?.name || ''));
        if (!keep) removed += 1;
        return keep;
      });
      return filteredSellers.length === sellers.length ? it : { ...it, sellers: filteredSellers };
    });
    if (!removed) { showToast('No internal company names found in sellers list.'); return; }
    setItems(next);
    save('items', next);
    logActivity('edit_item', `Cleaned ${removed} internal-name sellers from catalog`);
    showToast(`Removed ${removed} internal-name sellers from items.`);
  }

  function adjustLocQty(itemId, loc, delta) {
    const lc = loc.toLowerCase();
    const next = items.map(it => {
      if (it.id !== itemId) return it;
      const prev = parseFloat(it.locQty?.[lc]) || 0;
      const newQty = String(Math.max(0, +(prev + delta).toFixed(4)));
      return { ...it, locQty: { ...(it.locQty || {}), [lc]: newQty } };
    });
    setItems(next);
    save('items', next);
    const item = next.find(it => it.id === itemId);
    logActivity('edit_item', `Stock ${delta > 0 ? '+' : ''}${delta} ${loc}: ${item?.name}`);
  }

  function exportItemsCsv() {
    if (!items.length) { showToast('No items to export.', 'error'); return; }
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const headers = ['name','category','unit','upc','seller','price',
      ...LOCATIONS.flatMap(l => [l.toLowerCase()+'_qty', l.toLowerCase()+'_min']),
      'notes'];
    const rows = items.map(item => {
      const first = Array.isArray(item.sellers) && item.sellers[0] ? item.sellers[0] : {};
      return [
        item.name, item.category, item.unit, item.upc || '',
        first.name || '', first.price != null ? first.price : '',
        ...LOCATIONS.flatMap(l => [
          item.locQty?.[l.toLowerCase()] ?? '',
          item.locMinQty?.[l.toLowerCase()] ?? '',
        ]),
        item.notes || '',
      ];
    });
    const csv = [headers.map(esc).join(','), ...rows.map(r => r.map(esc).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'items-' + today() + '.csv';
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
    showToast(`Exported ${items.length} items as CSV.`);
    logActivity('export_items_csv', `Exported ${items.length} items`);
  }

  function handleImportFile(file) {
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const wb = XLSX.read(ev.target.result, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        if (raw.length < 2) { showToast('File is empty or has no data rows.', 'error'); return; }
        const colMap = normalizeImportHeaders(raw[0]);
        if (colMap.name === undefined) { showToast('Missing required column: "name". [DMG-E006]', 'error'); return; }
        const parsed = raw.slice(1).map((row, i) => {
          const name = String(row[colMap.name] ?? '').trim();
          if (!name) return { rowNum: i + 2, name: '', status: 'skip', error: 'Missing item name' };
          const rawCat = colMap.category !== undefined ? String(row[colMap.category] ?? '').trim() : '';
          const category = allCategories.includes(rawCat) ? rawCat : (rawCat ? 'Other' : 'Produce');
          const unit = String(row[colMap.unit] ?? 'each').trim() || 'each';
          const upc = String(row[colMap.upc] ?? '').trim();
          const sellerName = colMap.seller !== undefined ? String(row[colMap.seller] ?? '').trim() : '';
          const rawPrice = colMap.price !== undefined ? row[colMap.price] : '';
          const price = rawPrice !== '' && rawPrice !== null ? safePrice(rawPrice) : null;
          const priceError = rawPrice !== '' && rawPrice !== null && price === null ? `Invalid price "${rawPrice}"` : null;
          const existing = items.find(it => it.name.toLowerCase() === name.toLowerCase());
          return { rowNum: i + 2, name, category, unit, upc, sellerName, price, status: existing ? 'update' : 'add', existingId: existing?.id ?? null, error: priceError };
        }).filter(r => r.name || r.error);
        setImportRows(parsed);
        setShowImport(true);
      } catch {
        showToast('Could not parse file. Check format. [DMG-E006]', 'error');
      }
    };
    reader.readAsArrayBuffer(file);
  }

  function commitImport() {
    let added = 0, updated = 0, skipped = 0;
    let nextItems = [...items];
    importRows.forEach(r => {
      if (r.status === 'skip') { skipped++; return; }
      const seller = r.sellerName ? [{ name: r.sellerName, price: r.price }] : [];
      if (r.status === 'update' && r.existingId) {
        nextItems = nextItems.map(it => {
          if (it.id !== r.existingId) return it;
          const existingSellers = Array.isArray(it.sellers) ? it.sellers : [];
          const mergedSellers = [...existingSellers];
          seller.forEach(s => {
            const idx = mergedSellers.findIndex(es => sellerKey(es.name) === sellerKey(s.name));
            if (idx >= 0) mergedSellers[idx] = { ...mergedSellers[idx], ...s };
            else mergedSellers.push(s);
          });
          return { ...it, sellers: mergedSellers };
        });
        updated++;
      } else if (r.status === 'add') {
        const locQtyBlank3 = Object.fromEntries(LOCATIONS.map(l => [l.toLowerCase(), '']));
        nextItems = [...nextItems, { id: uid(), name: r.name, category: r.category, unit: r.unit, upc: r.upc, sellers: seller, currentQty: '', minQty: '', locQty: locQtyBlank3, locMinQty: locQtyBlank3, notes: '', createdAt: today() }];
        added++;
      }
    });
    setItems(nextItems);
    save('items', nextItems);
    logActivity('import_items', `Bulk import: +${added} added, ${updated} updated, ${skipped} skipped`);
    showToast(`Imported: ${added} added, ${updated} updated${skipped ? `, ${skipped} skipped` : ''}.`);
    setShowImport(false);
    setImportRows([]);
    if (importFileRef.current) importFileRef.current.value = '';
  }

  return (
    <div>
      <div className="flex-between mb-4 flex-wrap gap-2">
        <div className="section-title" style={{margin:0}}>Item Database ({items.length})</div>
        <div className="flex gap-2 flex-wrap">
          {isAdmin && <Btn className="btn-outline" onClick={cleanupInternalSellers}>🧹 Clean Seller List</Btn>}
          {isAdmin && (
            <>
              <Btn className="btn-outline" onClick={exportItemsCsv}>⬇ Export CSV</Btn>
              <input ref={importFileRef} type="file" accept=".csv,.xlsx,.xls" style={{display:'none'}}
                onChange={e => { const f = e.target.files?.[0]; if (f) handleImportFile(f); }} />
              <Btn className="btn-outline" onClick={() => importFileRef.current?.click()}>⬆ Import CSV</Btn>
            </>
          )}
          <Btn className="btn-primary" onClick={()=>{setForm(blank());setEditId(null);setShowForm(true);}}>＋ Add New Item</Btn>
        </div>
      </div>
      <div className="flex gap-2 mb-4 flex-wrap">
        <input className="input" style={{flex:'3 1 200px'}} placeholder="Search by name, category, or UPC…" value={search} onChange={e=>setSearch(e.target.value)} />
        <select className="input" style={{flex:'1 1 130px'}} value={catFilter} onChange={e=>setCatFilter(e.target.value)}>
          <option value="">All categories</option>
          {allCategories.map(c=><option key={c}>{c}</option>)}
        </select>
        {(search||catFilter) && <Btn className="btn-outline btn-sm" style={{alignSelf:'center'}} onClick={()=>{setSearch('');setCatFilter('');}}>✕ Clear</Btn>}
      </div>
      {!isAdmin && <div style={{background:'#dbeafe',color:'#1d4ed8',padding:'8px 14px',borderRadius:5,marginBottom:14,fontSize:13}}>💡 Tip: You can add new items using the button above. To edit or delete items, contact your admin.</div>}
      {lowStockCount > 0 && (
        <div style={{background:'#FEF2F2',color:'#991B1B',padding:'8px 14px',borderRadius:5,marginBottom:14,fontSize:13,display:'flex',alignItems:'center',gap:8}}>
          ⚠ <strong>{lowStockCount} item{lowStockCount!==1?'s':''} at or below reorder point.</strong> Stock levels shown in the table below.
        </div>
      )}

      {filtered.length===0
        ? <div className="card empty-state">{items.length===0?'No items yet. Click "Add Item" to get started.':'No items match your search.'}</div>
        : (
          <div className="card" style={{padding:0}}>
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>Name</th><th>Category</th><th>Unit</th><th>UPC</th><th>Stock</th><th>Sellers / Prices</th>{isAdmin&&<th>Actions</th>}</tr></thead>
                <tbody>
                  {filtered.map(item=>(
                    <tr key={item.id} style={isLowStock(item)?{background:'#FFF5F5'}:{}}>
                      <td style={{fontWeight:600}}>
                        {item.name}
                        {isLowStock(item)&&<span title="At or below reorder point" style={{marginLeft:6,color:'#DC2626',fontSize:12}}>⚠ Low</span>}
                      </td>
                      <td><span style={{fontSize:11.5,background:'#FFF0D4',color:'var(--brown)',padding:'2px 7px',borderRadius:10}}>{item.category}</span></td>
                      <td>{item.unit}</td>
                      <td style={{fontFamily:'monospace',fontSize:12,color:'#888'}}>{item.upc||'—'}</td>
                      <td style={{fontSize:12}}>
                        {LOCATIONS.map(loc => {
                          const lc = loc.toLowerCase();
                          const qty = item.locQty?.[lc];
                          const minQ = item.locMinQty?.[lc];
                          if (qty === '' || qty == null) return null;
                          const isLocLow = minQ !== '' && minQ != null && parseFloat(qty) <= parseFloat(minQ);
                          return (
                            <div key={loc} style={{display:'flex',alignItems:'center',gap:3,marginBottom:1}}>
                              <span style={{color:'#888',fontSize:11,minWidth:64}}>{loc}:</span>
                              <span style={{color:isLocLow?'#DC2626':'#16A34A',fontWeight:600}}>{qty}</span>
                              {minQ !== '' && minQ != null && <span style={{color:'#999',fontSize:10}}>/min {minQ}</span>}
                              {isLocLow && <span title="Low stock" style={{color:'#DC2626',fontSize:10}}>⚠</span>}
                              {isAdmin && <>
                                <button title={`Remove 1 from ${loc}`} onClick={()=>adjustLocQty(item.id,loc,-1)} style={{marginLeft:4,padding:'0 5px',fontSize:13,lineHeight:'16px',border:'1px solid #ddd',borderRadius:3,cursor:'pointer',background:'#fff',color:'#555'}}>−</button>
                                <button title={`Add 1 to ${loc}`} onClick={()=>adjustLocQty(item.id,loc,+1)} style={{padding:'0 5px',fontSize:13,lineHeight:'16px',border:'1px solid #ddd',borderRadius:3,cursor:'pointer',background:'#fff',color:'#555'}}>+</button>
                              </>}
                            </div>
                          );
                        })}
                        {LOCATIONS.every(loc => (item.locQty?.[loc.toLowerCase()] === '' || item.locQty?.[loc.toLowerCase()] == null)) && (
                          item.currentQty !== '' && item.currentQty != null
                            ? <span style={{color:isLowStock(item)?'#DC2626':'#16A34A',fontWeight:600,whiteSpace:'nowrap'}}>{item.currentQty} {item.unit}</span>
                            : <span style={{color:'#bbb'}}>—</span>
                        )}
                        {LOCATIONS.every(loc => (item.locQty?.[loc.toLowerCase()] === '' || item.locQty?.[loc.toLowerCase()] == null)) && item.minQty !== '' && item.minQty != null && (
                          <span style={{color:'#888',fontSize:11}}> / min {item.minQty}</span>
                        )}
                      </td>
                      <td>
                        {(item.sellers||[]).map((s,i)=>(
                          <div key={i} style={{fontSize:13,lineHeight:1.8}}>
                            <strong style={{color:'var(--brown)'}}>{s.name}</strong>
                            {s.price!==null&&s.price!==undefined
                              ?<span style={{color:'#555'}}> — {fmt$(s.price)}/{item.unit}</span>
                              :<span style={{color:'#bbb'}}> — no price</span>}
                          </div>
                        ))}
                      </td>
                      {isAdmin&&(
                        <td style={{whiteSpace:'nowrap'}}>
                          <Btn className="btn-secondary btn-sm" style={{marginRight:5}} onClick={()=>openEdit(item)}>Edit</Btn>
                          <Btn className="btn-danger btn-sm" onClick={()=>setConfirmId(item.id)}>Delete</Btn>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      }

      <Modal open={showForm} onClose={()=>setShowForm(false)} title={editId?'Edit Item':'Add New Item'}>
        <div className="grid-2">
          <FI label="Item Name *" value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} placeholder="e.g. Chicken Breast" suggestions={itemNameSuggestions} />
          <FS label="Category" value={form.category} onChange={e=>setForm(f=>({...f,category:e.target.value}))}>
            {allCategories.map(c=><option key={c}>{c}</option>)}
          </FS>
        </div>
        <div className="grid-2">
          <FI label="Unit of Measure" value={form.unit} onChange={e=>setForm(f=>({...f,unit:e.target.value}))} placeholder="lb, kg, each, case…" suggestions={unitSuggestions} />
          <FI label="UPC Code (optional)" value={form.upc} onChange={e=>setForm(f=>({...f,upc:e.target.value}))} placeholder="Barcode" />
        </div>
        <div style={{border:'1px solid #EED9B0',borderRadius:8,padding:12,marginBottom:14}}>
          <div style={{fontWeight:700,color:'var(--brown)',marginBottom:10,fontSize:13}}>Stock by Location</div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
            {LOCATIONS.map(loc => {
              const lc = loc.toLowerCase();
              return (
                <div key={loc} style={{background:'#FFFBF2',padding:10,borderRadius:6,border:'1px solid #EED9B0'}}>
                  <div style={{fontWeight:600,color:'var(--brown)',marginBottom:6,fontSize:12}}>{loc}</div>
                  <div className="grid-2" style={{gap:6}}>
                    <FI label="Qty" type="number" min="0" step="any" value={form.locQty?.[lc]??''} onChange={e=>setForm(f=>({...f,locQty:{...f.locQty,[lc]:e.target.value}}))} placeholder="—" />
                    <FI label="Min" type="number" min="0" step="any" value={form.locMinQty?.[lc]??''} onChange={e=>setForm(f=>({...f,locMinQty:{...f.locMinQty,[lc]:e.target.value}}))} placeholder="—" />
                  </div>
                </div>
              );
            })}
          </div>
          <details style={{marginTop:8}}>
            <summary style={{fontSize:12,color:'#888',cursor:'pointer'}}>Overall stock (legacy)</summary>
            <div className="grid-2" style={{gap:6,marginTop:6}}>
              <FI label="Total Qty" type="number" min="0" step="any" value={form.currentQty??''} onChange={e=>setForm(f=>({...f,currentQty:e.target.value}))} placeholder="Leave blank if using per-location" />
              <FI label="Total Min Qty" type="number" min="0" step="any" value={form.minQty??''} onChange={e=>setForm(f=>({...f,minQty:e.target.value}))} placeholder="Alert threshold" />
            </div>
          </details>
        </div>
        <div style={{marginBottom:14}}>
          <div className="flex-between mb-2">
            <label style={{margin:0}}>Sellers &amp; Prices</label>
            <Btn className="btn-outline btn-sm" onClick={()=>setForm(f=>({...f,sellers:[...f.sellers,{name:'',price:''}]}))}>+ Seller</Btn>
          </div>
          {form.sellers.map((s,i)=>(
            <div key={i} className="flex gap-2 mb-2" style={{alignItems:'center'}}>
              <FI fieldStyle={{ flex: 2 }} suggestions={sellerSuggestions} placeholder="Seller name" value={s.name} onChange={e=>setSeller(i,'name',e.target.value)} />
              <input className="input" placeholder="Price (blank = unknown)" type="number" min="0" step="0.01" value={s.price} onChange={e=>setSeller(i,'price',e.target.value)} style={{flex:1}} />
              {form.sellers.length>1&&<Btn className="btn-danger btn-sm" onClick={()=>setForm(f=>({...f,sellers:f.sellers.filter((_,x)=>x!==i)}))}>✕</Btn>}
            </div>
          ))}
        </div>
        <div className="field">
          <label>Notes</label>
          <textarea className="input" rows={2} value={form.notes} onChange={e=>setForm(f=>({...f,notes:e.target.value}))} />
        </div>
        <div className="flex gap-2" style={{justifyContent:'flex-end',marginTop:8}}>
          <Btn className="btn-outline" onClick={()=>setShowForm(false)}>Cancel</Btn>
          <Btn className="btn-primary" onClick={saveItem}>Save Item</Btn>
        </div>
      </Modal>

      <Confirm
        open={!!confirmId}
        title="Delete item?"
        message={
          pendingDeleteItem
            ? `Remove "${pendingDeleteItem.name}" from the item database on this device?`
            : 'Remove this item from the item database on this device?'
        }
        detail="Lines on the shopping list that reference this item may need cleanup. Export a backup from Settings if unsure."
        dangerCode="DMG-E012 (local data change)"
        confirmLabel="Delete item"
        onConfirm={() => deleteItem(confirmId)}
        onCancel={() => setConfirmId(null)}
      />

      <Modal open={showImport} onClose={() => { setShowImport(false); setImportRows([]); if (importFileRef.current) importFileRef.current.value = ''; }} title="Import Items Preview" wide>
        {importRows.length > 0 && (() => {
          const adds = importRows.filter(r => r.status === 'add').length;
          const updates = importRows.filter(r => r.status === 'update').length;
          const skips = importRows.filter(r => r.status === 'skip').length;
          return (
            <>
              <div style={{background:'#F0FDF4',border:'1px solid #BBF7D0',borderRadius:6,padding:'10px 14px',marginBottom:14,fontSize:13}}>
                Will <strong style={{color:'#15803D'}}>add {adds}</strong> new item{adds!==1?'s':''}, <strong style={{color:'#1D4ED8'}}>update {updates}</strong> existing, <strong style={{color:'#9CA3AF'}}>skip {skips}</strong> rows with errors.
              </div>
              <div className="tbl-wrap" style={{maxHeight:380,overflowY:'auto',marginBottom:14}}>
                <table>
                  <thead><tr><th>Row</th><th>Name</th><th>Category</th><th>Unit</th><th>Seller</th><th>Price</th><th>Status</th></tr></thead>
                  <tbody>
                    {importRows.map(r => (
                      <tr key={r.rowNum}>
                        <td style={{color:'#aaa',fontSize:11}}>{r.rowNum}</td>
                        <td style={{fontWeight:600}}>{r.name||<span style={{color:'#bbb'}}>—</span>}</td>
                        <td style={{fontSize:12}}>{r.category||'—'}</td>
                        <td style={{fontSize:12}}>{r.unit||'—'}</td>
                        <td style={{fontSize:12}}>{r.sellerName||'—'}</td>
                        <td style={{fontSize:12}}>{r.price!=null?fmt$(r.price):'—'}</td>
                        <td>
                          {r.status==='add'&&<span style={{background:'#DCFCE7',color:'#15803D',padding:'2px 8px',borderRadius:10,fontSize:11,fontWeight:700}}>Add</span>}
                          {r.status==='update'&&<span style={{background:'#DBEAFE',color:'#1D4ED8',padding:'2px 8px',borderRadius:10,fontSize:11,fontWeight:700}}>Update</span>}
                          {r.status==='skip'&&<span title={r.error||''} style={{background:'#FEE2E2',color:'#DC2626',padding:'2px 8px',borderRadius:10,fontSize:11,fontWeight:700}}>Skip{r.error?` — ${r.error}`:''}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex gap-2" style={{justifyContent:'flex-end'}}>
                <Btn className="btn-outline" onClick={() => { setShowImport(false); setImportRows([]); if (importFileRef.current) importFileRef.current.value = ''; }}>Cancel</Btn>
                <Btn className="btn-primary" disabled={adds+updates===0} onClick={commitImport}>Import ({adds+updates} item{adds+updates!==1?'s':''})</Btn>
              </div>
            </>
          );
        })()}
      </Modal>
    </div>
  );
}

