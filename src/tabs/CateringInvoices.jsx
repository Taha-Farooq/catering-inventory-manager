import React, { useState, useMemo, useId, useEffect } from 'react';
import * as XLSX from 'xlsx';
import { showToast } from '../toastContext.jsx';
import { BrandMark } from '../ui/BrandMark.jsx';
import Modal from '../ui/Modal.jsx';
import { BUSINESSES, PAYMENT_TERMS } from '../constants.js';
import { fmt$, fmtDate, safeQty, uniqSuggestions } from '../formatters.js';
import { save, uid, today } from '../utils/storage.js';
import { logActivity } from '../utils/activity.js';
import { printHtmlDocument } from '../utils/print.js';
import { moveToTrash } from '../utils/trash.js';
import { buildCateringInvoiceDoc } from '../utils/invoiceDoc.js';
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
function FS({ label, children, ...props }) {
  return <div className="field">{label&&<label>{label}</label>}<select className="input" {...props}>{children}</select></div>;
}
function Btn({ className='', children, ...p }) {
  return <button className={`btn ${className}`} {...p}>{children}</button>;
}

export default function CateringInvoices({ getInvoiceBranding, cateringInvoices, setCateringInvoices, customers, setCustomers, selectedBusiness, userRole, items = [], brandingMap }) {
  const isAdmin = userRole==='admin';
  const blankF = () => ({
    customerId:'',customerName:'',customerPhone:'',customerEmail:'',customerAddress:'',
    useRange:false,date:today(),dateStart:today(),dateEnd:today(),
    eventType:'Catering',business:selectedBusiness,guestCount:'',
    lineItems:[{description:'',quantity:'1',unitPrice:''}],
    ccFeeEnabled:false,taxEnabled:true,deposit:'',notes:''
  });
  const caterDescListId = useId();
  const eventTypeSuggestions = useMemo(()=>uniqSuggestions(
    ...cateringInvoices.map(i=>(i.eventType||'').trim()).filter(Boolean)
  ),[cateringInvoices]);
  const caterLineDescSuggestions = useMemo(()=>{
    const fromInv = cateringInvoices.flatMap(i=>(i.lineItems||[]).map(l=>(l.description||'').trim()).filter(Boolean));
    const names = items.map(i=>i.name);
    return uniqSuggestions(...fromInv, ...names);
  },[cateringInvoices, items]);
  const [showForm, setShowForm] = useState(false);
  const [editingCateringId, setEditingCateringId] = useState(null);
  const [form, setForm] = useState(blankF());
  const [viewInv, setViewInv] = useState(null);
  const [confirmId, setConfirmId] = useState(null);
  const [payingInv, setPayingInv] = useState(null);
  const [payForm, setPayForm] = useState({ amount: '', date: today(), note: '' });

  function setLine(i, f2, v) {
    setForm(f => {
      const l = [...f.lineItems];
      const upd = { ...l[i], [f2]: v };
      if (f2 === 'description' && v) {
        const match = items.find(it => it.name.toLowerCase().trim() === v.toLowerCase().trim());
        if (match) {
          const sellers = Array.isArray(match.sellers) ? match.sellers : [];
          // try to find a non-empty-name seller first, then fall back to first with a price
          const sel = sellers.find(s => s.price > 0 && s.name) || sellers.find(s => s.price > 0) || sellers[0];
          if (sel?.price != null && sel.price > 0 && upd.unitPrice === '') upd.unitPrice = String(sel.price);
          if (match.unit && (upd.unit === '' || upd.unit == null)) upd.unit = match.unit;
          if (match.caseSize) upd._caseSize = match.caseSize;
        }
      }
      l[i] = upd;
      return { ...f, lineItems: l };
    });
  }
  // Pull the most recent invoice for a given customer, used to prefill
  // event type + business when starting a new invoice for someone she's
  // already done business with. Saves her from re-typing the same
  // wedding/corporate/etc. she has every Tuesday.
  function recentInvoiceFor(custId) {
    if (!custId) return null;
    return [...cateringInvoices]
      .filter(inv => inv.customerId === custId)
      .sort((a,b) => String(b.date||b.createdAt||'').localeCompare(String(a.date||a.createdAt||'')))[0] || null;
  }
  function selCust(id){
    const c=customers.find(x=>x.id===id);
    if(c){
      const recent = recentInvoiceFor(c.id);
      setForm(f=>({
        ...f,
        customerId:c.id,
        customerName:c.name,
        customerPhone:c.phone||'',
        customerEmail:c.email||'',
        customerAddress:c.address||'',
        eventType: f.eventType && f.eventType !== 'Catering' ? f.eventType : (recent?.eventType || f.eventType),
        business: f.business || recent?.business || selectedBusiness,
      }));
    } else {
      setForm(f=>({...f,customerId:'',customerName:'',customerPhone:'',customerEmail:'',customerAddress:''}));
    }
  }

  function calcT(){
    const fb=BUSINESSES[form.business]||BUSINESSES[selectedBusiness];
    const lines=form.lineItems.map(l=>{const q=safeQty(l.quantity),p=parseFloat(l.unitPrice)||0;return{...l,qty:q,price:p,total:q*p};});
    const sub=lines.reduce((s,l)=>s+l.total,0);
    const cc=form.ccFeeEnabled?sub*0.035:0;
    const taxBase=sub+cc;
    const taxAmt=form.taxEnabled?taxBase*fb.taxRate:0;
    const grand=taxBase+taxAmt;
    const dep=Math.max(0,parseFloat(form.deposit)||0);
    return{lines,sub,cc,taxAmt,grand,dep,balance:grand-dep,fb};
  }
  const T=calcT();

  const pendingDeleteCatering = useMemo(
    () => (confirmId ? cateringInvoices.find((i) => i.id === confirmId) : null),
    [confirmId, cateringInvoices]
  );

  function openCateringEdit(inv) {
    const lines = (inv.lineItems && inv.lineItems.length ? inv.lineItems : [{ description:'', quantity:'1', unitPrice:'' }]).map((l) => ({
      description: l.description || '',
      quantity: String(l.qty ?? l.quantity ?? '1'),
      unitPrice: String(l.price ?? l.unitPrice ?? ''),
    }));
    setForm({
      customerId: inv.customerId || '',
      customerName: inv.customerName || '',
      customerPhone: inv.customerPhone || '',
      customerEmail: inv.customerEmail || '',
      customerAddress: inv.customerAddress || '',
      useRange: !!inv.useRange,
      date: inv.date || today(),
      dateStart: inv.dateStart || today(),
      dateEnd: inv.dateEnd || today(),
      eventType: inv.eventType || 'Catering',
      business: inv.business || selectedBusiness,
      guestCount: inv.guestCount != null ? String(inv.guestCount) : '',
      lineItems: lines,
      ccFeeEnabled: !!inv.ccFeeEnabled,
      taxEnabled: inv.taxEnabled !== false,
      deposit: inv.deposit != null && inv.deposit !== '' ? String(inv.deposit) : '',
      notes: inv.notes || '',
    });
    setEditingCateringId(inv.id);
    setShowForm(true);
  }

  function copyInvoice(inv) {
    const lines = (inv.lineItems && inv.lineItems.length ? inv.lineItems : [{ description:'', quantity:'1', unitPrice:'' }]).map((l) => ({
      description: l.description || '',
      quantity: String(l.qty ?? l.quantity ?? '1'),
      unitPrice: String(l.price ?? l.unitPrice ?? ''),
    }));
    setForm({
      customerId: inv.customerId || '',
      customerName: inv.customerName || '',
      customerPhone: inv.customerPhone || '',
      customerEmail: inv.customerEmail || '',
      customerAddress: inv.customerAddress || '',
      useRange: !!inv.useRange,
      date: today(),
      dateStart: today(),
      dateEnd: today(),
      eventType: inv.eventType || 'Catering',
      business: inv.business || selectedBusiness,
      guestCount: inv.guestCount != null ? String(inv.guestCount) : '',
      lineItems: lines,
      ccFeeEnabled: !!inv.ccFeeEnabled,
      taxEnabled: inv.taxEnabled !== false,
      deposit: '',
      notes: inv.notes || '',
    });
    setEditingCateringId(null);
    setViewInv(null);
    setShowForm(true);
    showToast('Invoice copied — review and save as new.');
  }

  function saveInvoice(){
    if (!form.customerName.trim()){showToast('Customer name is required. [DMG-E006]','error');return;}
    if (form.useRange && form.dateStart && form.dateEnd && form.dateEnd < form.dateStart){showToast('End date must be on or after start date. [DMG-E006]','error');return;}
    const valid=T.lines.filter(l=>l.description.trim());
    if (!valid.length){showToast('Add at least one line item with a description. [DMG-E006]','error');return;}
    if (T.dep<0){showToast('Deposit cannot be negative. [DMG-E006]','error');return;}
    let custId=form.customerId;
    if (!custId&&form.customerName.trim()){
      const nc={id:uid(),name:form.customerName,phone:form.customerPhone,email:form.customerEmail,address:form.customerAddress||'',notes:'',createdAt:today()};
      const uc=[...customers,nc];setCustomers(uc);save('customers',uc);custId=nc.id;
    }
    const status=T.dep>=T.grand?'paid':T.dep>0?'partial':'unpaid';
    if (editingCateringId) {
      const prev = cateringInvoices.find((i) => i.id === editingCateringId);
      if (!prev) { showToast('Invoice not found.', 'error'); return; }
      const inv={
        ...prev,
        customerId:custId,customerName:form.customerName,customerPhone:form.customerPhone,customerEmail:form.customerEmail,customerAddress:form.customerAddress||'',
        useRange:form.useRange,date:form.useRange?null:form.date,dateStart:form.useRange?form.dateStart:null,dateEnd:form.useRange?form.dateEnd:null,
        eventType:form.eventType,guestCount:form.guestCount?parseInt(form.guestCount)||null:null,lineItems:valid,subtotal:T.sub,
        ccFeeEnabled:form.ccFeeEnabled,ccFee:T.cc,taxEnabled:form.taxEnabled,taxRate:T.fb.taxRate,taxAmount:T.taxAmt,
        grandTotal:T.grand,deposit:T.dep,balanceDue:T.balance,status,notes:form.notes,business:form.business||selectedBusiness
      };
      const u=cateringInvoices.map(x=>x.id===editingCateringId?inv:x);
      setCateringInvoices(u);save('cateringInvoices',u);
      setShowForm(false);setForm(blankF());setEditingCateringId(null);
      showToast('Catering invoice updated.');
      logActivity('edit_item', 'Updated catering invoice ' + inv.id);
      return;
    }
    const inv={
      id:nextId('catering'),type:'catering',business:form.business||selectedBusiness,
      customerId:custId,customerName:form.customerName,customerPhone:form.customerPhone,customerEmail:form.customerEmail,customerAddress:form.customerAddress||'',
      useRange:form.useRange,date:form.useRange?null:form.date,dateStart:form.useRange?form.dateStart:null,dateEnd:form.useRange?form.dateEnd:null,
      eventType:form.eventType,guestCount:form.guestCount?parseInt(form.guestCount)||null:null,lineItems:valid,subtotal:T.sub,
      ccFeeEnabled:form.ccFeeEnabled,ccFee:T.cc,taxEnabled:form.taxEnabled,taxRate:T.fb.taxRate,taxAmount:T.taxAmt,
      grandTotal:T.grand,deposit:T.dep,balanceDue:T.balance,status,notes:form.notes,createdAt:today()
    };
    const u=[...cateringInvoices,inv];setCateringInvoices(u);save('cateringInvoices',u);
    setShowForm(false);setForm(blankF());
    showToast('Catering invoice created.');
    logActivity('create_invoice', 'Created catering invoice ' + inv.id);
  }

  function deleteInv(id){
    const removed = cateringInvoices.find(x=>x.id===id);
    if (removed) moveToTrash('cateringInvoices', `Catering ${id} — ${removed.customerName || ''} (${fmt$(removed.grandTotal||0)})`, removed);
    const u=cateringInvoices.filter(x=>x.id!==id);setCateringInvoices(u);save('cateringInvoices',u);setConfirmId(null);
    showToast('Catering invoice deleted. Restore it from Settings → Recently Deleted if needed.');
    logActivity('delete_invoice','Deleted catering invoice '+id);
  }

  function totalPaidFor(inv) { return (parseFloat(inv.deposit)||0) + (inv.payments||[]).reduce((s,p) => s+(p.amount||0), 0); }
  function balanceFor(inv) { return Math.max(0, (inv.grandTotal||0) - totalPaidFor(inv)); }

  function markPaid(id) {
    const inv = cateringInvoices.find(x => x.id === id);
    if (!inv) return;
    const remaining = balanceFor(inv);
    const payments = remaining > 0
      ? [...(inv.payments || []), { id: uid(), date: today(), amount: remaining, note: 'Full payment' }]
      : (inv.payments || []);
    const updated = { ...inv, payments, status: 'paid', deposit: inv.deposit, balanceDue: 0 };
    const u = cateringInvoices.map(x => x.id === id ? updated : x);
    setCateringInvoices(u); save('cateringInvoices', u);
    showToast('Catering invoice marked paid.');
    logActivity('mark_paid', 'Marked catering invoice paid ' + id);
  }

  function recordPayment() {
    if (!payingInv) return;
    const amount = parseFloat(payForm.amount);
    if (isNaN(amount) || amount <= 0) { showToast('Enter a valid payment amount.', 'error'); return; }
    const payments = [...(payingInv.payments || []), { id: uid(), date: payForm.date || today(), amount, note: payForm.note.trim() }];
    const newTotalPaid = (parseFloat(payingInv.deposit)||0) + payments.reduce((s,p) => s+(p.amount||0), 0);
    const newBalance = Math.max(0, (payingInv.grandTotal||0) - newTotalPaid);
    const newStatus = newBalance <= 0 ? 'paid' : 'partial';
    const updated = { ...payingInv, payments, balanceDue: newBalance, status: newStatus };
    const u = cateringInvoices.map(i => i.id === payingInv.id ? updated : i);
    setCateringInvoices(u); save('cateringInvoices', u);
    logActivity('mark_paid', `Recorded ${fmt$(amount)} payment on catering invoice ${payingInv.id}`);
    showToast(`Payment of ${fmt$(amount)} recorded.`);
    if (viewInv?.id === payingInv.id) setViewInv(updated);
    setPayingInv(null);
    setPayForm({ amount: '', date: today(), note: '' });
  }

  const [showAllBiz, setShowAllBiz] = useState(false);
  const [filterStatus, setFilterStatus] = useState('all');
  const [filterCustomer, setFilterCustomer] = useState('');
  const [filterDateFrom, setFilterDateFrom] = useState('');
  const [filterDateTo, setFilterDateTo] = useState('');
  const [selectedIds, setSelectedIds] = useState(new Set());
  useEffect(() => { setSelectedIds(new Set()); }, [filterStatus, filterCustomer, filterDateFrom, filterDateTo]);

  const visibleCatering = useMemo(() => {
    let list = showAllBiz ? [...cateringInvoices] : cateringInvoices.filter(i => !i.business || i.business === selectedBusiness);
    if (filterStatus !== 'all') list = list.filter(i => i.status === filterStatus);
    if (filterCustomer.trim()) {
      const q = filterCustomer.toLowerCase();
      list = list.filter(i => (i.customerName || '').toLowerCase().includes(q));
    }
    if (filterDateFrom) list = list.filter(i => (i.date || i.dateStart || '') >= filterDateFrom);
    if (filterDateTo) list = list.filter(i => (i.date || i.dateStart || '') <= filterDateTo);
    return [...list].reverse();
  }, [cateringInvoices, showAllBiz, selectedBusiness, filterStatus, filterCustomer, filterDateFrom, filterDateTo]);

  const outstandingTotal = useMemo(() =>
    cateringInvoices.filter(i => i.status !== 'paid').reduce((s, i) => s + (i.balanceDue || 0), 0),
    [cateringInvoices]
  );

  // Build a single catering invoice as a professional letterhead doc.
  function buildCateringDoc(inv) {
    return buildCateringInvoiceDoc(inv, getInvoiceBranding(inv, brandingMap) || {});
  }
  function printOneCatering(inv) {
    printHtmlDocument(buildCateringDoc(inv), `Catering Invoice ${inv.id}`);
    logActivity('print_invoice', `Printed catering invoice ${inv.id}`);
  }
  // Bulk-print every visible invoice, one per page.
  function printAllVisible() {
    if (!visibleCatering.length) { showToast('No invoices in the current filter to print.', 'error'); return; }
    if (visibleCatering.length > 50 && !window.confirm(`Print ${visibleCatering.length} invoices? You can narrow the date range above first if this is too many.`)) return;
    const body = visibleCatering.map(inv => `<div style="page-break-after:always">${buildCateringDoc(inv)}</div>`).join('\n');
    printHtmlDocument(body, `Catering invoices (${visibleCatering.length})`);
    logActivity('print_invoices', `Bulk-printed ${visibleCatering.length} catering invoices`);
  }

  function exportCsv() {
    if (!visibleCatering.length) { showToast('No invoices to export.', 'error'); return; }
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = ['Invoice#', 'Customer', 'Date', 'Event', 'Guests', 'Business', 'Status', 'Subtotal', 'Tax', 'Total', 'Deposit', 'Balance Due', 'Notes'];
    const rows = visibleCatering.map(inv => [
      inv.id, inv.customerName || '', inv.date || '', inv.eventType || '',
      inv.guestCount != null ? inv.guestCount : '',
      inv.business || '',
      inv.status || '', +(inv.subtotal || 0).toFixed(2), +(inv.taxAmount || 0).toFixed(2),
      +(inv.grandTotal || inv.total || 0).toFixed(2), +(inv.deposit || 0).toFixed(2),
      +(inv.balanceDue || 0).toFixed(2), inv.notes || '',
    ]);
    const csv = [header.map(esc).join(','), ...rows.map(r => r.map(esc).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'catering-invoices-' + today() + '.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    showToast('Catering invoices exported.');
    logActivity('export_csv', `Exported ${visibleCatering.length} catering invoices`);
  }

  function exportExcel() {
    if (!visibleCatering.length) { showToast('No invoices to export.', 'error'); return; }
    const wb = XLSX.utils.book_new();
    // Summary sheet
    const sumHeader = ['Invoice#', 'Customer', 'Date', 'Event', 'Guests', 'Business', 'Status', 'Subtotal', 'CC Fee', 'Tax', 'Grand Total', 'Total Paid', 'Balance Due', 'Notes'];
    const sumRows = visibleCatering.map(inv => [
      inv.id, inv.customerName || '', inv.date || '', inv.eventType || '',
      inv.guestCount != null ? inv.guestCount : '',
      inv.business || '',
      inv.status || '', +(inv.subtotal || 0).toFixed(2), +(inv.ccFee || 0).toFixed(2),
      +(inv.taxAmount || 0).toFixed(2), +(inv.grandTotal || 0).toFixed(2),
      +totalPaidFor(inv).toFixed(2), +balanceFor(inv).toFixed(2), inv.notes || '',
    ]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([sumHeader, ...sumRows]), 'Invoices');
    // Line items sheet
    const lineHeader = ['Invoice#', 'Customer', 'Date', 'Description', 'Qty', 'Unit Price', 'Line Total'];
    const lineRows = visibleCatering.flatMap(inv =>
      (inv.lineItems || []).map(l => [
        inv.id, inv.customerName || '', inv.date || '',
        l.description || '', l.qty ?? l.quantity ?? '', +(l.price ?? l.unitPrice ?? 0).toFixed(2),
        +(l.total || 0).toFixed(2),
      ])
    );
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([lineHeader, ...lineRows]), 'Line Items');
    XLSX.writeFile(wb, 'catering-invoices-' + today() + '.xlsx');
    logActivity('export_xlsx', `Exported ${visibleCatering.length} catering invoices Excel`);
    showToast('Catering invoices exported to Excel.');
  }

  function bulkMarkPaid() {
    if (!selectedIds.size) return;
    const u = cateringInvoices.map(i =>
      selectedIds.has(i.id) && i.status !== 'paid'
        ? { ...i, status: 'paid', deposit: i.grandTotal, balanceDue: 0 }
        : i
    );
    setCateringInvoices(u);
    save('cateringInvoices', u);
    logActivity('bulk_mark_paid', `Bulk marked ${selectedIds.size} catering invoices as paid`);
    showToast(`${selectedIds.size} invoice${selectedIds.size !== 1 ? 's' : ''} marked paid.`);
    setSelectedIds(new Set());
  }

  return (
    <div>
      <div className="flex-between mb-4 flex-wrap gap-2">
        <div className="section-title" style={{margin:0}}>Catering Invoices — {BUSINESSES[selectedBusiness]?.name||selectedBusiness}</div>
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
          <Btn className="btn-outline" onClick={printAllVisible} title="Print every invoice currently shown in the list, one per page">🖨 Print all</Btn>
          <Btn className="btn-primary" onClick={()=>{setEditingCateringId(null);setForm(blankF());setShowForm(true);}}>+ New Invoice</Btn>
        </div>
      </div>

      <div className="flex gap-2 mb-4 flex-wrap" style={{alignItems:'center'}}>
        <input className="input" style={{flex:'1 1 160px'}} placeholder="Filter by customer…" value={filterCustomer} onChange={e=>setFilterCustomer(e.target.value)} />
        <input className="input" type="date" style={{width:'auto'}} value={filterDateFrom} onChange={e=>setFilterDateFrom(e.target.value)} title="From date" />
        <input className="input" type="date" style={{width:'auto'}} value={filterDateTo} onChange={e=>setFilterDateTo(e.target.value)} title="To date" />
        {[
          ['upcoming','Upcoming',()=>{setFilterDateFrom(today());setFilterDateTo('');}],
          ['thismonth','This Month',()=>{const n=new Date();setFilterDateFrom(`${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-01`);setFilterDateTo(`${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(new Date(n.getFullYear(),n.getMonth()+1,0).getDate()).padStart(2,'0')}`);}],
        ].map(([k,label,fn])=>(
          <button key={k} className="btn btn-sm" style={{background:'#eee',color:'#555',borderRadius:12,padding:'2px 10px'}} onClick={fn}>{label}</button>
        ))}
        {(filterCustomer||filterDateFrom||filterDateTo) && (
          <button className="btn btn-sm" style={{background:'#eee',color:'#666',borderRadius:12,padding:'2px 10px'}} onClick={()=>{setFilterCustomer('');setFilterDateFrom('');setFilterDateTo('');}}>✕ Clear</button>
        )}
        <div style={{marginLeft:'auto',fontSize:13,color:'#888'}}>{visibleCatering.length} of {cateringInvoices.length}</div>
      </div>

      {outstandingTotal > 0 && (
        <div style={{background:'#FEF3C7',border:'1px solid #FDE68A',borderRadius:8,padding:'10px 16px',marginBottom:16,fontSize:13.5,color:'#92400E',display:'flex',alignItems:'center',gap:8}}>
          <span style={{fontWeight:700}}>⚠ Outstanding:</span>
          {fmt$(outstandingTotal)} due across {cateringInvoices.filter(i=>i.status!=='paid').length} invoice{cateringInvoices.filter(i=>i.status!=='paid').length!==1?'s':''}
        </div>
      )}

      {selectedIds.size > 0 && (
        <div style={{display:'flex',alignItems:'center',gap:10,padding:'10px 14px',background:'#EFF6FF',border:'1px solid #BFDBFE',borderRadius:8,marginBottom:12}}>
          <span style={{fontWeight:600,color:'#1D4ED8'}}>{selectedIds.size} invoice{selectedIds.size!==1?'s':''} selected</span>
          <button className="btn btn-success btn-sm" onClick={bulkMarkPaid}>✓ Mark All Paid</button>
          <button className="btn btn-outline btn-sm" onClick={()=>setSelectedIds(new Set())}>Clear</button>
        </div>
      )}

      {visibleCatering.length===0
        ? <div className="card empty-state">{cateringInvoices.length===0 ? 'No catering invoices yet. Click "+ New Invoice" to create one.' : 'No invoices for this business. Use "All businesses" to see others.'}</div>
        : (
          <div className="card" style={{padding:0}}>
            <div className="tbl-wrap">
              <table>
                <thead><tr><th style={{width:36}}><input type="checkbox" checked={selectedIds.size>0&&visibleCatering.every(i=>selectedIds.has(i.id))} onChange={e=>{setSelectedIds(e.target.checked?new Set(visibleCatering.map(i=>i.id)):new Set());}} /></th><th>Invoice #</th><th>Customer</th><th>Event Date</th><th>Event</th><th>Total</th><th>Balance Due</th><th>Status</th><th>Actions</th></tr></thead>
                <tbody>
                  {visibleCatering.map(inv=>(
                    <tr key={inv.id}>
                      <td><input type="checkbox" checked={selectedIds.has(inv.id)} onChange={()=>setSelectedIds(prev=>{const n=new Set(prev);n.has(inv.id)?n.delete(inv.id):n.add(inv.id);return n;})} /></td>
                      <td style={{fontFamily:'monospace',fontWeight:700}}>{inv.id}</td>
                      <td style={{fontWeight:600}}>{inv.customerName}</td>
                      <td style={{fontSize:12}}>{inv.useRange?`${fmtDate(inv.dateStart)} – ${fmtDate(inv.dateEnd)}`:fmtDate(inv.date)}</td>
                      <td>{inv.eventType}</td>
                      <td style={{fontWeight:600}}>{fmt$(inv.grandTotal)}</td>
                      <td style={{fontWeight:600,color:inv.balanceDue>0?'var(--danger)':'var(--success)'}}>{fmt$(inv.balanceDue)}</td>
                      <td><span className={`badge badge-${inv.status}`}>{inv.status}</span></td>
                      <td style={{whiteSpace:'nowrap'}}>
                        <Btn className="btn-secondary btn-sm" style={{marginRight:4}} onClick={()=>setViewInv(inv)}>View</Btn>
                        <Btn className="btn-outline btn-sm" style={{marginRight:4}} onClick={()=>openCateringEdit(inv)}>Edit</Btn>
                        <Btn className="btn-outline btn-sm" style={{marginRight:4}} onClick={()=>copyInvoice(inv)}>Copy</Btn>
                        {inv.status!=='paid'&&<Btn className="btn-success btn-sm" style={{marginRight:4}} onClick={()=>markPaid(inv.id)}>Paid</Btn>}
                        {isAdmin&&<Btn className="btn-danger btn-sm" onClick={()=>setConfirmId(inv.id)}>Delete</Btn>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      }

      {/* Create Form */}
      <Modal open={showForm} onClose={()=>{setShowForm(false);setEditingCateringId(null);}} title={editingCateringId ? `Edit Catering Invoice ${editingCateringId}` : 'New Catering Invoice'} wide>
        <div style={{fontWeight:700,color:'var(--brown)',marginBottom:8,fontSize:14}}>Customer</div>
        <div className="grid-2 mb-2">
          <FS label="Existing Customer" value={form.customerId} onChange={e=>selCust(e.target.value)}>
            <option value="">— New Customer —</option>
            {customers.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
          </FS>
          <FI label="Customer Name *" value={form.customerName} onChange={e=>{
            const name=e.target.value;
            const match=customers.find(c=>c.name.toLowerCase()===name.toLowerCase());
            if(match){
              // Auto-fill contact info + suggest event type / business from
              // the customer's most recent invoice so a repeat booking is one
              // step instead of seven.
              const recent = recentInvoiceFor(match.id);
              setForm(f=>({
                ...f,
                customerName:name,
                customerId:match.id,
                customerPhone:f.customerPhone||match.phone||'',
                customerEmail:f.customerEmail||match.email||'',
                customerAddress:f.customerAddress||match.address||'',
                eventType: f.eventType && f.eventType !== 'Catering' ? f.eventType : (recent?.eventType || f.eventType),
                business: f.business || recent?.business || selectedBusiness,
              }));
            } else {
              setForm(f=>({...f,customerName:name,customerId:''}));
            }
          }} placeholder="Full name" suggestions={customers.map(c=>c.name)} />
        </div>
        <div className="grid-2 mb-3">
          <FI label="Phone" value={form.customerPhone} onChange={e=>setForm(f=>({...f,customerPhone:e.target.value}))} />
          <FI label="Email" type="email" value={form.customerEmail} onChange={e=>setForm(f=>({...f,customerEmail:e.target.value}))} />
        </div>
        <div className="mb-4">
          <FI label="Customer Address" value={form.customerAddress||''} onChange={e=>setForm(f=>({...f,customerAddress:e.target.value}))} placeholder="Street, City, State ZIP" />
        </div>

        <div style={{fontWeight:700,color:'var(--brown)',marginBottom:8,fontSize:14}}>Event Details</div>
        <div className="grid-2 mb-3">
          <FI label="Event Type" value={form.eventType} onChange={e=>setForm(f=>({...f,eventType:e.target.value}))} placeholder="Wedding, Corporate, Birthday…" suggestions={eventTypeSuggestions} />
          <FS label="Business Entity" value={form.business} onChange={e=>setForm(f=>({...f,business:e.target.value}))}>
            {Object.entries(BUSINESSES).map(([k,v])=><option key={k} value={k}>{v.name}</option>)}
          </FS>
        </div>
        <div className="mb-3">
          <FI label="Guest Count (optional)" type="number" min="1" step="1" value={form.guestCount} onChange={e=>setForm(f=>({...f,guestCount:e.target.value}))} placeholder="e.g. 150" />
        </div>
        <div className="mb-4">
          <div className="mb-2"><Toggle checked={form.useRange} onChange={v=>setForm(f=>({...f,useRange:v}))} label="Date range (multi-day event)" /></div>
          <div className="grid-2">
            {form.useRange
              ?<><FI label="Start Date" type="date" value={form.dateStart} onChange={e=>setForm(f=>({...f,dateStart:e.target.value}))} /><FI label="End Date" type="date" value={form.dateEnd} onChange={e=>setForm(f=>({...f,dateEnd:e.target.value}))} /></>
              :<FI label="Event Date" type="date" value={form.date} onChange={e=>setForm(f=>({...f,date:e.target.value}))} />}
          </div>
        </div>

        <datalist id={caterDescListId}>
          {caterLineDescSuggestions.map(s => <option key={s} value={s} />)}
        </datalist>
        <div style={{fontWeight:700,color:'var(--brown)',marginBottom:8,fontSize:14}}>Line Items</div>
        <div className="mb-3">
          {form.lineItems.map((l,i)=>(
            <div key={i} className="flex gap-2 mb-2" style={{alignItems:'center',flexWrap:'wrap'}}>
              <input className="input" placeholder="Description" value={l.description} onChange={e=>setLine(i,'description',e.target.value)} style={{flex:'4 1 180px'}} list={caterDescListId} />
              <input className="input" placeholder="Qty" type="number" min="0" step="0.01" value={l.quantity} onChange={e=>setLine(i,'quantity',e.target.value)} style={{flex:'1 1 60px'}} />
              <input className="input" placeholder="Unit Price" type="number" min="0" step="0.01" value={l.unitPrice} onChange={e=>setLine(i,'unitPrice',e.target.value)} style={{flex:'1 1 80px'}} />
              <span style={{minWidth:64,textAlign:'right',fontSize:13,color:'var(--brown)',fontWeight:600}}>{fmt$(T.lines[i]?.total||0)}</span>
              {form.lineItems.length>1&&<Btn className="btn-danger btn-sm" onClick={()=>setForm(f=>({...f,lineItems:f.lineItems.filter((_,x)=>x!==i)}))}>✕</Btn>}
            </div>
          ))}
          <Btn className="btn-outline btn-sm" onClick={()=>setForm(f=>({...f,lineItems:[...f.lineItems,{description:'',quantity:'1',unitPrice:''}]}))}>+ Add Line</Btn>
        </div>

        <div style={{background:'var(--cream)',padding:16,borderRadius:8,marginBottom:14}}>
          <div className="flex-between mb-2"><span>Subtotal</span><strong>{fmt$(T.sub)}</strong></div>
          <div className="flex-between mb-2">
            <Toggle checked={form.ccFeeEnabled} onChange={v=>setForm(f=>({...f,ccFeeEnabled:v}))} label="Credit Card Fee (3.5%)" />
            <span style={{color:form.ccFeeEnabled?'var(--brown)':'#bbb'}}>{fmt$(T.cc)}</span>
          </div>
          <div className="flex-between mb-2">
            <Toggle checked={form.taxEnabled} onChange={v=>setForm(f=>({...f,taxEnabled:v}))} label={`Sales Tax (${(T.fb.taxRate*100).toFixed(3)}%)`} />
            <span style={{color:form.taxEnabled?'var(--brown)':'#bbb'}}>{fmt$(T.taxAmt)}</span>
          </div>
          <hr className="divider" />
          <div className="flex-between mb-3" style={{fontWeight:700,fontSize:17,color:'var(--brown)'}}>
            <span>Grand Total</span><span>{fmt$(T.grand)}</span>
          </div>
          <div className="flex-between" style={{alignItems:'center',marginBottom:8}}>
            <label style={{margin:0}}>Deposit / Amount Paid</label>
            <input className="input" type="number" min="0" step="0.01" value={form.deposit} onChange={e=>setForm(f=>({...f,deposit:e.target.value}))} style={{width:130}} placeholder="0.00" />
          </div>
          <div className="flex-between" style={{fontWeight:700,fontSize:15,color:T.balance>0?'var(--danger)':'var(--success)'}}>
            <span>Balance Due</span><span>{fmt$(T.balance)}</span>
          </div>
        </div>

        <div style={{background:'#FFF3CD',padding:10,borderRadius:6,marginBottom:14,fontSize:13,color:'#856404'}}>
          <strong>Payment Terms: </strong>{PAYMENT_TERMS.join('  ·  ')}
        </div>
        <div className="field"><label>Notes</label><textarea className="input" rows={2} value={form.notes} onChange={e=>setForm(f=>({...f,notes:e.target.value}))} /></div>
        <div className="flex gap-2" style={{justifyContent:'flex-end',marginTop:8}}>
          <Btn className="btn-outline" onClick={()=>{setShowForm(false);setEditingCateringId(null);}}>Cancel</Btn>
          <Btn className="btn-primary" onClick={saveInvoice}>{editingCateringId ? 'Save Changes' : 'Create Invoice'}</Btn>
        </div>
      </Modal>

      {/* View Modal */}
      <Modal open={!!viewInv} onClose={()=>setViewInv(null)} title={`Catering Invoice ${viewInv?.id||''}`} wide closeOnBackdrop>
        {viewInv&&(()=>{
          const brand = getInvoiceBranding(viewInv, brandingMap);
          return (
          <div id={`catering-view-${viewInv.id}`} style={{fontFamily:'Georgia,serif'}}>
            <div className="flex-between mb-4" style={{flexWrap:'wrap',gap:8}}>
              <div style={{display:'flex',alignItems:'center',gap:10}}>
                <BrandMark brand={brand} />
                <div>
                  <div style={{fontWeight:700,fontSize:19,color:'var(--brown)'}}>{brand.name}</div>
                  <div style={{fontSize:12,color:'#888'}}>{brand.address}</div>
                  {brand.phone&&<div style={{fontSize:12,color:'#888'}}>Tel: {brand.phone}</div>}
                  {brand.email&&<div style={{fontSize:12,color:'#888'}}>{brand.email}</div>}
                </div>
              </div>
              <div style={{textAlign:'right',fontSize:13}}>
                <div style={{fontSize:18,fontWeight:700,color:'var(--brown)'}}>{viewInv.id}</div>
                <div>{viewInv.useRange?`${fmtDate(viewInv.dateStart)} – ${fmtDate(viewInv.dateEnd)}`:fmtDate(viewInv.date)}</div>
                <div><strong>Event:</strong> {viewInv.eventType}</div>
                {viewInv.guestCount&&<div><strong>Guests:</strong> {viewInv.guestCount} · <strong>Per head:</strong> {fmt$(viewInv.grandTotal/viewInv.guestCount)}</div>}
              </div>
            </div>
            <div style={{padding:'10px 14px',background:'var(--cream)',borderRadius:6,marginBottom:16,fontSize:14}}>
              <strong style={{fontSize:15}}>{viewInv.customerName}</strong>
              {viewInv.customerPhone&&<div>Tel: {viewInv.customerPhone}</div>}
              {viewInv.customerEmail&&<div>{viewInv.customerEmail}</div>}
              {viewInv.customerAddress&&<div style={{fontSize:12,color:'#666',marginTop:2}}>{viewInv.customerAddress}</div>}
            </div>
            <div className="tbl-wrap" style={{marginBottom:16}}>
              <table><thead><tr><th>Description</th><th>Qty</th><th>Unit Price</th><th>Total</th></tr></thead>
                <tbody>{viewInv.lineItems.map((l,i)=><tr key={i}><td>{l.description}</td><td>{l.qty??l.quantity}</td><td>{fmt$(l.price??l.unitPrice)}</td><td style={{fontWeight:600}}>{fmt$(l.total)}</td></tr>)}</tbody>
              </table>
            </div>
            <div style={{textAlign:'right'}}>
              <div>Subtotal: {fmt$(viewInv.subtotal)}</div>
              {viewInv.ccFeeEnabled&&<div>CC Fee (3.5%): {fmt$(viewInv.ccFee)}</div>}
              {viewInv.taxEnabled&&<div>Tax ({(viewInv.taxRate*100).toFixed(3)}%): {fmt$(viewInv.taxAmount)}</div>}
              <hr className="divider" />
              <div style={{fontWeight:700,fontSize:18,color:'var(--brown)'}}>Total: {fmt$(viewInv.grandTotal)}</div>
              {viewInv.deposit>0&&<div style={{color:'var(--success)'}}>Deposit Received: {fmt$(viewInv.deposit)}</div>}
              <div style={{fontWeight:700,color:viewInv.balanceDue>0?'var(--danger)':'var(--success)',fontSize:15}}>Balance Due: {fmt$(viewInv.balanceDue)}</div>
            </div>
            {(() => {
              const payments = viewInv.payments || [];
              const initDep = parseFloat(viewInv.deposit) || 0;
              const allPayments = [
                ...(initDep > 0 ? [{ id: '__dep', date: viewInv.createdAt?.slice(0,10) || viewInv.date || '', amount: initDep, note: 'Initial deposit' }] : []),
                ...payments
              ];
              const remaining = balanceFor(viewInv);
              return (
                <div style={{marginTop:14,padding:'10px 14px',background:'#F8F3EE',borderRadius:6,fontSize:13}}>
                  <div style={{fontWeight:700,color:'var(--brown)',marginBottom:8,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                    <span>Payment History</span>
                    {remaining > 0 && <button className="btn btn-success btn-sm" onClick={()=>{setPayingInv(viewInv);setPayForm({amount:String(+remaining.toFixed(2)),date:today(),note:''});}}>+ Record Payment</button>}
                  </div>
                  {allPayments.length === 0 && <div style={{color:'#999',fontSize:12}}>No payments recorded yet.</div>}
                  {allPayments.map(p => (
                    <div key={p.id} style={{display:'flex',justifyContent:'space-between',padding:'3px 0',borderBottom:'1px solid #EDD9B0',gap:8}}>
                      <span style={{color:'#666',fontSize:12}}>{fmtDate(p.date)}{p.note ? ` · ${p.note}` : ''}</span>
                      <span style={{fontWeight:600,color:'var(--success)'}}>{fmt$(p.amount)}</span>
                    </div>
                  ))}
                  {allPayments.length > 0 && (
                    <div style={{display:'flex',justifyContent:'space-between',marginTop:6,fontWeight:700}}>
                      <span>Total Paid</span><span style={{color:'var(--success)'}}>{fmt$(+(totalPaidFor(viewInv)).toFixed(2))}</span>
                    </div>
                  )}
                </div>
              );
            })()}
            <div style={{marginTop:14,padding:10,background:'#FFF3CD',borderRadius:6,fontSize:12,color:'#856404'}}>
              <strong>Payment Terms: </strong>{PAYMENT_TERMS.join('  ·  ')}
            </div>
            {viewInv.notes&&<div style={{marginTop:8,fontSize:13,color:'#666',fontStyle:'italic'}}>Notes: {viewInv.notes}</div>}
            {items.length > 0 && (() => {
              const catMap = {};
              (viewInv.lineItems || []).forEach(l => {
                const desc = (l.description || '').trim();
                const it = items.find(i => i.name.toLowerCase() === desc.toLowerCase());
                const cat = it?.category || null;
                if (!cat) return;
                const total = safeQty(l.qty ?? l.quantity) * (parseFloat(l.price ?? l.unitPrice) || 0);
                catMap[cat] = (catMap[cat] || 0) + total;
              });
              const cats = Object.entries(catMap).sort((a, b) => b[1] - a[1]);
              if (cats.length < 2) return null;
              return (
                <div style={{marginTop:12,padding:'8px 12px',background:'#FDF6EE',border:'1px solid #EDD9B0',borderRadius:6,fontSize:12.5}}>
                  <div style={{fontWeight:700,color:'var(--brown)',marginBottom:6}}>By Category</div>
                  {cats.map(([cat, sub]) => (
                    <div key={cat} style={{display:'flex',justifyContent:'space-between',padding:'2px 0',borderBottom:'1px solid #F0E4CC'}}>
                      <span style={{color:'#5a3010'}}>{cat}</span><span style={{fontWeight:600}}>{fmt$(+sub.toFixed(2))}</span>
                    </div>
                  ))}
                </div>
              );
            })()}
            {items.length > 0 && (() => {
              let estCost = 0; let matched = 0;
              (viewInv.lineItems || []).forEach(l => {
                const desc = (l.description || '').trim();
                const it = items.find(i => i.name.toLowerCase() === desc.toLowerCase());
                if (it) {
                  const price = it.sellers?.[0]?.price || 0;
                  estCost += price * safeQty(l.qty ?? l.quantity);
                  matched++;
                }
              });
              if (matched === 0) return null;
              const rev = viewInv.grandTotal || 0;
              const margin = rev > 0 ? ((rev - estCost) / rev * 100).toFixed(1) : null;
              const color = margin >= 50 ? '#15803D' : margin >= 25 ? '#92400E' : '#DC2626';
              return (
                <div style={{marginTop:10,padding:'8px 12px',background:'#F0FDF4',border:'1px solid #BBF7D0',borderRadius:6,fontSize:12.5}}>
                  <strong>Est. Ingredient Cost:</strong> {fmt$(+estCost.toFixed(2))} ({matched} item{matched!==1?'s':''} matched)
                  {margin!=null&&<span style={{marginLeft:10,color,fontWeight:700}}>→ {margin}% margin</span>}
                </div>
              );
            })()}
            <div className="flex gap-2" style={{justifyContent:'flex-end',marginTop:16,flexWrap:'wrap'}}>
              {viewInv.customerEmail && balanceFor(viewInv) > 0 && (() => {
                const bal = balanceFor(viewInv);
                const subj = encodeURIComponent(`Payment Reminder: Invoice ${viewInv.id}`);
                const body = encodeURIComponent(
                  `Dear ${viewInv.customerName},\n\nThis is a friendly reminder that invoice ${viewInv.id} has an outstanding balance of $${bal.toFixed(2)}.\n\nEvent: ${viewInv.eventType || 'Catering'} on ${viewInv.date || (viewInv.dateStart + (viewInv.dateEnd ? ' – ' + viewInv.dateEnd : ''))}\n\nPlease remit payment at your earliest convenience.\n\nThank you.`
                );
                return <a className="btn btn-outline btn-sm" href={`mailto:${viewInv.customerEmail}?subject=${subj}&body=${body}`}>✉ Send Reminder</a>;
              })()}
              <Btn className="btn-outline" onClick={()=>printOneCatering(viewInv)}>🖨 Print / Save PDF</Btn>
              <Btn className="btn-outline" onClick={()=>copyInvoice(viewInv)}>Copy</Btn>
              <Btn className="btn-secondary" onClick={()=>{const v=viewInv; setViewInv(null); openCateringEdit(v);}}>Edit</Btn>
              <Btn className="btn-primary" onClick={()=>setViewInv(null)}>Close</Btn>
            </div>
          </div>
          );
        })()}
      </Modal>

      <Modal open={!!payingInv} onClose={()=>setPayingInv(null)} title={`Record Payment — ${payingInv?.id||''}`}>
        {payingInv && (
          <>
            <p style={{fontSize:13,color:'#666',marginBottom:12}}>
              Grand total: <strong>{fmt$(payingInv.grandTotal)}</strong> · Remaining: <strong style={{color:'var(--danger)'}}>{fmt$(+(balanceFor(payingInv)).toFixed(2))}</strong>
            </p>
            <div className="grid-2 mb-3">
              <div className="field"><label>Amount *</label><input className="input" type="number" min="0.01" step="0.01" value={payForm.amount} onChange={e=>setPayForm(f=>({...f,amount:e.target.value}))} placeholder="0.00" /></div>
              <div className="field"><label>Payment Date</label><input className="input" type="date" value={payForm.date} onChange={e=>setPayForm(f=>({...f,date:e.target.value}))} /></div>
            </div>
            <div className="field mb-3"><label>Note (optional)</label><input className="input" value={payForm.note} onChange={e=>setPayForm(f=>({...f,note:e.target.value}))} placeholder="e.g. Balance payment, Second installment…" /></div>
            <div className="flex gap-2" style={{justifyContent:'flex-end'}}>
              <button className="btn btn-outline" onClick={()=>setPayingInv(null)}>Cancel</button>
              <button className="btn btn-success" onClick={recordPayment}>Record Payment</button>
            </div>
          </>
        )}
      </Modal>

      <Confirm
        open={!!confirmId}
        title="Delete catering invoice?"
        message={
          pendingDeleteCatering
            ? `Permanently remove invoice ${pendingDeleteCatering.id} (${pendingDeleteCatering.customerName || 'customer'}) on this device?`
            : 'Permanently remove this catering invoice on this device?'
        }
        detail="This cannot be undone here. Export a backup from Settings if you might need to recover this record."
        dangerCode="DMG-E012 (local data change)"
        confirmLabel="Delete invoice"
        onConfirm={() => deleteInv(confirmId)}
        onCancel={() => setConfirmId(null)}
      />
    </div>
  );
}

