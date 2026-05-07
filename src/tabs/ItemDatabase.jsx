import React, { useState, useMemo } from 'react';
import { showToast } from '../toastContext.jsx';
import Modal from '../ui/Modal.jsx';
import { CATEGORIES, INTERNAL_SELLER_NAME_KEYS } from '../constants.js';
import { fmt$, sellerKey, uniqSuggestions, safePrice } from '../formatters.js';
import { save, uid, today } from '../utils/storage.js';
import { logActivity } from '../utils/activity.js';

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
  const BLANK = {name:'',category:'Produce',upc:'',unit:'lb',notes:'',sellers:[{name:'',price:''}]};
  const blank = () => ({...BLANK, sellers:[{name:'',price:''}]});
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(blank());
  const [confirmId, setConfirmId] = useState(null);

  const sellerSuggestions = useMemo(()=>uniqSuggestions(...items.flatMap(i=>(i.sellers||[]).map(s=>s.name))),[items]);
  const unitSuggestions = useMemo(()=>uniqSuggestions(...items.map(i=>i.unit)),[items]);
  const itemNameSuggestions = useMemo(()=>uniqSuggestions(...items.map(i=>i.name)),[items]);

  const filtered = useMemo(()=>{
    const q=search.toLowerCase();
    return items.filter(i=>i.name.toLowerCase().includes(q)||i.category.toLowerCase().includes(q)||(i.upc||'').includes(q));
  },[items,search]);

  const pendingDeleteItem = useMemo(
    () => (confirmId ? items.find((i) => i.id === confirmId) : null),
    [confirmId, items]
  );

  function openEdit(item) {
    const sellers = Array.isArray(item.sellers) ? item.sellers : [];
    setForm({...item,sellers:sellers.length ? sellers.map(s=>({...s})) : [{name:'',price:''}]});
    setEditId(item.id);
    setShowForm(true);
  }
  function setSeller(i,f2,v) { setForm(f=>{const s=[...f.sellers];s[i]={...s[i],[f2]:v};return{...f,sellers:s};}); }

  function saveItem() {
    if (!form.name.trim()) { showToast('Item name is required.', 'error'); return; }
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
      if (seenSellerKeys.has(sk)) { showToast(`Duplicate seller "${sellerName}" for this item. Use unique seller names.`, 'error'); return; }
      seenSellerKeys.add(sk);
      const p = safePrice(s.price);
      if (s.price!==''&&p===null) { showToast(`Invalid price for "${sellerName}". Must be a positive number or left blank.`, 'error'); return; }
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

  return (
    <div>
      <div className="flex-between mb-4 flex-wrap gap-2">
        <div className="section-title" style={{margin:0}}>Item Database ({items.length})</div>
        <div className="flex gap-2">
          {isAdmin && <Btn className="btn-outline" onClick={cleanupInternalSellers}>🧹 Clean Seller List</Btn>}
          <Btn className="btn-primary" onClick={()=>{setForm(blank());setEditId(null);setShowForm(true);}}>＋ Add New Item</Btn>
        </div>
      </div>
      <input className="input mb-4" placeholder="Search by name, category, or UPC…" value={search} onChange={e=>setSearch(e.target.value)} />
      {!isAdmin && <div style={{background:'#dbeafe',color:'#1d4ed8',padding:'8px 14px',borderRadius:5,marginBottom:14,fontSize:13}}>💡 Tip: You can add new items using the button above. To edit or delete items, contact your admin.</div>}

      {filtered.length===0
        ? <div className="card empty-state">{items.length===0?'No items yet. Click "Add Item" to get started.':'No items match your search.'}</div>
        : (
          <div className="card" style={{padding:0}}>
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>Name</th><th>Category</th><th>Unit</th><th>UPC</th><th>Sellers / Prices</th>{isAdmin&&<th>Actions</th>}</tr></thead>
                <tbody>
                  {filtered.map(item=>(
                    <tr key={item.id}>
                      <td style={{fontWeight:600}}>{item.name}</td>
                      <td><span style={{fontSize:11.5,background:'#FFF0D4',color:'var(--brown)',padding:'2px 7px',borderRadius:10}}>{item.category}</span></td>
                      <td>{item.unit}</td>
                      <td style={{fontFamily:'monospace',fontSize:12,color:'#888'}}>{item.upc||'—'}</td>
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
            {CATEGORIES.map(c=><option key={c}>{c}</option>)}
          </FS>
        </div>
        <div className="grid-2">
          <FI label="Unit of Measure" value={form.unit} onChange={e=>setForm(f=>({...f,unit:e.target.value}))} placeholder="lb, kg, each, case…" suggestions={unitSuggestions} />
          <FI label="UPC Code (optional)" value={form.upc} onChange={e=>setForm(f=>({...f,upc:e.target.value}))} placeholder="Barcode" />
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
    </div>
  );
}

