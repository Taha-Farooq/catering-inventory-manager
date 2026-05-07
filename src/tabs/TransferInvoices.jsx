import React, { useState, useMemo, useId } from 'react';
import * as XLSX from 'xlsx';
import { showToast } from '../toastContext.jsx';
import { BrandMark } from '../ui/BrandMark.jsx';
import Modal from '../ui/Modal.jsx';
import { fmt$, fmtDate, uniqSuggestions } from '../formatters.js';
import { save, today } from '../utils/storage.js';
import { logActivity } from '../utils/activity.js';
import { printInvoiceById } from '../utils/print.js';
import { nextTransferId } from '../utils/invoiceIds.js';

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

export default function TransferInvoices({ getInvoiceBranding, transferInvoices, setTransferInvoices, items = [], brandingMap }) {
  const COMMISSION_RATE = 0.15;
  const transferItemListId = useId();
  const itemSuggestions = useMemo(()=>{
    const fromInv = transferInvoices.flatMap(i=>(i.lineItems||[]).map(l=>(l.item||'').trim()).filter(Boolean));
    const names = items.map(i=>i.name);
    return uniqSuggestions(...fromInv, ...names);
  },[transferInvoices, items]);
  const blankForm = () => ({
    date: today(),
    from: 'Parathas & Platters - Hackensack',
    fromContact: 'Hackensack Branch',
    to: 'Parathas & Platters - Englewood',
    toContact: 'Englewood Branch',
    notes: '',
    lineItems: [{ quantity:'', item:'', price:'' }]
  });

  const [form, setForm] = useState(blankForm);
  const [showForm, setShowForm] = useState(false);
  const [editingTransferId, setEditingTransferId] = useState(null);
  const [viewId, setViewId] = useState(null);
  const [confirmId, setConfirmId] = useState(null);
  const [filterStatus, setFilterStatus] = useState('all');

  const pendingDeleteTransfer = useMemo(
    () => (confirmId ? transferInvoices.find((i) => i.id === confirmId) : null),
    [confirmId, transferInvoices]
  );
  const sorted = useMemo(() => [...transferInvoices].map(normalizeTransferInvoice).sort((a, b) => (b.date || '').localeCompare(a.date || '')), [transferInvoices]);
  const visible = useMemo(() => {
    let list = sorted;
    if (filterStatus !== 'all') list = list.filter(i => i.status === filterStatus);
    return list;
  }, [sorted, filterStatus]);
  const viewInv = sorted.find(x => x.id === viewId);

  function setLine(i, field, value) {
    setForm(f => {
      const lines = [...f.lineItems];
      lines[i] = { ...lines[i], [field]: value };
      return { ...f, lineItems: lines };
    });
  }
  function addLine() {
    setForm(f => ({ ...f, lineItems: [...f.lineItems, { quantity:'', item:'', price:'' }] }));
  }
  function removeLine(i) {
    setForm(f => ({ ...f, lineItems: f.lineItems.filter((_, idx) => idx !== i) }));
  }

  function openTransferEdit(inv) {
    const raw = transferInvoices.find((x) => x.id === inv.id) || inv;
    const linesSrc = Array.isArray(raw.lineItems) && raw.lineItems.length ? raw.lineItems : [{ quantity:'', item:'', price:'' }];
    const lines = linesSrc.map((li) => ({
      quantity: String(li.quantity ?? li.qty ?? ''),
      item: String(li.item ?? li.description ?? ''),
      price: li.price != null && li.price !== '' ? String(li.price) : li.unitPrice != null && li.unitPrice !== '' ? String(li.unitPrice) : '',
    }));
    setForm({
      date: raw.date || today(),
      from: raw.from || blankForm().from,
      fromContact: raw.fromContact || '',
      to: raw.to || blankForm().to,
      toContact: raw.toContact || '',
      notes: raw.notes || '',
      lineItems: lines.length ? lines : [{ quantity:'', item:'', price:'' }],
    });
    setEditingTransferId(raw.id);
    setShowForm(true);
  }

  function copyTransferInvoice(inv) {
    const raw = transferInvoices.find((x) => x.id === inv.id) || inv;
    const linesSrc = Array.isArray(raw.lineItems) && raw.lineItems.length ? raw.lineItems : [{ quantity:'', item:'', price:'' }];
    const lines = linesSrc.map((li) => ({
      quantity: String(li.quantity ?? li.qty ?? ''),
      item: String(li.item ?? li.description ?? ''),
      price: li.price != null && li.price !== '' ? String(li.price) : '',
    }));
    setForm({ date: today(), from: raw.from || blankForm().from, fromContact: raw.fromContact || '', to: raw.to || blankForm().to, toContact: raw.toContact || '', notes: raw.notes || '', lineItems: lines.length ? lines : [{ quantity:'', item:'', price:'' }] });
    setEditingTransferId(null);
    setViewId(null);
    setShowForm(true);
    showToast('Invoice copied — review and save as new.');
  }

  function closeTransferForm() {
    setShowForm(false);
    setEditingTransferId(null);
    setForm(blankForm());
  }
  function openNewTransferForm() {
    setEditingTransferId(null);
    setForm(blankForm());
    setShowForm(true);
  }

  function saveTransferInvoice() {
    const lines = form.lineItems
      .map(l => {
        const price = parseFloat(l.price) || 0;
        const commission = +(price * COMMISSION_RATE).toFixed(2);
        const total = +(price + commission).toFixed(2);
        return {
          quantity: (l.quantity || '').trim(),
          item: (l.item || '').trim(),
          price: +price.toFixed(2),
          commission,
          total
        };
      })
      .filter(l => l.item && (l.quantity || l.price > 0));
    if (!lines.length) { showToast('Add at least one line item. [DMG-E006]', 'error'); return; }
    if (!form.date) { showToast('Date is required. [DMG-E006]', 'error'); return; }

    const subTotal = +lines.reduce((s, l) => s + l.price, 0).toFixed(2);
    const commissionTotal = +lines.reduce((s, l) => s + l.commission, 0).toFixed(2);
    const grandTotal = +(subTotal + commissionTotal).toFixed(2);
    if (editingTransferId) {
      const prev = transferInvoices.find((x) => x.id === editingTransferId);
      if (!prev) { showToast('Invoice not found.', 'error'); return; }
      const invoice = {
        ...prev,
        date: form.date,
        from: form.from,
        fromContact: form.fromContact.trim(),
        to: form.to,
        toContact: form.toContact.trim(),
        notes: form.notes.trim(),
        lineItems: lines,
        commissionRate: COMMISSION_RATE,
        subTotal,
        commissionTotal,
        grandTotal,
      };
      const updated = transferInvoices.map((x) => (x.id === editingTransferId ? invoice : x));
      setTransferInvoices(updated);
      save('transferInvoices', updated);
      logActivity('edit_item', 'Updated transfer invoice ' + invoice.id);
      showToast('Transfer invoice updated.');
      setForm(blankForm());
      setShowForm(false);
      setEditingTransferId(null);
      return;
    }
    const invoice = {
      id: nextTransferId(form.date),
      invoiceType: 'pp_transfer',
      status: 'unpaid',
      date: form.date,
      from: form.from,
      fromContact: form.fromContact.trim(),
      to: form.to,
      toContact: form.toContact.trim(),
      notes: form.notes.trim(),
      lineItems: lines,
      commissionRate: COMMISSION_RATE,
      subTotal,
      commissionTotal,
      grandTotal,
      createdAt: new Date().toISOString()
    };
    const updated = [...transferInvoices, invoice];
    setTransferInvoices(updated);
    save('transferInvoices', updated);
    logActivity('create_invoice', 'Created transfer invoice ' + invoice.id);
    showToast('Transfer invoice created.');
    setForm(blankForm());
    setShowForm(false);
  }

  function deleteTransferInvoice(id) {
    const updated = transferInvoices.filter(x => x.id !== id);
    setTransferInvoices(updated);
    save('transferInvoices', updated);
    setConfirmId(null);
    logActivity('delete_invoice', 'Deleted transfer invoice ' + id);
    showToast('Transfer invoice deleted.');
  }
  function exportTransferExcel() {
    const byMonth = {};
    sorted.forEach(inv => {
      const d = inv.date || today();
      const k = d.slice(0,7);
      if (!byMonth[k]) byMonth[k] = [];
      inv.lineItems.forEach(li => {
        byMonth[k].push({
          Date: d,
          Quantity: li.quantity || '',
          Item: li.item || '',
          Price: li.price ?? 0,
          '15% commission': li.commission ?? 0,
          Total: li.total ?? 0,
          'Invoice #': inv.id
        });
      });
    });
    const wb = XLSX.utils.book_new();
    const monthKeys = Object.keys(byMonth).sort();
    if (!monthKeys.length) {
      const ws = XLSX.utils.json_to_sheet([{ Date:'', Quantity:'', Item:'', Price:'', '15% commission':'', Total:'', 'Invoice #':'' }]);
      XLSX.utils.book_append_sheet(wb, ws, 'Transfers');
    } else {
      monthKeys.forEach(k => {
        const ws = XLSX.utils.json_to_sheet(byMonth[k]);
        const sheetName = (() => {
          try { return new Date(k + '-01').toLocaleString('en-US',{month:'long',year:'numeric'}).replace(',',''); }
          catch { return k; }
        })();
        XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0,31));
      });
    }
    XLSX.writeFile(wb, `pp-hackensack-to-englewood-${today()}.xlsx`);
    logActivity('export_xlsx', 'Exported transfer invoices Excel');
    showToast('Transfer invoices exported to Excel.');
  }

  function exportCsv() {
    if (!visible.length) { showToast('No transfer invoices to export.', 'error'); return; }
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = ['Invoice#', 'Date', 'From', 'To', 'Status', 'Total', 'Notes'];
    const rows = visible.map(inv => [
      inv.id, inv.date || '', inv.from || '', inv.to || '',
      inv.status || '', +(inv.grandTotal || 0).toFixed(2), inv.notes || ''
    ]);
    const csv = [header.map(esc).join(','), ...rows.map(r => r.map(esc).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'transfer-invoices-' + today() + '.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    showToast('Transfer invoices exported.');
  }

  return (
    <div>
      <div className="flex-between mb-3 flex-wrap gap-2">
        <div className="section-title" style={{margin:0}}>🚚 P&P Transfer Invoice Generator</div>
        <div className="flex gap-2" style={{alignItems:'center',flexWrap:'wrap'}}>
          <select className="input" value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={{width:'auto',marginBottom:0}}>
            <option value="all">All statuses</option>
            <option value="unpaid">Unpaid only</option>
            <option value="paid">Paid only</option>
          </select>
          <Btn className="btn-outline" onClick={exportTransferExcel}>⬇ Export Excel</Btn>
          <Btn className="btn-outline" onClick={exportCsv}>⬇ CSV</Btn>
          <Btn className="btn-primary" onClick={() => (showForm ? closeTransferForm() : openNewTransferForm())}>{showForm ? 'Cancel' : '+ New Transfer Invoice'}</Btn>
        </div>
      </div>
      <p style={{fontSize:13,color:'#666',marginBottom:12}}>
        Generates internal invoices from <strong>Parathas &amp; Platters - Hackensack</strong> to <strong>Parathas &amp; Platters - Englewood</strong> using a fixed 15% commission structure.
      </p>

      {showForm && (
        <div className="card mb-3">
          {editingTransferId && (
            <div style={{fontWeight:700,color:'var(--brown)',marginBottom:12,fontSize:15}}>Editing {editingTransferId}</div>
          )}
          <div className="grid-3">
            <FI label="Date" type="date" value={form.date} onChange={e=>setForm(f=>({...f,date:e.target.value}))} />
            <FI label="From" value={form.from} onChange={e=>setForm(f=>({...f,from:e.target.value}))} />
            <FI label="To" value={form.to} onChange={e=>setForm(f=>({...f,to:e.target.value}))} />
          </div>
          <div className="grid-2">
            <FI label="From Contact (phone/email/name)" value={form.fromContact} onChange={e=>setForm(f=>({...f,fromContact:e.target.value}))} placeholder="Optional contact details" />
            <FI label="To Contact (phone/email/name)" value={form.toContact} onChange={e=>setForm(f=>({...f,toContact:e.target.value}))} placeholder="Optional contact details" />
          </div>
          <FI label="Notes (optional)" value={form.notes} onChange={e=>setForm(f=>({...f,notes:e.target.value}))} />

          <div className="flex-between mb-2">
            <label style={{margin:0}}>Line Items</label>
            <Btn className="btn-outline btn-sm" onClick={addLine}>+ Add Line</Btn>
          </div>
          <datalist id={transferItemListId}>
            {itemSuggestions.map(s => <option key={s} value={s} />)}
          </datalist>
          {form.lineItems.map((l, i)=>(
            <div key={i} style={{display:'flex',gap:8,marginBottom:8,alignItems:'center'}}>
              <input className="input" placeholder="Quantity (e.g. 10 lbs)" value={l.quantity} onChange={e=>setLine(i,'quantity',e.target.value)} style={{flex:1.2}} />
              <input className="input" placeholder="Item" value={l.item} onChange={e=>setLine(i,'item',e.target.value)} style={{flex:2.2}} list={transferItemListId} />
              <input className="input" placeholder="Price" type="number" min="0" step="0.01" value={l.price} onChange={e=>setLine(i,'price',e.target.value)} style={{flex:1}} />
              <span style={{fontSize:12,color:'#777',minWidth:80}}>+15%</span>
              <Btn className="btn-sm" style={{background:'#fee2e2',color:'#991b1b',border:'1px solid #fca5a5'}} onClick={()=>removeLine(i)}>🗑</Btn>
            </div>
          ))}
          <div className="flex gap-2" style={{justifyContent:'flex-end',marginTop:10}}>
            <Btn className="btn-outline" onClick={closeTransferForm}>Cancel</Btn>
            <Btn className="btn-primary" onClick={saveTransferInvoice}>{editingTransferId ? '💾 Save Changes' : '💾 Save Transfer Invoice'}</Btn>
          </div>
        </div>
      )}

      {visible.length===0 && <div className="card empty-state">{sorted.length===0 ? 'No transfer invoices yet.' : 'No transfer invoices match the selected filter.'}</div>}
      {visible.length>0 && (
        <div className="card">
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>ID</th><th>Date</th><th>From</th><th>To</th><th>Total</th><th></th></tr></thead>
              <tbody>
                {visible.map(inv=>(
                  <tr key={inv.id}>
                    <td>{inv.id}</td>
                    <td>{fmtDate(inv.date)}</td>
                    <td>{inv.from}</td>
                    <td>{inv.to}</td>
                    <td style={{fontWeight:700}}>{fmt$(inv.grandTotal)}</td>
                    <td>
                      <div className="flex gap-2">
                        <Btn className="btn-outline btn-sm" onClick={()=>setViewId(inv.id)}>View</Btn>
                        <Btn className="btn-secondary btn-sm" onClick={()=>openTransferEdit(inv)}>Edit</Btn>
                        <Btn className="btn-outline btn-sm" onClick={()=>copyTransferInvoice(inv)}>Copy</Btn>
                        {inv.status!=='paid'&&<Btn className="btn-success btn-sm" onClick={()=>{
                          const updated=transferInvoices.map(x=>x.id===inv.id?{...x,status:'paid'}:x);
                          setTransferInvoices(updated); save('transferInvoices',updated); showToast('Transfer invoice marked paid.');
                        }}>Paid</Btn>}
                        <Btn className="btn-sm" style={{background:'#fee2e2',color:'#991b1b',border:'1px solid #fca5a5'}} onClick={()=>setConfirmId(inv.id)}>Delete</Btn>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Modal open={!!viewInv} onClose={()=>setViewId(null)} title={`Transfer Invoice ${viewInv?.id || ''}`} wide maxW={900} closeOnBackdrop>
        {viewInv && (
          <div id={`transfer-view-${viewInv.id}`}>
            <div className="flex-between mb-4" style={{flexWrap:'wrap',gap:10}}>
              <div style={{display:'flex',alignItems:'center',gap:10}}>
                <BrandMark brand={getInvoiceBranding(viewInv, brandingMap)} />
                <div>
                  <div style={{fontWeight:800,fontSize:18,color:'var(--brown)'}}>{getInvoiceBranding(viewInv, brandingMap).name}</div>
                  <div style={{fontSize:12,color:'#666'}}>{getInvoiceBranding(viewInv, brandingMap).address}</div>
                  {getInvoiceBranding(viewInv, brandingMap).phone&&<div style={{fontSize:12,color:'#666'}}>Tel: {getInvoiceBranding(viewInv, brandingMap).phone}</div>}
                  {getInvoiceBranding(viewInv, brandingMap).email&&<div style={{fontSize:12,color:'#666'}}>{getInvoiceBranding(viewInv, brandingMap).email}</div>}
                </div>
              </div>
              <div style={{textAlign:'right',fontSize:13}}>
                <div style={{fontWeight:800,fontSize:18,color:'var(--brown)'}}>{viewInv.id}</div>
                <div>Date: {fmtDate(viewInv.date)}</div>
                <span className={`badge badge-${viewInv.status||'unpaid'}`} style={{marginTop:4,display:'inline-block'}}>{viewInv.status||'unpaid'}</span>
              </div>
            </div>
            <div className="card" style={{padding:12,marginBottom:12,background:'#fffdf8'}}>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,fontSize:13}}>
                <div>
                  <strong>From:</strong> {viewInv.from}
                  {viewInv.fromContact && <div style={{color:'#666',fontSize:12,marginTop:2}}>{viewInv.fromContact}</div>}
                </div>
                <div>
                  <strong>To:</strong> {viewInv.to}
                  {viewInv.toContact && <div style={{color:'#666',fontSize:12,marginTop:2}}>{viewInv.toContact}</div>}
                </div>
              </div>
            </div>
            <div className="tbl-wrap mb-3">
              <table>
                <thead><tr><th>Quantity</th><th>Item</th><th>Price</th><th>15% commission</th><th>Total</th></tr></thead>
                <tbody>
                  {viewInv.lineItems.map((l,i)=>(
                    <tr key={i}>
                      <td>{l.quantity}</td>
                      <td>{l.item}</td>
                      <td>{fmt$(l.price)}</td>
                      <td>{fmt$(l.commission)}</td>
                      <td style={{fontWeight:700}}>{fmt$(l.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{textAlign:'right',fontSize:14}}>
              <div>Subtotal: <strong>{fmt$(viewInv.subTotal)}</strong></div>
              <div>Commission: <strong>{fmt$(viewInv.commissionTotal)}</strong></div>
              <div style={{fontSize:16,color:'var(--brown)'}}>Grand Total: <strong>{fmt$(viewInv.grandTotal)}</strong></div>
            </div>
            {viewInv.notes&&<div style={{marginTop:12,fontSize:13,color:'#666'}}><strong>Notes:</strong> {viewInv.notes}</div>}
            <div className="flex gap-2" style={{justifyContent:'flex-end',marginTop:16}}>
              <Btn className="btn-outline" onClick={()=>printInvoiceById(`transfer-view-${viewInv.id}`)}>🖨 Print / Save PDF</Btn>
              <Btn className="btn-outline" onClick={()=>copyTransferInvoice(viewInv)}>Copy</Btn>
              <Btn className="btn-secondary" onClick={()=>{const v=viewInv; setViewId(null); openTransferEdit(v);}}>Edit</Btn>
              <Btn className="btn-primary" onClick={()=>setViewId(null)}>Close</Btn>
            </div>
          </div>
        )}
      </Modal>

      <Confirm
        open={!!confirmId}
        title="Delete transfer invoice?"
        message={
          pendingDeleteTransfer
            ? `Permanently remove ${pendingDeleteTransfer.id} (${fmtDate(pendingDeleteTransfer.date || '')}) on this device?`
            : 'Permanently remove this transfer invoice on this device?'
        }
        detail="This cannot be undone here. Export a backup from Settings if you might need to recover this record."
        dangerCode="DMG-E012 (local data change)"
        confirmLabel="Delete invoice"
        onConfirm={() => deleteTransferInvoice(confirmId)}
        onCancel={() => setConfirmId(null)}
      />
    </div>
  );
}

