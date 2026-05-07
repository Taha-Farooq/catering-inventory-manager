import React, { useState, useMemo, useId } from 'react';
import { showToast } from '../toastContext.jsx';
import { BrandMark } from '../ui/BrandMark.jsx';
import Modal from '../ui/Modal.jsx';
import { BUSINESSES, PAYMENT_TERMS } from '../constants.js';
import { fmt$, fmtDate, safeQty, uniqSuggestions } from '../formatters.js';
import { save, uid, today } from '../utils/storage.js';
import { logActivity } from '../utils/activity.js';
import { printInvoiceById } from '../utils/print.js';
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
    eventType:'Catering',business:selectedBusiness,
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

  function setLine(i,f2,v){setForm(f=>{const l=[...f.lineItems];l[i]={...l[i],[f2]:v};return{...f,lineItems:l};});}
  function selCust(id){const c=customers.find(x=>x.id===id);if(c)setForm(f=>({...f,customerId:c.id,customerName:c.name,customerPhone:c.phone||'',customerEmail:c.email||'',customerAddress:c.address||''}));else setForm(f=>({...f,customerId:'',customerName:'',customerPhone:'',customerEmail:'',customerAddress:''}));}

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
      lineItems: lines,
      ccFeeEnabled: !!inv.ccFeeEnabled,
      taxEnabled: inv.taxEnabled !== false,
      deposit: inv.deposit != null && inv.deposit !== '' ? String(inv.deposit) : '',
      notes: inv.notes || '',
    });
    setEditingCateringId(inv.id);
    setShowForm(true);
  }

  function saveInvoice(){
    if (!form.customerName.trim()){showToast('Customer name is required. [DMG-E006]','error');return;}
    const valid=T.lines.filter(l=>l.description.trim());
    if (!valid.length){showToast('Add at least one line item with a description.','error');return;}
    if (T.dep<0){showToast('Deposit cannot be negative.','error');return;}
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
        eventType:form.eventType,lineItems:valid,subtotal:T.sub,
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
      eventType:form.eventType,lineItems:valid,subtotal:T.sub,
      ccFeeEnabled:form.ccFeeEnabled,ccFee:T.cc,taxEnabled:form.taxEnabled,taxRate:T.fb.taxRate,taxAmount:T.taxAmt,
      grandTotal:T.grand,deposit:T.dep,balanceDue:T.balance,status,notes:form.notes,createdAt:today()
    };
    const u=[...cateringInvoices,inv];setCateringInvoices(u);save('cateringInvoices',u);
    setShowForm(false);setForm(blankF());
    showToast('Catering invoice created.');
    logActivity('create_invoice', 'Created catering invoice ' + inv.id);
  }

  function deleteInv(id){const u=cateringInvoices.filter(x=>x.id!==id);setCateringInvoices(u);save('cateringInvoices',u);setConfirmId(null);showToast('Catering invoice deleted.');logActivity('delete_invoice','Deleted catering invoice '+id);}
  function markPaid(id){const u=cateringInvoices.map(x=>x.id===id?{...x,status:'paid',deposit:x.grandTotal,balanceDue:0}:x);setCateringInvoices(u);save('cateringInvoices',u);showToast('Catering invoice marked paid.');logActivity('mark_paid','Marked catering invoice paid '+id);}

  const [showAllBiz, setShowAllBiz] = useState(false);
  const visibleCatering = showAllBiz ? [...cateringInvoices].reverse() : [...cateringInvoices].reverse().filter(i=>(!i.business||i.business===selectedBusiness));

  return (
    <div>
      <div className="flex-between mb-4 flex-wrap gap-2">
        <div className="section-title" style={{margin:0}}>Catering Invoices — {BUSINESSES[selectedBusiness]?.name||selectedBusiness}</div>
        <div className="flex gap-2 flex-wrap" style={{alignItems:'center'}}>
          <label style={{fontSize:13,color:'#666',display:'flex',alignItems:'center',gap:5,cursor:'pointer'}}>
            <input type="checkbox" checked={showAllBiz} onChange={e=>setShowAllBiz(e.target.checked)} />
            All businesses
          </label>
          <Btn className="btn-primary" onClick={()=>{setEditingCateringId(null);setForm(blankF());setShowForm(true);}}>+ New Invoice</Btn>
        </div>
      </div>

      {visibleCatering.length===0
        ? <div className="card empty-state">{cateringInvoices.length===0 ? 'No catering invoices yet. Click "+ New Invoice" to create one.' : 'No invoices for this business. Use "All businesses" to see others.'}</div>
        : (
          <div className="card" style={{padding:0}}>
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>Invoice #</th><th>Customer</th><th>Event Date</th><th>Event</th><th>Total</th><th>Balance Due</th><th>Status</th><th>Actions</th></tr></thead>
                <tbody>
                  {visibleCatering.map(inv=>(
                    <tr key={inv.id}>
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
          <FI label="Customer Name *" value={form.customerName} onChange={e=>setForm(f=>({...f,customerName:e.target.value,customerId:''}))} placeholder="Full name" />
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
        {viewInv&&(
          <div id={`catering-view-${viewInv.id}`} style={{fontFamily:'Georgia,serif'}}>
            <div className="flex-between mb-4" style={{flexWrap:'wrap',gap:8}}>
              <div style={{display:'flex',alignItems:'center',gap:10}}>
                <BrandMark brand={getInvoiceBranding(viewInv, brandingMap)} />
                <div>
                  <div style={{fontWeight:700,fontSize:19,color:'var(--brown)'}}>{getInvoiceBranding(viewInv, brandingMap).name}</div>
                  <div style={{fontSize:12,color:'#888'}}>{getInvoiceBranding(viewInv, brandingMap).address}</div>
                  {getInvoiceBranding(viewInv, brandingMap).phone&&<div style={{fontSize:12,color:'#888'}}>Tel: {getInvoiceBranding(viewInv, brandingMap).phone}</div>}
                  {getInvoiceBranding(viewInv, brandingMap).email&&<div style={{fontSize:12,color:'#888'}}>{getInvoiceBranding(viewInv, brandingMap).email}</div>}
                </div>
              </div>
              <div style={{textAlign:'right',fontSize:13}}>
                <div style={{fontSize:18,fontWeight:700,color:'var(--brown)'}}>{viewInv.id}</div>
                <div>{viewInv.useRange?`${fmtDate(viewInv.dateStart)} – ${fmtDate(viewInv.dateEnd)}`:fmtDate(viewInv.date)}</div>
                <div><strong>Event:</strong> {viewInv.eventType}</div>
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
            <div style={{marginTop:14,padding:10,background:'#FFF3CD',borderRadius:6,fontSize:12,color:'#856404'}}>
              <strong>Payment Terms: </strong>{PAYMENT_TERMS.join('  ·  ')}
            </div>
            {viewInv.notes&&<div style={{marginTop:8,fontSize:13,color:'#666',fontStyle:'italic'}}>Notes: {viewInv.notes}</div>}
            <div className="flex gap-2" style={{justifyContent:'flex-end',marginTop:16}}>
              <Btn className="btn-outline" onClick={()=>printInvoiceById(`catering-view-${viewInv.id}`)}>🖨 Print / Save PDF</Btn>
              <Btn className="btn-secondary" onClick={()=>{const v=viewInv; setViewInv(null); openCateringEdit(v);}}>Edit</Btn>
              <Btn className="btn-primary" onClick={()=>setViewInv(null)}>Close</Btn>
            </div>
          </div>
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

