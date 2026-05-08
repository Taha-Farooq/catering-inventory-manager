import React, { useState, useMemo, useId, useRef, useEffect } from 'react';
import * as XLSX from 'xlsx';
import { showToast } from '../toastContext.jsx';
import Modal from '../ui/Modal.jsx';
import Confirm from '../ui/Confirm.jsx';
import { CATEGORIES, LOCATIONS, CUSTOM_CATEGORIES_KEY, INTERNAL_SELLER_NAME_KEYS, PURCHASE_UNITS, CASE_UNITS } from '../constants.js';
import { fmt$, fmtDate, sellerKey, uniqSuggestions, safePrice } from '../formatters.js';
import { load, save, uid, today } from '../utils/storage.js';
import { logActivity } from '../utils/activity.js';

const IMPORT_COL = {
  name: ['name','item name','item'],
  category: ['category','cat'],
  unit: ['unit','uom','unit of measure'],
  caseSize: ['case size', 'casesize', 'case_size', 'units per case'],
  upc: ['upc','barcode'],
  seller: ['seller','supplier','vendor'],
  price: ['price','unit price','cost','$/unit'],
  notes: ['notes','note'],
};
// Per-location qty/min columns are handled separately (dynamic per LOCATIONS)
function normalizeImportHeaders(headers) {
  const map = {};
  headers.forEach((h, i) => {
    const lc = String(h).toLowerCase().trim();
    for (const [key, aliases] of Object.entries(IMPORT_COL)) {
      if (aliases.includes(lc) && !(key in map)) { map[key] = i; break; }
    }
    // Per-location: e.g. "englewood_qty", "hackensack_min"
    LOCATIONS.forEach(loc => {
      const lcLoc = loc.toLowerCase();
      if (lc === lcLoc + '_qty' && !(`locQty_${lcLoc}` in map)) map[`locQty_${lcLoc}`] = i;
      if (lc === lcLoc + '_min' && !(`locMinQty_${lcLoc}` in map)) map[`locMinQty_${lcLoc}`] = i;
    });
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

export default function ItemDatabase({ items, setItems, priceHistory, setPriceHistory, userRole, purchaseInvoices = [] }) {
  const isAdmin = userRole === 'admin';
  const locQtyBlank = Object.fromEntries(LOCATIONS.map(l => [l.toLowerCase(), '']));
  const BLANK = {name:'',category:'Produce',upc:'',unit:'lb',caseSize:'',notes:'',sellers:[{name:'',price:''}],currentQty:'',minQty:'',locQty:{...locQtyBlank},locMinQty:{...locQtyBlank}};
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
  const [purchaseSuggest, setPurchaseSuggest] = useState(null); // { count, avgQty, suggested }
  const [historyItem, setHistoryItem] = useState(null); // item or null
  const [filterLow, setFilterLow] = useState(false);
  const [sortCol, setSortCol] = useState('name');
  const [sortDir, setSortDir] = useState('asc'); // 'asc' | 'desc'
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [batchCategory, setBatchCategory] = useState('');

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
      if (filterLow && !isLowStock(i)) return false;
      const sellerNames = (i.sellers||[]).map(s=>(s.name||'').toLowerCase()).join(' ');
      return i.name.toLowerCase().includes(q)||i.category.toLowerCase().includes(q)||(i.upc||'').includes(q)||sellerNames.includes(q);
    });
  },[items,search,catFilter,filterLow]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      let av, bv;
      if (sortCol === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (sortCol === 'category') { av = (a.category || '').toLowerCase(); bv = (b.category || '').toLowerCase(); }
      else if (sortCol === 'unit') { av = (a.unit || '').toLowerCase(); bv = (b.unit || '').toLowerCase(); }
      else if (sortCol === 'stock') {
        // sum across all locations for sort key
        av = LOCATIONS.reduce((s, loc) => s + (parseFloat(a.locQty?.[loc.toLowerCase()]) || 0), 0);
        bv = LOCATIONS.reduce((s, loc) => s + (parseFloat(b.locQty?.[loc.toLowerCase()]) || 0), 0);
      } else if (sortCol === 'price') {
        av = a.sellers?.[0]?.price || 0;
        bv = b.sellers?.[0]?.price || 0;
      } else { av = 0; bv = 0; }
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
  }, [filtered, sortCol, sortDir]);

  function toggleSort(col) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('asc'); }
  }

  function toggleSelect(id) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleSelectAll() {
    if (selectedIds.size === sorted.length) setSelectedIds(new Set());
    else setSelectedIds(new Set(sorted.map(i => i.id)));
  }
  function applyBatchCategory() {
    if (!batchCategory || !selectedIds.size) return;
    const nextItems = items.map(it => selectedIds.has(it.id) ? { ...it, category: batchCategory } : it);
    setItems(nextItems);
    save('items', nextItems);
    showToast(`Updated category for ${selectedIds.size} item${selectedIds.size !== 1 ? 's' : ''}.`, 'success');
    setSelectedIds(new Set());
    setBatchCategory('');
  }

  useEffect(() => { setSelectedIds(new Set()); }, [search, catFilter]);

  function SortTh({ col, children }) {
    const active = sortCol === col;
    return (
      <th style={{cursor:'pointer',userSelect:'none',whiteSpace:'nowrap'}} onClick={() => toggleSort(col)}>
        {children} {active ? (sortDir === 'asc' ? '▲' : '▼') : <span style={{opacity:0.3}}>▲</span>}
      </th>
    );
  }

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
      caseSize: item.caseSize || '',
    });
    setEditId(item.id);
    setShowForm(true);
    // BL-45: compute reorder suggestion from purchase history
    const matches = purchaseInvoices.flatMap(inv =>
      (inv.lineItems || []).filter(l => (l.description || '').toLowerCase() === item.name.toLowerCase())
    );
    if (matches.length >= 2) {
      const totalQty = matches.reduce((s, l) => s + (parseFloat(l.quantity) || 0), 0);
      const avgQty = totalQty / matches.length;
      const suggested = Math.max(1, Math.round(avgQty * 0.5));
      setPurchaseSuggest({ count: matches.length, avgQty: +avgQty.toFixed(1), suggested });
    } else {
      setPurchaseSuggest(null);
    }
  }
  function duplicateItem(item) {
    const sellers = (item.sellers || []).map(s => ({ ...s }));
    const locQtyBlank2 = Object.fromEntries(LOCATIONS.map(l => [l.toLowerCase(), '']));
    setForm({
      ...item, id: uid(), name: item.name + ' (Copy)',
      sellers: sellers.length ? sellers : [{ name: '', price: '' }],
      locQty: { ...locQtyBlank2 },
      locMinQty: { ...locQtyBlank2, ...(item.locMinQty || {}) },
      caseSize: item.caseSize || '',
      createdAt: today(),
    });
    setEditId(null);
    setPurchaseSuggest(null);
    setShowForm(true);
  }
  function setSeller(i,f2,v) { setForm(f=>{const s=[...f.sellers];s[i]={...s[i],[f2]:v};return{...f,sellers:s};}); }

  function saveItem() {
    if (!form.name.trim()) { showToast('Item name is required. [DMG-E006]', 'error'); return; }
    const sellers = [];
    const seenSellerKeys = new Set();
    for (const s of form.sellers) {
      const sellerName = (s.name || '').trim();
      const p = safePrice(s.price);
      if (!sellerName && p === null) continue; // skip completely empty rows
      if (s.price !== '' && p === null) { showToast(`Invalid price for "${sellerName || '(no seller)'}". Must be a positive number or left blank. [DMG-E006]`, 'error'); return; }
      if (seenSellerKeys.has(sellerName.toLowerCase())) { showToast(`Duplicate seller "${sellerName}" for this item. Use unique seller names. [DMG-E006]`, 'error'); return; }
      if (sellerName) seenSellerKeys.add(sellerName.toLowerCase());
      if (INTERNAL_SELLER_NAME_KEYS.has(sellerKey(sellerName))) { showToast(`"${sellerName}" looks like one of your own companies, not an external supplier. Please use the actual vendor name.`, 'warning'); return; }
      sellers.push({ name: sellerName, price: p });
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

  function downloadImportTemplate() {
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const headers = ['name','category','unit','case size','upc','seller','price',
      ...LOCATIONS.flatMap(l => [l.toLowerCase()+'_qty', l.toLowerCase()+'_min']),
      'notes'];
    const example = ['Chicken Breast','Meat','lb','','','Sysco','4.50',
      ...LOCATIONS.flatMap(() => ['','']),''];
    const csv = [headers.map(esc).join(','), example.map(esc).join(',')].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'items-import-template.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    showToast('Import template downloaded.');
  }

  function exportItemsCsv() {
    if (!items.length) { showToast('No items to export.', 'error'); return; }
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const headers = ['name','category','unit','case size','upc','seller','price',
      ...LOCATIONS.flatMap(l => [l.toLowerCase()+'_qty', l.toLowerCase()+'_min']),
      'notes'];
    const rows = items.map(item => {
      const first = Array.isArray(item.sellers) && item.sellers[0] ? item.sellers[0] : {};
      return [
        item.name, item.category, item.unit, item.caseSize || '', item.upc || '',
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

  function exportItemsExcel() {
    if (!items.length) { showToast('No items to export.', 'error'); return; }
    const wb = XLSX.utils.book_new();
    const mainHeader = ['Name','Category','Unit','Case Size','UPC',
      ...LOCATIONS.flatMap(l => [l+' Qty', l+' Min Qty']),
      'Notes'];
    const mainRows = items.map(item => [
      item.name, item.category, item.unit, item.caseSize || '', item.upc || '',
      ...LOCATIONS.flatMap(l => [
        item.locQty?.[l.toLowerCase()] ?? '',
        item.locMinQty?.[l.toLowerCase()] ?? '',
      ]),
      item.notes || '',
    ]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([mainHeader, ...mainRows]), 'Items');
    const sellersHeader = ['Item Name','Seller','Price'];
    const sellersRows = items.flatMap(item =>
      (item.sellers || []).map(s => [item.name, s.name || '', s.price != null ? +Number(s.price).toFixed(2) : ''])
    );
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([sellersHeader, ...sellersRows]), 'Sellers');
    XLSX.writeFile(wb, 'items-' + today() + '.xlsx');
    showToast(`Exported ${items.length} items as Excel.`);
    logActivity('export_items_xlsx', `Exported ${items.length} items`);
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
          const caseSizeRaw = colMap.caseSize !== undefined ? row[colMap.caseSize] : '';
          const caseSize = caseSizeRaw !== '' ? String(parseInt(caseSizeRaw) || '') : '';
          const upc = String(row[colMap.upc] ?? '').trim();
          const sellerName = colMap.seller !== undefined ? String(row[colMap.seller] ?? '').trim() : '';
          const rawPrice = colMap.price !== undefined ? row[colMap.price] : '';
          const price = rawPrice !== '' && rawPrice !== null ? safePrice(rawPrice) : null;
          const priceError = rawPrice !== '' && rawPrice !== null && price === null ? `Invalid price "${rawPrice}"` : null;
          const notes = colMap.notes !== undefined ? String(row[colMap.notes] ?? '').trim() : '';
          const locQty = {}, locMinQty = {};
          LOCATIONS.forEach(loc => {
            const lc = loc.toLowerCase();
            const qKey = `locQty_${lc}`, mKey = `locMinQty_${lc}`;
            if (colMap[qKey] !== undefined) { const v = String(row[colMap[qKey]] ?? '').trim(); if (v !== '') locQty[lc] = v; }
            if (colMap[mKey] !== undefined) { const v = String(row[colMap[mKey]] ?? '').trim(); if (v !== '') locMinQty[lc] = v; }
          });
          const existing = items.find(it => it.name.toLowerCase() === name.toLowerCase());
          return { rowNum: i + 2, name, category, unit, caseSize, upc, sellerName, price, notes, locQty, locMinQty, status: existing ? 'update' : 'add', existingId: existing?.id ?? null, error: priceError };
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
          const mergedLocQty = { ...(it.locQty || {}), ...r.locQty };
          const mergedLocMinQty = { ...(it.locMinQty || {}), ...r.locMinQty };
          return { ...it, sellers: mergedSellers, locQty: mergedLocQty, locMinQty: mergedLocMinQty, ...(r.notes ? { notes: r.notes } : {}) };
        });
        updated++;
      } else if (r.status === 'add') {
        const locQtyBlank3 = Object.fromEntries(LOCATIONS.map(l => [l.toLowerCase(), '']));
        nextItems = [...nextItems, { id: uid(), name: r.name, category: r.category, unit: r.unit, caseSize: r.caseSize || '', upc: r.upc, sellers: seller, currentQty: '', minQty: '', locQty: { ...locQtyBlank3, ...r.locQty }, locMinQty: { ...locQtyBlank3, ...r.locMinQty }, notes: r.notes || '', createdAt: today() }];
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
              <Btn className="btn-outline" onClick={exportItemsCsv}>⬇ CSV</Btn>
              <Btn className="btn-outline" onClick={exportItemsExcel}>⬇ Excel</Btn>
              <input ref={importFileRef} type="file" accept=".csv,.xlsx,.xls" style={{display:'none'}}
                onChange={e => { const f = e.target.files?.[0]; if (f) handleImportFile(f); }} />
              <Btn className="btn-outline" onClick={() => importFileRef.current?.click()}>⬆ Import CSV</Btn>
              <Btn className="btn-outline" onClick={downloadImportTemplate} title="Download a blank CSV template with the correct column headers">📋 Template</Btn>
            </>
          )}
          <Btn className="btn-primary" onClick={()=>{setForm(blank());setEditId(null);setPurchaseSuggest(null);setShowForm(true);}}>＋ Add New Item</Btn>
        </div>
      </div>
      <div className="flex gap-2 mb-4 flex-wrap">
        <input className="input" style={{flex:'3 1 200px'}} placeholder="Search by name, category, or UPC…" value={search} onChange={e=>setSearch(e.target.value)} />
        <select className="input" style={{flex:'1 1 130px'}} value={catFilter} onChange={e=>setCatFilter(e.target.value)}>
          <option value="">All categories</option>
          {allCategories.map(c=><option key={c}>{c}</option>)}
        </select>
        <Btn className={`btn-sm ${filterLow?'btn-danger':'btn-outline'}`} style={{alignSelf:'center',whiteSpace:'nowrap'}} onClick={()=>setFilterLow(v=>!v)}>
          {filterLow ? '⚠ Low Stock Only' : '⚠ Low Stock'}
        </Btn>
        {(search||catFilter||filterLow) && <Btn className="btn-outline btn-sm" style={{alignSelf:'center'}} onClick={()=>{setSearch('');setCatFilter('');setFilterLow(false);}}>✕ Clear</Btn>}
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
          <>
          {selectedIds.size > 0 && (
            <div style={{background:'#FFF0D4',border:'1px solid #EED9B0',borderRadius:8,padding:'10px 14px',marginBottom:12,display:'flex',alignItems:'center',gap:10,flexWrap:'wrap'}}>
              <span style={{fontWeight:600,color:'var(--brown)',fontSize:13}}>{selectedIds.size} item{selectedIds.size!==1?'s':''} selected</span>
              <select className="input" style={{width:'auto'}} value={batchCategory} onChange={e=>setBatchCategory(e.target.value)}>
                <option value="">Change category…</option>
                {allCategories.map(c=><option key={c} value={c}>{c}</option>)}
              </select>
              <button className="btn btn-outline btn-sm" onClick={applyBatchCategory} disabled={!batchCategory}>Apply</button>
              <button className="btn btn-sm" style={{background:'#eee',color:'#666',borderRadius:12,padding:'2px 10px',marginLeft:'auto'}} onClick={()=>setSelectedIds(new Set())}>✕ Clear selection</button>
            </div>
          )}
          <div className="card" style={{padding:0}}>
            <div className="tbl-wrap">
              <table>
                <thead><tr><th style={{width:36}}><input type="checkbox" checked={selectedIds.size === sorted.length && sorted.length > 0} onChange={toggleSelectAll} style={{cursor:'pointer'}} /></th><SortTh col="name">Name</SortTh><SortTh col="category">Category</SortTh><SortTh col="unit">Unit</SortTh><th>UPC</th><th>Notes</th><SortTh col="stock">Stock</SortTh><SortTh col="price">Sellers / Prices</SortTh>{isAdmin&&<th>Actions</th>}</tr></thead>
                <tbody>
                  {sorted.map(item=>(
                    <tr key={item.id} style={isLowStock(item)?{background:'#FFF5F5'}:{}}>
                      <td><input type="checkbox" checked={selectedIds.has(item.id)} onChange={() => toggleSelect(item.id)} style={{cursor:'pointer'}} /></td>
                      <td style={{fontWeight:600}}>
                        {item.name}
                        {isLowStock(item)&&<span title="At or below reorder point" style={{marginLeft:6,color:'#DC2626',fontSize:12}}>⚠ Low</span>}
                      </td>
                      <td><span style={{fontSize:11.5,background:'#FFF0D4',color:'var(--brown)',padding:'2px 7px',borderRadius:10}}>{item.category}</span></td>
                      <td>{item.unit}</td>
                      <td style={{fontFamily:'monospace',fontSize:12,color:'#888'}}>{item.upc||'—'}</td>
                      <td style={{maxWidth:150,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',fontSize:12,color:'#666'}} title={item.notes||''}>
                        {item.notes ? item.notes : <span style={{color:'#ddd'}}>—</span>}
                      </td>
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
                          <Btn className="btn-outline btn-sm" style={{marginRight:5}} onClick={() => setHistoryItem(item)}>History</Btn>
                          <Btn className="btn-outline btn-sm" style={{marginRight:5}} onClick={()=>duplicateItem(item)} title="Duplicate this item">⧉</Btn>
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
          </>
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
          <div className="field">
            <label>Unit of Measure</label>
            <div style={{display:'flex',gap:6,alignItems:'center'}}>
              <select className="input" style={{flex:'0 0 auto',width:'auto'}} value={PURCHASE_UNITS.includes(form.unit)?form.unit:'custom'} onChange={e=>{if(e.target.value!=='custom')setForm(f=>({...f,unit:e.target.value}));else setForm(f=>({...f,unit:''}));}}>
                {PURCHASE_UNITS.map(u=><option key={u} value={u}>{u}</option>)}
                <option value="custom">custom…</option>
              </select>
              {!PURCHASE_UNITS.includes(form.unit)&&<input className="input" style={{flex:1}} placeholder="e.g. flat, tray…" value={form.unit} onChange={e=>setForm(f=>({...f,unit:e.target.value}))} />}
            </div>
          </div>
          <FI label="UPC Code (optional)" value={form.upc} onChange={e=>setForm(f=>({...f,upc:e.target.value}))} placeholder="Barcode" />
        </div>
        {CASE_UNITS.has(form.unit)&&(
          <div className="field">
            <label>Case Size <span style={{fontWeight:400,color:'#888',fontSize:12}}>(units per case)</span></label>
            <input className="input" type="number" min="1" step="1" placeholder="e.g. 12" value={form.caseSize||''} onChange={e=>setForm(f=>({...f,caseSize:e.target.value}))} />
          </div>
        )}
        {purchaseSuggest && (
          <div style={{background:'#F0FDF4',border:'1px solid #BBF7D0',borderRadius:6,padding:'9px 14px',marginBottom:12,fontSize:13,display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
            <span>📊 Based on <strong>{purchaseSuggest.count} purchases</strong> (avg <strong>{purchaseSuggest.avgQty} {form.unit}</strong>/order) — suggested reorder point: <strong>{purchaseSuggest.suggested} {form.unit}</strong></span>
            <Btn className="btn-outline btn-sm" onClick={() => {
              const suggested = String(purchaseSuggest.suggested);
              setForm(f => ({ ...f, locMinQty: Object.fromEntries(LOCATIONS.map(l => [l.toLowerCase(), suggested])) }));
            }}>Use suggestion</Btn>
          </div>
        )}
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
              <input className="input" placeholder={`$/  ${form.unit||'unit'} (blank=unknown)`} type="number" min="0" step="0.01" value={s.price} onChange={e=>setSeller(i,'price',e.target.value)} style={{flex:1}} />
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

      <Modal open={!!historyItem} onClose={() => setHistoryItem(null)} title={`History: ${historyItem?.name}`} wide>
        {historyItem && (() => {
          const purchaseLines = purchaseInvoices.flatMap(inv =>
            (inv.lineItems || [])
              .filter(l => (l.description || '').toLowerCase() === historyItem.name.toLowerCase())
              .map(l => ({ invId: inv.id, supplier: inv.supplier, date: inv.date, qty: l.qty ?? l.quantity, unit: l.unit, price: l.unitPrice ?? l.price }))
          ).sort((a, b) => b.date?.localeCompare(a.date) || 0);

          const adjustments = load('_inventoryAdjustments', [])
            .filter(a => a.itemId === historyItem.id || a.itemName?.toLowerCase() === historyItem.name.toLowerCase())
            .sort((a, b) => b.date?.localeCompare(a.date) || 0);

          return (
            <>
              <div style={{marginBottom:20}}>
                <div style={{fontWeight:700,fontSize:14,marginBottom:10,color:'var(--brown)'}}>Purchase History</div>
                {purchaseLines.length === 0
                  ? <div style={{color:'#888',fontSize:13}}>No purchase invoice lines found for this item.</div>
                  : (
                    <div className="tbl-wrap">
                      <table>
                        <thead><tr><th>Date</th><th>Supplier</th><th>Invoice#</th><th>Qty</th><th>Unit</th><th>Unit Price</th></tr></thead>
                        <tbody>
                          {purchaseLines.map((l, i) => (
                            <tr key={i}>
                              <td style={{fontSize:13}}>{fmtDate(l.date)}</td>
                              <td style={{fontSize:13}}>{l.supplier || '—'}</td>
                              <td style={{fontSize:12,fontFamily:'monospace',color:'#888'}}>{l.invId || '—'}</td>
                              <td style={{fontSize:13}}>{l.qty ?? '—'}</td>
                              <td style={{fontSize:13}}>{l.unit || '—'}</td>
                              <td style={{fontSize:13}}>{l.price != null ? fmt$(l.price) : '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )
                }
              </div>
              <div>
                <div style={{fontWeight:700,fontSize:14,marginBottom:10,color:'var(--brown)'}}>Stock Adjustments</div>
                {adjustments.length === 0
                  ? <div style={{color:'#888',fontSize:13}}>No adjustment log entries for this item.</div>
                  : (
                    <div className="tbl-wrap">
                      <table>
                        <thead><tr><th>Date</th><th>Location</th><th>Change</th><th>Reason</th><th>Notes</th></tr></thead>
                        <tbody>
                          {adjustments.map((a, i) => {
                            const delta = parseFloat(a.delta ?? a.change ?? 0);
                            const isPos = delta > 0;
                            return (
                              <tr key={i}>
                                <td style={{fontSize:13}}>{fmtDate(a.date)}</td>
                                <td style={{fontSize:13}}>{a.location || a.loc || '—'}</td>
                                <td style={{fontSize:13,fontWeight:700,color:isPos ? '#16A34A' : '#DC2626'}}>{isPos ? '+' : ''}{delta}</td>
                                <td style={{fontSize:13}}>{a.reason || '—'}</td>
                                <td style={{fontSize:13,color:'#888'}}>{a.notes || '—'}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )
                }
              </div>
            </>
          );
        })()}
      </Modal>

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

