import React, { useState, useMemo, useId, useEffect } from 'react';
import * as XLSX from 'xlsx';
import { showToast } from '../toastContext.jsx';
import { BrandMark } from '../ui/BrandMark.jsx';
import Modal from '../ui/Modal.jsx';
import Confirm from '../ui/Confirm.jsx';
import { BUSINESSES, LOCATIONS, PURCHASE_UNITS, CASE_UNITS } from '../constants.js';
import { fmt$, fmtDate, safeQty, uniqSuggestions } from '../formatters.js';
import { save, uid, today } from '../utils/storage.js';
import { logActivity } from '../utils/activity.js';
import { printHtmlDocument } from '../utils/print.js';
import { moveToTrash } from '../utils/trash.js';
import { buildPurchaseInvoiceDoc } from '../utils/invoiceDoc.js';
import { nextId } from '../utils/invoiceIds.js';

function Toggle({ checked, onChange, label }) {
  return (
    <label style={{display:'flex',alignItems:'center',gap:8,cursor:'pointer',userSelect:'none',margin:0}}>
      <span className="toggle">
        <input type="checkbox" checked={checked} onChange={e=>onChange(e.target.checked)} />
        <span className="toggle-slider" />
      </span>
      <span style={{fontSize:13.5,color:'#5a3010'}}>{label}</span>
    </label>
  );
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
function Btn({ className='', children, ...p }) {
  return <button className={`btn ${className}`} {...p}>{children}</button>;
}

export default function PurchaseInvoices({ getInvoiceBranding, purchaseInvoices, setPurchaseInvoices, selectedBusiness, items = [], setItems, brandingMap, suppliers = [], initialSupplier, onConsumeInitialSupplier }) {
  const biz = BUSINESSES[selectedBusiness];
  const blankF = () => ({supplier:'',date:today(),dueDate:'',taxEnabled:false,notes:'',
    payment:{account:'',date:'',transactionId:''},
    lineItems:[{description:'',quantity:'',unit:'each',unitPrice:''}]});

  const descListId = useId();
  const unitLineListId = useId();

  const supplierSuggestions = useMemo(()=>uniqSuggestions(...purchaseInvoices.map(i=>i.supplier),...suppliers.map(s=>s.name)),[purchaseInvoices, suppliers]);
  const lineDescSuggestions = useMemo(()=>{
    const fromInv = purchaseInvoices.flatMap(i=>(i.lineItems||[]).map(l=>(l.description||'').trim()).filter(Boolean));
    const names = items.map(i=>i.name);
    return uniqSuggestions(...fromInv, ...names);
  },[purchaseInvoices, items]);
  const lineUnitSuggestions = useMemo(()=>uniqSuggestions(
    ...purchaseInvoices.flatMap(i=>(i.lineItems||[]).map(l=>l.unit).filter(Boolean)),
    ...items.map(i=>i.unit)
  ),[purchaseInvoices, items]);

  const [showForm, setShowForm] = useState(false);
  const [editingPurchaseId, setEditingPurchaseId] = useState(null);
  const [form, setForm] = useState(blankF());
  const [viewInv, setViewInv] = useState(null);
  const [confirmId, setConfirmId] = useState(null);
  const [stockUpdateInv, setStockUpdateInv] = useState(null);
  const [stockUpdateLoc, setStockUpdateLoc] = useState(LOCATIONS[1]);

  useEffect(() => {
    if (initialSupplier) {
      setForm(f => ({ ...blankF(), supplier: initialSupplier }));
      setEditingPurchaseId(null);
      setShowForm(true);
      if (onConsumeInitialSupplier) onConsumeInitialSupplier();
    }
  }, [initialSupplier]);

  function setLine(i, f2, v) {
    setForm(f => {
      const l = [...f.lineItems];
      const upd = { ...l[i], [f2]: v };
      if (f2 === 'description' && v) {
        const match = items.find(it => it.name.toLowerCase() === v.toLowerCase());
        if (match) {
          const sellers = Array.isArray(match.sellers) ? match.sellers : [];
          const supplierLc = (f.supplier || '').toLowerCase().trim();
          const sel = sellers.find(s => (s.name || '').toLowerCase().trim() === supplierLc) || sellers[0];
          if (sel?.price != null && sel.price > 0 && upd.unitPrice === '') upd.unitPrice = String(sel.price);
          if (match.unit && (upd.unit === 'each' || upd.unit === '')) upd.unit = match.unit;
          if (match.caseSize) upd._caseSize = match.caseSize;
        }
      }
      if (f2 === 'unit' && CASE_UNITS.has(v) && upd._caseSize && upd.unitPrice) {
        const pricePerUnit = parseFloat(upd.unitPrice);
        const cs = parseInt(upd._caseSize);
        if (!isNaN(pricePerUnit) && !isNaN(cs) && cs > 0) {
          upd.unitPrice = String(+(pricePerUnit * cs).toFixed(2));
        }
      }
      l[i] = upd;
      return { ...f, lineItems: l };
    });
  }

  function calcT(f,taxRate){
    const lines=f.lineItems.map(l=>{const q=safeQty(l.quantity),p=parseFloat(l.unitPrice)||0;return{...l,qty:q,price:p,total:q*p};});
    const sub=lines.reduce((s,l)=>s+l.total,0);
    const tax=f.taxEnabled?sub*taxRate:0;
    return{lines,sub,tax,total:sub+tax};
  }

  const T=calcT(form,biz.taxRate);

  const pendingDeletePurchase = useMemo(
    () => (confirmId ? purchaseInvoices.find((i) => i.id === confirmId) : null),
    [confirmId, purchaseInvoices]
  );

  function openPurchaseEdit(inv) {
    const lines = (inv.lineItems && inv.lineItems.length ? inv.lineItems : [{ description:'', quantity:'', unit:'each', unitPrice:'' }]).map((l) => ({
      description: l.description || '',
      quantity: String(l.qty ?? l.quantity ?? ''),
      unit: l.unit || 'each',
      unitPrice: String(l.price ?? l.unitPrice ?? ''),
    }));
    setForm({
      supplier: inv.supplier || '',
      date: inv.date || today(),
      dueDate: inv.dueDate || '',
      taxEnabled: !!inv.taxEnabled,
      notes: inv.notes || '',
      payment: {
        account: inv.payment?.account || '',
        date: inv.payment?.date || '',
        transactionId: inv.payment?.transactionId || '',
      },
      lineItems: lines,
    });
    setEditingPurchaseId(inv.id);
    setShowForm(true);
  }

  function copyInvoice(inv) {
    const lines = (inv.lineItems && inv.lineItems.length ? inv.lineItems : [{ description:'', quantity:'', unit:'each', unitPrice:'' }]).map((l) => ({
      description: l.description || '',
      quantity: String(l.qty ?? l.quantity ?? ''),
      unit: l.unit || 'each',
      unitPrice: String(l.price ?? l.unitPrice ?? ''),
    }));
    setForm({ supplier: inv.supplier || '', date: today(), dueDate:'', taxEnabled: !!inv.taxEnabled, notes: inv.notes || '', payment: { account:'', date:'', transactionId:'' }, lineItems: lines });
    setEditingPurchaseId(null);
    setViewInv(null);
    setShowForm(true);
    showToast('Invoice copied — review and save as new.');
  }

  function saveInvoice(){
    if (!form.supplier.trim()){showToast('Supplier name is required. [DMG-E006]','error');return;}
    const valid=T.lines.filter(l=>l.description.trim());
    if (!valid.length){showToast('Add at least one line item with a description. [DMG-E006]','error');return;}
    if (editingPurchaseId) {
      const prev = purchaseInvoices.find((i) => i.id === editingPurchaseId);
      if (!prev) { showToast('Invoice not found.', 'error'); return; }
      const inv = {
        ...prev,
        supplier: form.supplier,
        date: form.date,
        dueDate: form.dueDate,
        notes: form.notes,
        lineItems: valid,
        subtotal: T.sub,
        taxEnabled: form.taxEnabled,
        taxRate: biz.taxRate,
        taxAmount: T.tax,
        total: T.total,
        payment: { ...form.payment },
      };
      const u = purchaseInvoices.map((x) => (x.id === editingPurchaseId ? inv : x));
      setPurchaseInvoices(u);
      save('purchaseInvoices', u);
      setShowForm(false);
      setForm(blankF());
      setEditingPurchaseId(null);
      showToast('Purchase invoice updated.');
      logActivity('edit_item', 'Updated purchase invoice ' + inv.id);
      return;
    }
    const inv={id:nextId('purchase'),type:'purchase',business:selectedBusiness,
      supplier:form.supplier,date:form.date,dueDate:form.dueDate,notes:form.notes,
      lineItems:valid,subtotal:T.sub,taxEnabled:form.taxEnabled,taxRate:biz.taxRate,taxAmount:T.tax,
      total:T.total,status:'unpaid',payment:{...form.payment},createdAt:today()};
    const u=[...purchaseInvoices,inv]; setPurchaseInvoices(u); save('purchaseInvoices',u);
    setShowForm(false); setForm(blankF());
    showToast('Purchase invoice created.');
    logActivity('create_invoice', 'Created purchase invoice ' + inv.id);
  }

  function deleteInv(id){
    const removed = purchaseInvoices.find(x=>x.id===id);
    if (removed) moveToTrash('purchaseInvoices', `Purchase ${id} — ${removed.supplier || ''} (${fmt$(removed.total||0)})`, removed);
    const u=purchaseInvoices.filter(x=>x.id!==id);setPurchaseInvoices(u);save('purchaseInvoices',u);setConfirmId(null);
    showToast('Purchase invoice deleted. Restore it from Settings → Recently Deleted if needed.');
    logActivity('delete_invoice','Deleted purchase invoice '+id);
  }
  function markPaid(id) {
    const inv = purchaseInvoices.find(x => x.id === id);
    const paidDate = today();
    const u = purchaseInvoices.map(x => x.id === id ? {...x, status:'paid', paidAt: paidDate, payment: {...(x.payment||{}), date: x.payment?.date || paidDate}} : x);
    setPurchaseInvoices(u); save('purchaseInvoices', u);
    logActivity('mark_paid', 'Marked purchase invoice paid ' + id);
    // Back-propagate invoice unit prices to matching item sellers
    if (setItems && inv) {
      const supplierLc = (inv.supplier || '').toLowerCase().trim();
      let priceUpdates = 0;
      let nextItems = [...items];
      (inv.lineItems || []).forEach(l => {
        const desc = (l.description || '').trim();
        const price = parseFloat(l.unitPrice ?? l.price);
        if (!desc || isNaN(price) || price <= 0) return;
        const match = nextItems.find(it => it.name.toLowerCase() === desc.toLowerCase());
        if (!match) return;
        const sellers = Array.isArray(match.sellers) ? match.sellers.map(s => ({...s})) : [];
        const selIdx = supplierLc ? sellers.findIndex(s => (s.name||'').toLowerCase() === supplierLc) : -1;
        if (selIdx >= 0 && sellers[selIdx].price !== price) {
          sellers[selIdx] = { ...sellers[selIdx], price };
          priceUpdates++;
          nextItems = nextItems.map(it => it.id === match.id ? { ...it, sellers } : it);
        }
      });
      if (priceUpdates > 0) {
        setItems(nextItems);
        save('items', nextItems);
        showToast(`Marked paid. Updated prices for ${priceUpdates} item${priceUpdates!==1?'s':''}.`);
        return;
      }
    }
    showToast('Purchase invoice marked paid.');
  }

  function bulkMarkPaid() {
    if (!selectedIds.size) return;
    const toMark = purchaseInvoices.filter(i => selectedIds.has(i.id) && i.status !== 'paid');
    if (!toMark.length) { showToast('All selected invoices are already paid.'); setSelectedIds(new Set()); return; }
    let nextItems = [...items];
    let priceUpdates = 0;
    toMark.forEach(inv => {
      const supplierLc = (inv.supplier || '').toLowerCase().trim();
      (inv.lineItems || []).forEach(l => {
        const desc = (l.description || '').trim();
        const price = parseFloat(l.unitPrice ?? l.price);
        if (!desc || isNaN(price) || price <= 0) return;
        const matchIdx = nextItems.findIndex(it => it.name.toLowerCase() === desc.toLowerCase());
        if (matchIdx < 0) return;
        const match = nextItems[matchIdx];
        const sellers = Array.isArray(match.sellers) ? match.sellers.map(s => ({...s})) : [];
        const selIdx = supplierLc ? sellers.findIndex(s => (s.name||'').toLowerCase() === supplierLc) : -1;
        if (selIdx >= 0 && sellers[selIdx].price !== price) {
          sellers[selIdx] = { ...sellers[selIdx], price };
          priceUpdates++;
          nextItems = [...nextItems.slice(0, matchIdx), { ...match, sellers }, ...nextItems.slice(matchIdx + 1)];
        }
      });
    });
    const u = purchaseInvoices.map(i => selectedIds.has(i.id) && i.status !== 'paid' ? {...i, status: 'paid'} : i);
    setPurchaseInvoices(u); save('purchaseInvoices', u);
    if (priceUpdates > 0 && setItems) { setItems(nextItems); save('items', nextItems); }
    logActivity('bulk_mark_paid', `Bulk marked ${toMark.length} purchase invoices as paid${priceUpdates > 0 ? `, updated ${priceUpdates} prices` : ''}`);
    showToast(`${toMark.length} invoice${toMark.length !== 1 ? 's' : ''} marked paid${priceUpdates > 0 ? ` · ${priceUpdates} price${priceUpdates !== 1 ? 's' : ''} updated` : ''}.`);
    setSelectedIds(new Set());
  }

  function buildStockMatches(inv) {
    return (inv.lineItems || []).map(l => {
      const desc = (l.description || '').trim();
      const match = items.find(it => it.name.toLowerCase() === desc.toLowerCase());
      return { desc, qty: safeQty(l.qty ?? l.quantity), match };
    }).filter(r => r.qty > 0);
  }

  function openStockUpdate(inv) {
    const rows = buildStockMatches(inv);
    const init = {};
    rows.forEach((r, i) => { init[i] = String(r.qty); });
    setReceivedQtys(init);
    setStockUpdateInv(inv);
  }

  function commitStockUpdate() {
    if (!stockUpdateInv || !setItems) return;
    const lc = stockUpdateLoc.toLowerCase();
    const rows = buildStockMatches(stockUpdateInv);
    const matched = rows.filter(r => r.match);
    let nextItems = [...items];
    let count = 0;
    matched.forEach((r, i) => {
      const rcv = parseFloat(receivedQtys[rows.indexOf(r)]);
      if (isNaN(rcv) || rcv <= 0) return;
      nextItems = nextItems.map(it => {
        if (it.id !== r.match.id) return it;
        const locQty = { ...it.locQty };
        const prev = parseFloat(locQty[lc]) || 0;
        locQty[lc] = String(+(prev + rcv).toFixed(4));
        count++;
        return { ...it, locQty };
      });
    });
    if (count === 0) { showToast('No items to update (all received quantities are 0).', 'error'); return; }
    setItems(nextItems);
    save('items', nextItems);
    logActivity('update_stock_from_invoice', `Stock update from ${stockUpdateInv.id}: +${count} items at ${stockUpdateLoc}`);
    showToast(`Updated stock for ${count} item${count !== 1 ? 's' : ''} at ${stockUpdateLoc}.`);
    setStockUpdateInv(null);
  }

  const [showAllBiz, setShowAllBiz] = useState(false);
  const [filterStatus, setFilterStatus] = useState('all');
  const [filterSupplier, setFilterSupplier] = useState('');
  const [filterDateFrom, setFilterDateFrom] = useState('');
  const [filterDateTo, setFilterDateTo] = useState('');
  const [receivedQtys, setReceivedQtys] = useState({});
  const [selectedIds, setSelectedIds] = useState(new Set());
  useEffect(() => { setSelectedIds(new Set()); }, [filterStatus, filterSupplier, filterDateFrom, filterDateTo, showAllBiz]);

  const visiblePurchase = useMemo(() => {
    let list = showAllBiz ? [...purchaseInvoices] : purchaseInvoices.filter(i => !i.business || i.business === selectedBusiness);
    if (filterStatus !== 'all') list = list.filter(i => i.status === filterStatus);
    if (filterSupplier.trim()) {
      const q = filterSupplier.toLowerCase();
      list = list.filter(i => (i.supplier || '').toLowerCase().includes(q));
    }
    if (filterDateFrom) list = list.filter(i => (i.date || '') >= filterDateFrom);
    if (filterDateTo) list = list.filter(i => (i.date || '') <= filterDateTo);
    return [...list].reverse();
  }, [purchaseInvoices, showAllBiz, selectedBusiness, filterStatus, filterSupplier, filterDateFrom, filterDateTo]);

  const outstandingTotal = useMemo(() =>
    purchaseInvoices.filter(i => i.status !== 'paid').reduce((s, i) => s + (i.total || 0), 0),
    [purchaseInvoices]
  );

  function exportExcel() {
    if (!visiblePurchase.length) { showToast('No invoices to export.', 'error'); return; }
    try {
      const header = ['Invoice#', 'Supplier', 'Date', 'Due Date', 'Business', 'Status', 'Subtotal', 'Tax', 'Total', 'Notes'];
      const rows = visiblePurchase.map(inv => [
        inv.id, inv.supplier, inv.date, inv.dueDate || '', inv.business || '', inv.status,
        +(inv.subtotal || 0).toFixed(2), +(inv.taxAmount || 0).toFixed(2), +(inv.total || 0).toFixed(2),
        inv.notes || ''
      ]);
      const aoa = [header, ...rows];
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Purchase Invoices');
      XLSX.writeFile(wb, 'purchase-invoices-' + new Date().toISOString().slice(0,10) + '.xlsx');
      showToast('Purchase invoices exported as Excel.');
      logActivity('export_xlsx', `Exported ${visiblePurchase.length} purchase invoices`);
    } catch(e) {
      showToast('Export failed. Try again.', 'error');
    }
  }

  function exportCsv() {
    if (!visiblePurchase.length) { showToast('No invoices to export.', 'error'); return; }
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = ['Invoice#', 'Supplier', 'Date', 'Due Date', 'Business', 'Status', 'Subtotal', 'Tax', 'Total', 'Notes'];
    const rows = visiblePurchase.map(inv => [
      inv.id, inv.supplier, inv.date, inv.dueDate || '', inv.business || '', inv.status,
      +(inv.subtotal || 0).toFixed(2), +(inv.taxAmount || 0).toFixed(2), +(inv.total || 0).toFixed(2),
      inv.notes || '',
    ]);
    const csv = [header.map(esc).join(','), ...rows.map(r => r.map(esc).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'purchase-invoices-' + today() + '.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    showToast('Purchase invoices exported as CSV.');
    logActivity('export_csv', `Exported ${visiblePurchase.length} purchase invoices as CSV`);
  }

  return (
    <div>
      <div className="flex-between mb-4 flex-wrap gap-2">
        <div className="section-title" style={{margin:0}}>Purchase Invoices — {BUSINESSES[selectedBusiness]?.name||selectedBusiness}</div>
        <div className="flex gap-2 flex-wrap" style={{alignItems:'center'}}>
          <label style={{fontSize:13,color:'#666',display:'flex',alignItems:'center',gap:5,cursor:'pointer'}}>
            <input type="checkbox" checked={showAllBiz} onChange={e=>setShowAllBiz(e.target.checked)} />
            All businesses
          </label>
          <select className="input" style={{width:'auto'}} value={filterStatus} onChange={e=>setFilterStatus(e.target.value)}>
            <option value="all">All statuses</option>
            <option value="unpaid">Unpaid only</option>
            <option value="paid">Paid only</option>
          </select>
          <Btn className="btn-outline" onClick={exportCsv}>⬇ CSV</Btn>
          <Btn className="btn-outline" onClick={exportExcel}>⬇ Excel</Btn>
          <Btn className="btn-primary" onClick={()=>{setEditingPurchaseId(null);setForm(blankF());setShowForm(true);}}>+ New Invoice</Btn>
        </div>
      </div>

      <div className="flex gap-2 mb-4 flex-wrap" style={{alignItems:'center'}}>
        <input className="input" placeholder="Filter by supplier…" style={{flex:'1 1 140px'}} value={filterSupplier} onChange={e=>setFilterSupplier(e.target.value)} />
        <input className="input" type="date" style={{width:'auto'}} value={filterDateFrom} onChange={e=>setFilterDateFrom(e.target.value)} title="From date" />
        <input className="input" type="date" style={{width:'auto'}} value={filterDateTo} onChange={e=>setFilterDateTo(e.target.value)} title="To date" />
        {[
          ['thismonth','This Month',()=>{const n=new Date();setFilterDateFrom(`${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-01`);setFilterDateTo(`${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(new Date(n.getFullYear(),n.getMonth()+1,0).getDate()).padStart(2,'0')}`)}],
          ['lastmonth','Last Month',()=>{const n=new Date(new Date().getFullYear(),new Date().getMonth()-1,1);setFilterDateFrom(`${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-01`);setFilterDateTo(`${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(new Date(n.getFullYear(),n.getMonth()+1,0).getDate()).padStart(2,'0')}`)}],
        ].map(([k,label,fn])=>(
          <button key={k} className="btn btn-sm" style={{background:'#eee',color:'#555',borderRadius:12,padding:'2px 10px'}} onClick={fn}>{label}</button>
        ))}
        {(filterSupplier||filterDateFrom||filterDateTo) && (
          <button className="btn btn-sm" style={{background:'#eee',color:'#666',borderRadius:12,padding:'2px 10px'}} onClick={()=>{setFilterSupplier('');setFilterDateFrom('');setFilterDateTo('');}}>✕ Clear</button>
        )}
        <div style={{marginLeft:'auto',fontSize:13,color:'#888'}}>{visiblePurchase.length} of {purchaseInvoices.length}</div>
      </div>

      {outstandingTotal > 0 && (
        <div style={{background:'#FEF3C7',border:'1px solid #FDE68A',borderRadius:8,padding:'10px 16px',marginBottom:16,fontSize:13.5,color:'#92400E',display:'flex',alignItems:'center',gap:8}}>
          <span style={{fontWeight:700}}>⚠ Outstanding:</span>
          {fmt$(outstandingTotal)} unpaid across {purchaseInvoices.filter(i=>i.status!=='paid').length} invoice{purchaseInvoices.filter(i=>i.status!=='paid').length!==1?'s':''}
        </div>
      )}

      {selectedIds.size > 0 && (
        <div style={{background:'#EFF6FF',border:'1px solid #BFDBFE',borderRadius:8,padding:'8px 14px',marginBottom:12,display:'flex',alignItems:'center',gap:12,flexWrap:'wrap'}}>
          <span style={{fontWeight:600,color:'#1D4ED8'}}>{selectedIds.size} invoice{selectedIds.size!==1?'s':''} selected</span>
          <Btn className="btn-success btn-sm" onClick={bulkMarkPaid}>✓ Mark All Paid</Btn>
          <Btn className="btn-outline btn-sm" onClick={()=>setSelectedIds(new Set())}>Clear</Btn>
        </div>
      )}

      {visiblePurchase.length===0
        ? <div className="card empty-state">{purchaseInvoices.length===0 ? 'No purchase invoices yet. Click "+ New Invoice" to create one.' : 'No invoices for this business. Use "All businesses" to see others.'}</div>
        : (
          <div className="card" style={{padding:0}}>
            <div className="tbl-wrap">
              <table>
                <thead><tr>
                  <th style={{width:36}}><input type="checkbox" checked={selectedIds.size>0&&visiblePurchase.every(i=>selectedIds.has(i.id))} onChange={e=>{setSelectedIds(e.target.checked?new Set(visiblePurchase.map(i=>i.id)):new Set());}} /></th>
                  <th>Invoice #</th><th>Supplier</th><th>Date</th><th>Due Date</th><th>Business</th><th>Total</th><th>Status</th><th>Actions</th>
                </tr></thead>
                <tbody>
                  {visiblePurchase.map(inv=>(
                    <tr key={inv.id}>
                      <td><input type="checkbox" checked={selectedIds.has(inv.id)} onChange={()=>setSelectedIds(prev=>{const n=new Set(prev);n.has(inv.id)?n.delete(inv.id):n.add(inv.id);return n;})} /></td>
                      <td style={{fontFamily:'monospace',fontWeight:700}}>{inv.id}</td>
                      <td style={{fontWeight:600}}>{inv.supplier}</td>
                      <td>{fmtDate(inv.date)}</td>
                      <td style={{color: inv.dueDate && inv.dueDate < today() && inv.status !== 'paid' ? '#DC2626' : undefined, fontWeight: inv.dueDate && inv.dueDate < today() && inv.status !== 'paid' ? 600 : undefined}}>
                        {inv.dueDate ? fmtDate(inv.dueDate) : '—'}
                        {inv.dueDate && inv.dueDate < today() && inv.status !== 'paid' ? ' ⚠' : ''}
                      </td>
                      <td style={{fontSize:12,color:'#777'}}>{BUSINESSES[inv.business]?.name}</td>
                      <td style={{fontWeight:600}}>{fmt$(inv.total)}</td>
                      <td><span className={`badge badge-${inv.status}`}>{inv.status}</span></td>
                      <td style={{whiteSpace:'nowrap'}}>
                        <Btn className="btn-secondary btn-sm" style={{marginRight:4}} onClick={()=>setViewInv(inv)}>View</Btn>
                        <Btn className="btn-outline btn-sm" style={{marginRight:4}} onClick={()=>openPurchaseEdit(inv)}>Edit</Btn>
                        <Btn className="btn-outline btn-sm" style={{marginRight:4}} onClick={()=>copyInvoice(inv)}>Copy</Btn>
                        {inv.status!=='paid'&&<Btn className="btn-success btn-sm" style={{marginRight:4}} onClick={()=>markPaid(inv.id)}>Mark Paid</Btn>}
                        {setItems&&<Btn className="btn-outline btn-sm" style={{marginRight:4}} title="Update item stock levels from this invoice" onClick={()=>openStockUpdate(inv)}>📦 Stock</Btn>}
                        <Btn className="btn-danger btn-sm" onClick={()=>setConfirmId(inv.id)}>Delete</Btn>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      }

      <Modal open={showForm} onClose={()=>{setShowForm(false);setEditingPurchaseId(null);}} title={editingPurchaseId ? `Edit Purchase Invoice ${editingPurchaseId}` : 'New Purchase Invoice'} wide>
        <div className="grid-2">
          <FI label="Supplier Name *" value={form.supplier} onChange={e=>setForm(f=>({...f,supplier:e.target.value}))} placeholder="Sysco, US Foods…" suggestions={supplierSuggestions} />
          <FI label="Invoice Date" type="date" value={form.date} onChange={e=>setForm(f=>({...f,date:e.target.value}))} />
        </div>
        <div className="grid-2" style={{marginBottom:14}}>
          <FI label="Due Date (optional)" type="date" value={form.dueDate||''} onChange={e=>setForm(f=>({...f,dueDate:e.target.value}))} />
        </div>
        <datalist id={descListId}>
          {lineDescSuggestions.map(s => <option key={s} value={s} />)}
        </datalist>
        <datalist id={unitLineListId}>
          {lineUnitSuggestions.map(s => <option key={s} value={s} />)}
        </datalist>
        <div style={{marginBottom:14}}>
          <div className="flex-between mb-2">
            <label style={{margin:0}}>Line Items</label>
            <Btn className="btn-outline btn-sm" onClick={()=>setForm(f=>({...f,lineItems:[...f.lineItems,{description:'',quantity:'',unit:'each',unitPrice:''}]}))}>+ Add Line</Btn>
          </div>
          {form.lineItems.map((l,i)=>(
            <div key={i} className="flex gap-2 mb-2" style={{alignItems:'center',flexWrap:'wrap'}}>
              <input className="input" placeholder="Description *" value={l.description} onChange={e=>setLine(i,'description',e.target.value)} style={{flex:'3 1 160px'}} list={descListId} />
              <input className="input" placeholder="Qty" type="number" min="0" step="0.01" value={l.quantity} onChange={e=>setLine(i,'quantity',e.target.value)} style={{flex:'1 1 60px'}} />
              <select className="input" style={{flex:'1 1 80px'}} value={PURCHASE_UNITS.includes(l.unit)?l.unit:'custom'} onChange={e=>{if(e.target.value!=='custom')setLine(i,'unit',e.target.value);else setLine(i,'unit','');}}>
                {PURCHASE_UNITS.map(u=><option key={u} value={u}>{u}</option>)}
                <option value="custom">other…</option>
              </select>
              {!PURCHASE_UNITS.includes(l.unit)&&<input className="input" placeholder="unit" value={l.unit} onChange={e=>setLine(i,'unit',e.target.value)} style={{flex:'0 0 60px'}} />}
              <input className="input" placeholder="Unit $" type="number" min="0" step="0.01" value={l.unitPrice} onChange={e=>setLine(i,'unitPrice',e.target.value)} style={{flex:'1 1 70px'}} />
              {l._caseSize && CASE_UNITS.has(l.unit) && (
                <span style={{fontSize:11,color:'#888',flexShrink:0,alignSelf:'center'}}>1 {l.unit}={l._caseSize} ea</span>
              )}
              <span style={{minWidth:64,textAlign:'right',fontSize:13,color:'var(--brown)',fontWeight:600}}>{fmt$(T.lines[i]?.total||0)}</span>
              <Btn className="btn-danger btn-sm" onClick={()=>setForm(f=>({...f,lineItems:f.lineItems.filter((_,x)=>x!==i)}))}>✕</Btn>
            </div>
          ))}
        </div>
        <div style={{background:'var(--cream)',padding:14,borderRadius:8,marginBottom:14}}>
          <div className="flex-between mb-2"><span>Subtotal</span><strong>{fmt$(T.sub)}</strong></div>
          <div className="flex-between mb-2">
            <Toggle checked={form.taxEnabled} onChange={v=>setForm(f=>({...f,taxEnabled:v}))} label={`Tax (${(biz.taxRate*100).toFixed(3)}%)`} />
            <span style={{color:form.taxEnabled?'var(--brown)':'#bbb'}}>{fmt$(T.tax)}</span>
          </div>
          <hr className="divider" />
          <div className="flex-between"><strong style={{fontSize:16}}>Total</strong><strong style={{fontSize:19,color:'var(--brown)'}}>{fmt$(T.total)}</strong></div>
        </div>
        <div style={{padding:14,border:'1px solid #EED9B0',borderRadius:8,marginBottom:14}}>
          <div style={{fontWeight:700,color:'var(--brown)',marginBottom:10,fontSize:14}}>Payment Information</div>
          <div className="grid-3">
            <FI label="Account #" value={form.payment.account} onChange={e=>setForm(f=>({...f,payment:{...f.payment,account:e.target.value}}))} placeholder="Optional" />
            <FI label="Payment Date" type="date" value={form.payment.date} onChange={e=>setForm(f=>({...f,payment:{...f.payment,date:e.target.value}}))} />
            <FI label="Transaction ID" value={form.payment.transactionId} onChange={e=>setForm(f=>({...f,payment:{...f.payment,transactionId:e.target.value}}))} placeholder="Optional" />
          </div>
        </div>
        <div className="field"><label>Notes</label><textarea className="input" rows={2} value={form.notes} onChange={e=>setForm(f=>({...f,notes:e.target.value}))} /></div>
        <div className="flex gap-2" style={{justifyContent:'flex-end',marginTop:8}}>
          <Btn className="btn-outline" onClick={()=>{setShowForm(false);setEditingPurchaseId(null);}}>Cancel</Btn>
          <Btn className="btn-primary" onClick={saveInvoice}>{editingPurchaseId ? 'Save Changes' : 'Create Invoice'}</Btn>
        </div>
      </Modal>

      <Modal open={!!viewInv} onClose={()=>setViewInv(null)} title={`Invoice ${viewInv?.id||''}`} wide closeOnBackdrop>
        {viewInv&&(()=>{
          const brand = getInvoiceBranding(viewInv, brandingMap);
          return (
          <div id={`purchase-view-${viewInv.id}`}>
            <div className="flex-between mb-4" style={{flexWrap:'wrap',gap:8}}>
              <div style={{display:'flex',alignItems:'center',gap:10}}>
                <BrandMark brand={brand} />
                <div>
                  <div style={{fontWeight:700,fontSize:17,color:'var(--brown)'}}>{brand.name}</div>
                  <div style={{fontSize:12,color:'#888'}}>{brand.address}</div>
                  {brand.phone&&<div style={{fontSize:12,color:'#888'}}>Tel: {brand.phone}</div>}
                  {brand.email&&<div style={{fontSize:12,color:'#888'}}>{brand.email}</div>}
                </div>
              </div>
              <div style={{textAlign:'right',fontSize:13}}>
                <div><strong>Invoice #:</strong> {viewInv.id}</div>
                <div><strong>Date:</strong> {fmtDate(viewInv.date)}</div>
                <div><strong>Supplier:</strong> {viewInv.supplier}</div>
                {(() => {
                  const sup = suppliers.find(s => s.name.toLowerCase() === (viewInv.supplier||'').toLowerCase());
                  if (!sup) return null;
                  return (
                    <div style={{marginTop:6,fontSize:12,color:'#555',lineHeight:1.7}}>
                      {sup.phone && <div>📞 {sup.phone}</div>}
                      {sup.email && <div>✉ {sup.email}</div>}
                      {sup.address && <div>📍 {sup.address}</div>}
                    </div>
                  );
                })()}
              </div>
            </div>
            <div className="tbl-wrap" style={{marginBottom:14}}>
              <table><thead><tr><th>Description</th><th>Qty</th><th>Unit</th><th>Unit Price</th><th>Total</th></tr></thead>
                <tbody>{viewInv.lineItems.map((l,i)=><tr key={i}><td>{l.description}</td><td>{l.qty??l.quantity}</td><td>{l.unit}</td><td>{fmt$(l.price??l.unitPrice)}</td><td style={{fontWeight:600}}>{fmt$(l.total)}</td></tr>)}</tbody>
              </table>
            </div>
            <div style={{textAlign:'right'}}>
              <div>Subtotal: {fmt$(viewInv.subtotal)}</div>
              {viewInv.taxEnabled&&<div>Tax ({(viewInv.taxRate*100).toFixed(3)}%): {fmt$(viewInv.taxAmount)}</div>}
              <div style={{fontWeight:700,fontSize:18,color:'var(--brown)',marginTop:6}}>Total: {fmt$(viewInv.total)}</div>
            </div>
            {(viewInv.payment?.account||viewInv.payment?.transactionId||viewInv.payment?.date||viewInv.paidAt)&&(
              <div style={{marginTop:14,padding:12,background:'var(--cream)',borderRadius:6,fontSize:13}}>
                <strong>Payment: </strong>{viewInv.payment?.account&&`Account: ${viewInv.payment.account}  `}{(viewInv.payment?.date||viewInv.paidAt)&&`Paid: ${fmtDate(viewInv.payment?.date||viewInv.paidAt)}  `}{viewInv.payment?.transactionId&&`Txn: ${viewInv.payment.transactionId}`}
              </div>
            )}
            <div className="flex gap-2" style={{justifyContent:'flex-end',marginTop:16}}>
              <Btn className="btn-outline" onClick={()=>{ printHtmlDocument(buildPurchaseInvoiceDoc(viewInv, getInvoiceBranding(viewInv, brandingMap) || {}), `Purchase Invoice ${viewInv.id}`); logActivity('print_invoice', `Printed purchase invoice ${viewInv.id}`); }}>🖨 Print / Save PDF</Btn>
              <Btn className="btn-outline" onClick={()=>copyInvoice(viewInv)}>Copy</Btn>
              <Btn className="btn-secondary" onClick={()=>{const v=viewInv; setViewInv(null); openPurchaseEdit(v);}}>Edit</Btn>
              <Btn className="btn-primary" onClick={()=>setViewInv(null)}>Close</Btn>
            </div>
          </div>
          );
        })()}
      </Modal>

      <Confirm
        open={!!confirmId}
        title="Delete purchase invoice?"
        message={
          pendingDeletePurchase
            ? `Permanently remove invoice ${pendingDeletePurchase.id} (${pendingDeletePurchase.supplier || 'supplier'}) on this device?`
            : 'Permanently remove this purchase invoice on this device?'
        }
        detail="This cannot be undone here. Export a backup from Settings if you might need to recover this record."
        dangerCode="DMG-E012 (local data change)"
        confirmLabel="Delete invoice"
        onConfirm={() => deleteInv(confirmId)}
        onCancel={() => setConfirmId(null)}
      />

      <Modal open={!!stockUpdateInv} onClose={() => setStockUpdateInv(null)} title={`Receive Stock from Invoice ${stockUpdateInv?.id || ''}`}>
        {stockUpdateInv && (() => {
          const rows = buildStockMatches(stockUpdateInv);
          const matched = rows.filter(r => r.match);
          const unmatched = rows.filter(r => !r.match);
          return (
            <>
              <div style={{marginBottom:12}}>
                <label style={{fontWeight:600,marginRight:8}}>Receive into location:</label>
                <select className="input" style={{width:'auto',display:'inline-block'}} value={stockUpdateLoc} onChange={e=>setStockUpdateLoc(e.target.value)}>
                  {LOCATIONS.map(l=><option key={l}>{l}</option>)}
                </select>
              </div>
              <p style={{fontSize:12,color:'#666',marginBottom:10}}>Edit "Receive" qty to record a partial receipt. Set to 0 to skip a line.</p>
              {matched.length > 0 && (
                <>
                  <div style={{fontWeight:600,color:'#15803D',marginBottom:6,fontSize:13}}>Matched items ({matched.length}):</div>
                  <div className="tbl-wrap" style={{maxHeight:240,overflowY:'auto',marginBottom:12}}>
                    <table>
                      <thead><tr><th>Item</th><th>Ordered</th><th>Receive</th><th>Current ({stockUpdateLoc})</th></tr></thead>
                      <tbody>
                        {rows.map((r, i) => {
                          if (!r.match) return null;
                          const idx = i;
                          return (
                            <tr key={i}>
                              <td style={{fontWeight:600}}>{r.match.name}</td>
                              <td style={{color:'#888',fontSize:12}}>{r.qty}</td>
                              <td>
                                <input
                                  className="input"
                                  type="number"
                                  min="0"
                                  step="any"
                                  value={receivedQtys[idx] ?? String(r.qty)}
                                  onChange={e => setReceivedQtys(q => ({...q, [idx]: e.target.value}))}
                                  style={{width:72,marginBottom:0}}
                                />
                              </td>
                              <td style={{color:'#888',fontSize:12}}>{r.match.locQty?.[stockUpdateLoc.toLowerCase()] || '—'}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
              {unmatched.length > 0 && setItems && (() => {
                function addMissing() {
                  const supplierName = stockUpdateInv.supplier || '';
                  const rawPrice = (lineItem) => parseFloat(lineItem.unitPrice ?? lineItem.price);
                  let nextItems = [...items];
                  let added = 0;
                  (stockUpdateInv.lineItems || []).forEach(l => {
                    const desc = (l.description || '').trim();
                    if (!desc) return;
                    const alreadyIn = nextItems.find(it => it.name.toLowerCase() === desc.toLowerCase());
                    if (alreadyIn) return;
                    const price = rawPrice(l);
                    const sellers = supplierName ? [{ name: supplierName, price: isNaN(price) ? null : price }] : [];
                    nextItems = [...nextItems, { id: uid(), name: desc, category: 'Other', unit: 'each', upc: '', sellers, locQty: {}, locMinQty: {}, notes: '', createdAt: today() }];
                    added++;
                  });
                  if (added === 0) { showToast('All items are already in the database.'); return; }
                  setItems(nextItems);
                  save('items', nextItems);
                  logActivity('add_item', `Added ${added} items from invoice ${stockUpdateInv.id}`);
                  showToast(`Added ${added} item${added!==1?'s':''} to Item Database.`, 'success');
                }
                return (
                  <div style={{background:'#FEF9E7',border:'1px solid #FDE68A',borderRadius:6,padding:'8px 12px',marginBottom:12,fontSize:12,color:'#92400E',display:'flex',justifyContent:'space-between',alignItems:'center',gap:8}}>
                    <div><strong>No match in Item DB ({unmatched.length}):</strong> {unmatched.map(r=>r.desc).join(', ')}</div>
                    <Btn className="btn-outline btn-sm" style={{flexShrink:0}} onClick={addMissing}>+ Add to DB</Btn>
                  </div>
                );
              })()}
              {unmatched.length > 0 && !setItems && (
                <div style={{background:'#FEF9E7',border:'1px solid #FDE68A',borderRadius:6,padding:'8px 12px',marginBottom:12,fontSize:12,color:'#92400E'}}>
                  <strong>No match in Item DB ({unmatched.length}):</strong> {unmatched.map(r=>r.desc).join(', ')}
                </div>
              )}
              {matched.length === 0 && (
                <div style={{color:'#888',padding:'12px 0',textAlign:'center'}}>No line items matched items in the database by name.</div>
              )}
              <div className="flex gap-2" style={{justifyContent:'flex-end',marginTop:8}}>
                <Btn className="btn-outline" onClick={()=>setStockUpdateInv(null)}>Cancel</Btn>
                <Btn className="btn-primary" disabled={matched.length===0} onClick={commitStockUpdate}>Receive Stock</Btn>
              </div>
            </>
          );
        })()}
      </Modal>
    </div>
  );
}

