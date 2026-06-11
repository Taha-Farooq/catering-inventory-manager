import React, { useState, useEffect, useMemo } from 'react';
import * as XLSX from 'xlsx';
import { showToast } from '../toastContext.jsx';
import { BrandMark } from '../ui/BrandMark.jsx';
import Modal from '../ui/Modal.jsx';
import { BUSINESSES, PAYMENT_TERMS } from '../constants.js';
import { fmt$, fmtDate } from '../formatters.js';
import { load, save, today } from '../utils/storage.js';
import { logActivity } from '../utils/activity.js';
import { printInvoiceById, printHtmlDocument } from '../utils/print.js';
import { buildCateringInvoiceDoc, buildPurchaseInvoiceDoc, buildTransferInvoiceDoc } from '../utils/invoiceDoc.js';

function printArchivedInvoice(inv, brand) {
  const brandIn = brand || {};
  if (inv?._type === 'catering') return printHtmlDocument(buildCateringInvoiceDoc(inv, brandIn), `Catering Invoice ${inv.id}`);
  if (inv?._type === 'purchase') return printHtmlDocument(buildPurchaseInvoiceDoc(inv, brandIn), `Purchase Invoice ${inv.id}`);
  if (inv?._type === 'transfer') return printHtmlDocument(buildTransferInvoiceDoc(inv, brandIn), `Transfer Invoice ${inv.id}`);
  // Payroll archive falls through to the legacy in-place DOM print so the
  // on-screen JSX (rich, with employee tables) is preserved verbatim. Pay
  // stubs are produced from Check In/Out, which is the authoritative path.
  return printInvoiceById(`archive-view-${inv.id}`);
}

function Btn({ className='', children, ...p }) {
  return <button className={`btn ${className}`} {...p}>{children}</button>;
}

export default function InvoiceArchive({ getInvoiceBranding, purchaseInvoices, setPurchaseInvoices, cateringInvoices, setCateringInvoices, transferInvoices, setTransferInvoices, payrollInvoices, setPayrollInvoices, userRole, brandingMap, selectedBusiness }) {
  const isAdmin=userRole==='admin';
  const [typeF,setTypeF]=useState('all');
  const [statusF,setStatusF]=useState('all');
  const [bizF,setBizF]=useState(selectedBusiness||'all');
  const [search,setSearch]=useState('');
  const [dateFrom,setDateFrom]=useState('');
  const [dateTo,setDateTo]=useState('');
  const [datePreset,setDatePreset]=useState('');

  function applyPreset(preset) {
    const now = new Date();
    const fmt = d => d.toISOString().split('T')[0];
    if (preset === '7d') { const f=new Date(now); f.setDate(f.getDate()-6); setDateFrom(fmt(f)); setDateTo(fmt(now)); }
    else if (preset === '30d') { const f=new Date(now); f.setDate(f.getDate()-29); setDateFrom(fmt(f)); setDateTo(fmt(now)); }
    else if (preset === 'month') { const f=new Date(now.getFullYear(),now.getMonth(),1); const t=new Date(now.getFullYear(),now.getMonth()+1,0); setDateFrom(fmt(f)); setDateTo(fmt(t)); }
    else if (preset === 'lastmonth') { const f=new Date(now.getFullYear(),now.getMonth()-1,1); const t=new Date(now.getFullYear(),now.getMonth(),0); setDateFrom(fmt(f)); setDateTo(fmt(t)); }
    else { setDateFrom(''); setDateTo(''); }
    setDatePreset(preset === '' ? '' : preset);
    setPage(1);
  }
  const [confirmObj,setConfirmObj]=useState(null);
  const [viewInv,setViewInv]=useState(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(() => {
    const saved = parseInt(load('_archivePageSize', 25));
    return [10,25,50].includes(saved) ? saved : 25;
  });

  const all=useMemo(()=>{
    const p=purchaseInvoices.map(i=>({...i,_type:'purchase',_date:i.date}));
    const c=cateringInvoices.map(i=>({...i,_type:'catering',_date:i.date||i.dateStart}));
    const t=transferInvoices.map(i=>({...i,_type:'transfer',_date:i.date, supplier:`${i.from}${i.fromContact?` (${i.fromContact})`:''} -> ${i.to}${i.toContact?` (${i.toContact})`:''}`}));
    const y=(payrollInvoices||[]).map(i=>({...i,_type:'payroll',_date:i.date, customerName:i.employeeName || i.employeeUsername || ''}));
    return [...p,...c,...t,...y].sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||''));
  },[purchaseInvoices,cateringInvoices,transferInvoices,payrollInvoices]);

  const filtered=useMemo(()=>all.filter(inv=>{
    if(typeF!=='all'&&inv._type!==typeF) return false;
    if(statusF!=='all'&&inv.status!==statusF) return false;
    if(bizF!=='all'&&inv.business&&inv.business!==bizF) return false;
    const q=search.toLowerCase();
    if(q&&![(inv.customerName||''),(inv.supplier||''),inv.id].some(s=>s.toLowerCase().includes(q))) return false;
    if(dateFrom&&inv._date&&inv._date<dateFrom) return false;
    if(dateTo&&inv._date&&inv._date>dateTo) return false;
    return true;
  }),[all,typeF,statusF,bizF,search,dateFrom,dateTo]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const paginated = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  // Reset to page 1 whenever filters change
  useEffect(() => { setPage(1); }, [typeF, statusF, search, dateFrom, dateTo, pageSize]);

  const archiveDeleteSummary = useMemo(() => {
    if (!confirmObj) return '';
    const party = confirmObj.customerName || confirmObj.supplier || confirmObj.employeeName || '';
    return `${confirmObj._type || 'record'} · ${confirmObj.id}${party ? ` · ${party}` : ''}`;
  }, [confirmObj]);

  function markPaid(inv){
    if(inv._type==='purchase'){const u=purchaseInvoices.map(x=>x.id===inv.id?{...x,status:'paid'}:x);setPurchaseInvoices(u);save('purchaseInvoices',u);}
    else if(inv._type==='catering'){const u=cateringInvoices.map(x=>x.id===inv.id?{...x,status:'paid',deposit:x.grandTotal,balanceDue:0}:x);setCateringInvoices(u);save('cateringInvoices',u);}
    else if(inv._type==='transfer'){const u=transferInvoices.map(x=>x.id===inv.id?{...x,status:'paid'}:x);setTransferInvoices(u);save('transferInvoices',u);}
    else {const u=(payrollInvoices||[]).map(x=>x.id===inv.id?{...x,status:'paid'}:x);setPayrollInvoices(u);save('payrollInvoices',u);}
    showToast('Invoice marked paid.');
    logActivity('mark_paid', 'Marked '+inv._type+' invoice paid '+inv.id);
  }
  function deleteInv({id,_type}){
    if(_type==='purchase'){const u=purchaseInvoices.filter(x=>x.id!==id);setPurchaseInvoices(u);save('purchaseInvoices',u);}
    else if(_type==='catering'){const u=cateringInvoices.filter(x=>x.id!==id);setCateringInvoices(u);save('cateringInvoices',u);}
    else if(_type==='transfer'){const u=transferInvoices.filter(x=>x.id!==id);setTransferInvoices(u);save('transferInvoices',u);}
    else{const u=(payrollInvoices||[]).filter(x=>x.id!==id);setPayrollInvoices(u);save('payrollInvoices',u);}
    setConfirmObj(null);
    showToast('Invoice deleted.');
    logActivity('delete_invoice', 'Deleted '+_type+' invoice '+id);
  }

  const filtTotal=filtered.reduce((s,i)=>s+(i.total||i.grandTotal||0),0);
  const statusCounts = useMemo(() => ({
    paid: filtered.filter(i=>i.status==='paid').length,
    unpaid: filtered.filter(i=>i.status==='unpaid').length,
    partial: filtered.filter(i=>i.status==='partial').length
  }), [filtered]);

  function toArchiveRow(inv) {
    return {
      'Invoice #': inv.id,
      Type: inv._type,
      Party: inv.customerName || inv.supplier || '',
      Date: inv._date || '',
      Status: inv.status || '',
      Total: +(inv.total || inv.grandTotal || 0).toFixed(2)
    };
  }
  function exportArchiveExcel() {
    const rows = filtered.map(toArchiveRow);
    const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [toArchiveRow({id:'',_type:'',customerName:'',supplier:'',_date:'',status:'',total:0,grandTotal:0})]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Archive');
    XLSX.writeFile(wb, `invoice-archive-${today()}.xlsx`);
    logActivity('export_xlsx', 'Exported invoice archive Excel');
    showToast('Archive exported as Excel.');
  }
  function exportArchiveCsv() {
    const rows = filtered.map(toArchiveRow);
    const header = ['Invoice #','Type','Party','Date','Status','Total'];
    const esc = v => `"${String(v ?? '').replace(/"/g,'""')}"`;
    const csv = [header.map(esc).join(',')]
      .concat(rows.map(r => header.map(h => esc(r[h])).join(',')))
      .join('\n');
    const blob = new Blob([csv], { type:'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `invoice-archive-${today()}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    logActivity('export_csv', 'Exported invoice archive CSV');
    showToast('Archive exported as CSV.');
  }

  return (
    <div>
      <div className="flex-between mb-3 flex-wrap gap-2">
        <div className="section-title" style={{margin:0}}>Invoice Archive</div>
        <div className="flex gap-2">
          <Btn className="btn-outline btn-sm" onClick={exportArchiveCsv}>⬇ Export CSV</Btn>
          <Btn className="btn-success btn-sm" onClick={exportArchiveExcel}>⬇ Export Excel</Btn>
        </div>
      </div>
      <div className="card mb-4">
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(145px,1fr))',gap:12}}>
          <div className="field" style={{margin:0}}><label>Business</label>
            <select className="input" value={bizF} onChange={e=>{setBizF(e.target.value);setPage(1);}}>
              <option value="all">All Businesses</option>
              {Object.entries(BUSINESSES).map(([k,v])=><option key={k} value={k}>{v.name}</option>)}
            </select>
          </div>
          <div className="field" style={{margin:0}}><label>Type</label>
            <select className="input" value={typeF} onChange={e=>setTypeF(e.target.value)}>
              <option value="all">All Types</option><option value="catering">Catering</option><option value="purchase">Purchase</option><option value="transfer">Transfer</option><option value="payroll">Payroll</option>
            </select>
          </div>
          <div className="field" style={{margin:0}}><label>Status</label>
            <select className="input" value={statusF} onChange={e=>setStatusF(e.target.value)}>
              <option value="all">All Status</option><option value="paid">Paid</option><option value="unpaid">Unpaid</option><option value="partial">Partial</option>
            </select>
          </div>
          <div className="field" style={{margin:0}}><label>Search</label><input className="input" placeholder="Customer, supplier, #…" value={search} onChange={e=>setSearch(e.target.value)} /></div>
          <div className="field" style={{margin:0}}><label>From</label><input className="input" type="date" value={dateFrom} onChange={e=>{setDateFrom(e.target.value);setDatePreset('');}} /></div>
          <div className="field" style={{margin:0}}><label>To</label><input className="input" type="date" value={dateTo} onChange={e=>{setDateTo(e.target.value);setDatePreset('');}} /></div>
        </div>
        <div style={{marginTop:8,display:'flex',flexWrap:'wrap',gap:6}}>
          {[['7d','Last 7d'],['30d','Last 30d'],['month','This Month'],['lastmonth','Last Month']].map(([k,label])=>(
            <Btn key={k} className="btn-sm" style={{background:datePreset===k?'var(--brown)':'#eee',color:datePreset===k?'#fff':'#555',borderRadius:12,padding:'2px 10px'}} onClick={()=>applyPreset(datePreset===k?'':k)}>{label}</Btn>
          ))}
          {(dateFrom||dateTo)&&<Btn className="btn-sm" style={{background:'#eee',color:'#666',borderRadius:12,padding:'2px 10px'}} onClick={()=>applyPreset('')}>✕ Clear Dates</Btn>}
        </div>
        <div style={{marginTop:10,fontSize:13,color:'#666',display:'flex',alignItems:'center',gap:10,flexWrap:'wrap'}}>
          <span>Showing <strong>{filtered.length}</strong> of {all.length} · Total: <strong style={{color:'var(--brown)'}}>{fmt$(filtTotal)}</strong></span>
          <span>Paid: <strong>{statusCounts.paid}</strong></span>
          <span>Unpaid: <strong>{statusCounts.unpaid}</strong></span>
          <span>Partial: <strong>{statusCounts.partial}</strong></span>
          <span style={{marginLeft:'auto',display:'flex',alignItems:'center',gap:6}}>
            Per page:
            <select className="input" style={{padding:'2px 6px',fontSize:12,width:'auto'}} value={pageSize}
              onChange={e=>{const n=parseInt(e.target.value);setPageSize(n);save('_archivePageSize',n);}}>
              <option value={10}>10</option><option value={25}>25</option><option value={50}>50</option>
            </select>
          </span>
          {(typeF!=='all'||statusF!=='all'||search||dateFrom||dateTo)&&
            <Btn className="btn-sm" style={{background:'#eee',color:'#666'}} onClick={()=>{setTypeF('all');setStatusF('all');setSearch('');setDateFrom('');setDateTo('');setDatePreset('');}}>✕ Clear Filters</Btn>}
        </div>
      </div>

      {filtered.length===0
        ? <div className="card empty-state">No invoices match the current filters.</div>
        : (
          <div className="card" style={{padding:0}}>
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>Invoice #</th><th>Type</th><th>Customer / Supplier</th><th>Date</th><th>Business</th><th>Total</th><th>Status</th><th>Actions</th></tr></thead>
                <tbody>
                  {paginated.map(inv=>(
                    <tr key={inv.id}>
                      <td style={{fontFamily:'monospace',fontWeight:700}}>{inv.id}</td>
                      <td><span style={{fontSize:11,padding:'2px 7px',borderRadius:10,fontWeight:600,background:inv._type==='catering'?'#E8F4FC':inv._type==='transfer'?'#EEF9F1':'#FFF0E0',color:inv._type==='catering'?'#2980b9':inv._type==='transfer'?'#1e7a3b':'var(--choc)'}}>{inv._type}</span></td>
                      <td style={{fontWeight:600}}>{inv.customerName||inv.supplier}</td>
                      <td style={{fontSize:12}}>{inv._type==='catering'&&inv.useRange?`${fmtDate(inv.dateStart)} – ${fmtDate(inv.dateEnd)}`:fmtDate(inv._date)}</td>
                      <td style={{fontSize:12,color:'#777'}}>{inv._type==='payroll' ? ((inv.invoiceStandard || 'PAYROLL_WEEKLY_V1') + ` · @${inv.employeeUsername || ''}`) : BUSINESSES[inv.business]?.name}</td>
                      <td style={{fontWeight:600}}>{fmt$(inv.total||inv.grandTotal)}</td>
                      <td><span className={`badge badge-${inv.status}`}>{inv.status}</span></td>
                      <td style={{whiteSpace:'nowrap'}}>
                        <Btn className="btn-secondary btn-sm" style={{marginRight:4}} onClick={()=>setViewInv(inv)}>View</Btn>
                        {inv.status!=='paid'&&<Btn className="btn-success btn-sm" style={{marginRight:4}} onClick={()=>markPaid(inv)}>Paid</Btn>}
                        {isAdmin&&<Btn className="btn-danger btn-sm" onClick={()=>setConfirmObj(inv)}>Delete</Btn>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      }
      {totalPages > 1 && (
        <div style={{display:'flex',alignItems:'center',justifyContent:'center',gap:8,marginTop:12,fontSize:13}}>
          <Btn className="btn-outline btn-sm" disabled={safePage<=1} onClick={()=>setPage(p=>Math.max(1,p-1))}>← Prev</Btn>
          <span style={{color:'#666'}}>Page <strong>{safePage}</strong> of <strong>{totalPages}</strong></span>
          <Btn className="btn-outline btn-sm" disabled={safePage>=totalPages} onClick={()=>setPage(p=>Math.min(totalPages,p+1))}>Next →</Btn>
        </div>
      )}

      <Modal open={!!viewInv} onClose={()=>setViewInv(null)} title={`Invoice ${viewInv?.id||''}`} wide closeOnBackdrop>
        {viewInv&&(()=>{
          const brand = getInvoiceBranding(viewInv, brandingMap);
          return (
          <div id={`archive-view-${viewInv.id}`}>
            <div className="flex-between mb-4" style={{flexWrap:'wrap',gap:8}}>
              <div style={{display:'flex',alignItems:'center',gap:10}}>
                <BrandMark brand={brand} />
                <div>
                  <div style={{fontWeight:700,fontSize:16,color:'var(--brown)'}}>{brand.name}</div>
                  <div style={{fontSize:12,color:'#888'}}>{brand.address}</div>
                  {brand.phone&&<div style={{fontSize:12,color:'#888'}}>Tel: {brand.phone}</div>}
                  {brand.email&&<div style={{fontSize:12,color:'#888'}}>{brand.email}</div>}
                </div>
              </div>
              <div style={{textAlign:'right',fontSize:13}}>
                <div style={{fontWeight:700,fontSize:18,color:'var(--brown)'}}>{viewInv.id}</div>
                <div>{viewInv.customerName||viewInv.supplier||viewInv.employeeName}</div>
                <span className={`badge badge-${viewInv.status}`} style={{marginTop:4,display:'inline-block'}}>{viewInv.status}</span>
              </div>
            </div>
            {viewInv.lineItems&&(
              <div className="tbl-wrap" style={{marginBottom:14}}>
                <table><thead><tr><th>Description</th><th>Qty</th><th>Unit Price</th>{viewInv._type==='transfer'&&<th>15% Commission</th>}<th>Total</th></tr></thead>
                  <tbody>{viewInv.lineItems.map((l,i)=><tr key={i}><td>{l.description||l.item}</td><td>{l.qty??l.quantity}</td><td>{fmt$(l.price??l.unitPrice)}</td>{viewInv._type==='transfer'&&<td>{fmt$(l.commission||0)}</td>}<td style={{fontWeight:600}}>{fmt$(l.total)}</td></tr>)}</tbody>
                </table>
              </div>
            )}
            <div style={{textAlign:'right'}}>
              <div>Subtotal: {fmt$(viewInv.subtotal??viewInv.subTotal??0)}</div>
              {viewInv.ccFeeEnabled&&<div>CC Fee: {fmt$(viewInv.ccFee)}</div>}
              {viewInv._type==='transfer'&&<div>Commission: {fmt$(viewInv.commissionTotal||0)}</div>}
              {viewInv.taxEnabled&&<div>Tax: {fmt$(viewInv.taxAmount)}</div>}
              <div style={{fontWeight:700,fontSize:17,color:'var(--brown)',marginTop:6}}>Total: {fmt$(viewInv.total||viewInv.grandTotal)}</div>
              {viewInv.balanceDue!==undefined&&<div style={{color:viewInv.balanceDue>0?'var(--danger)':'var(--success)',fontWeight:600}}>Balance Due: {fmt$(viewInv.balanceDue)}</div>}
            </div>
            {viewInv._type==='catering'&&<div style={{marginTop:12,padding:10,background:'#FFF3CD',borderRadius:6,fontSize:12,color:'#856404'}}><strong>Payment Terms: </strong>{PAYMENT_TERMS.join('  ·  ')}</div>}
            {viewInv._type==='payroll'&&(
              <div style={{marginTop:12,padding:12,background:'#E8F4FC',borderRadius:6,fontSize:13,color:'#1e4f72'}}>
                <table style={{width:'100%',borderCollapse:'collapse'}}>
                  <tbody>
                    <tr><td style={{padding:'5px 8px',border:'1px solid #c8e0f0'}}>Employee</td><td style={{padding:'5px 8px',border:'1px solid #c8e0f0',fontWeight:600}}>{viewInv.employeeName||viewInv.customerName}{viewInv.employeeUsername?` (@${viewInv.employeeUsername})`:''}</td></tr>
                    {(viewInv.periodStart||viewInv.periodEnd)&&<tr><td style={{padding:'5px 8px',border:'1px solid #c8e0f0'}}>Pay Period</td><td style={{padding:'5px 8px',border:'1px solid #c8e0f0'}}>{fmtDate(viewInv.periodStart||viewInv.date)} – {fmtDate(viewInv.periodEnd||viewInv.date)}</td></tr>}
                    <tr><td style={{padding:'5px 8px',border:'1px solid #c8e0f0'}}>Regular Hours</td><td style={{padding:'5px 8px',border:'1px solid #c8e0f0'}}>{viewInv.regularHours||0}</td></tr>
                    {+viewInv.overtimeHours>0&&<tr><td style={{padding:'5px 8px',border:'1px solid #c8e0f0'}}>Overtime Hours (1.5×)</td><td style={{padding:'5px 8px',border:'1px solid #c8e0f0'}}>{viewInv.overtimeHours}</td></tr>}
                    <tr><td style={{padding:'5px 8px',border:'1px solid #c8e0f0'}}>Hourly Rate</td><td style={{padding:'5px 8px',border:'1px solid #c8e0f0'}}>{fmt$(viewInv.hourlyRate||0)}/hr</td></tr>
                    <tr><td style={{padding:'5px 8px',border:'1px solid #c8e0f0',fontWeight:700}}>Total Pay</td><td style={{padding:'5px 8px',border:'1px solid #c8e0f0',fontWeight:700,color:'var(--brown)'}}>{fmt$(viewInv.total||0)}</td></tr>
                  </tbody>
                </table>
              </div>
            )}
            <div className="flex gap-2" style={{justifyContent:'flex-end',marginTop:16}}>
              <Btn className="btn-outline" onClick={()=>{ printArchivedInvoice(viewInv, getInvoiceBranding(viewInv, brandingMap) || {}); logActivity('print_invoice', `Printed archived ${viewInv._type || ''} invoice ${viewInv.id}`); }}>🖨 Print / Save PDF</Btn>
              <Btn className="btn-primary" onClick={()=>setViewInv(null)}>Close</Btn>
            </div>
          </div>
          );
        })()}
      </Modal>
      <Confirm
        open={!!confirmObj}
        title="Delete from archive?"
        message={
          confirmObj
            ? `Permanently remove this record from this device?\n\n${archiveDeleteSummary}`
            : 'Permanently remove this record from this device?'
        }
        detail="This cannot be undone here. Export a backup from Settings if you might need to recover this invoice or payroll record."
        dangerCode="DMG-E012 (local data change)"
        confirmLabel="Delete permanently"
        wide
        onConfirm={() => deleteInv(confirmObj)}
        onCancel={() => setConfirmObj(null)}
      />
    </div>
  );
}

