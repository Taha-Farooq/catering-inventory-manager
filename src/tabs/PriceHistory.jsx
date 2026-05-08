import React, { useState, useMemo, lazy, Suspense } from 'react';
import { CHART_COLORS } from '../constants.js';
import { fmt$, fmtDate } from '../formatters.js';
import { save, today } from '../utils/storage.js';
import Confirm from '../ui/Confirm.jsx';
const LazyPriceHistoryChart = lazy(() => import('../charts/PriceHistoryChart.jsx'));

function Btn({ className='', children, ...p }) {
  return <button className={`btn ${className}`} {...p}>{children}</button>;
}

export default function PriceHistory({ items, priceHistory, setPriceHistory }) {
  const [selId,setSelId]=useState('');
  const [confirmId,setConfirmId]=useState(null);
  const selItem=items.find(i=>i.id===selId);
  const hist=useMemo(()=>priceHistory.filter(h=>h.itemId===selId).sort((a,b)=>a.date.localeCompare(b.date)),[selId,priceHistory]);
  const pendingDeleteHistEntry = useMemo(
    () => (confirmId ? priceHistory.find((h) => h.id === confirmId) : null),
    [confirmId, priceHistory]
  );
  const sellers=useMemo(()=>[...new Set(hist.map(h=>h.seller))],[hist]);
  const chartData=useMemo(()=>{
    if(!hist.length) return [];
    const dates=[...new Set(hist.map(h=>h.date))].sort();
    const last={};sellers.forEach(s=>{last[s]=null;});
    return dates.map(date=>{
      hist.filter(h=>h.date===date).forEach(e=>{last[e.seller]=e.newPrice;});
      return{date:fmtDate(date),...Object.fromEntries(sellers.map(s=>[s,last[s]]))};
    });
  },[hist,sellers]);

  function delEntry(id){const u=priceHistory.filter(h=>h.id!==id);setPriceHistory(u);save('priceHistory',u);setConfirmId(null);}

  function exportCsv() {
    const data = selId ? hist : [...priceHistory].sort((a,b)=>a.date.localeCompare(b.date));
    if (!data.length) { return; }
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = ['Date', 'Item', 'Seller', 'Old Price', 'New Price'];
    const rows = data.map(h => [h.date, h.itemName || '', h.seller || '', h.oldPrice != null ? +h.oldPrice : '', h.newPrice != null ? +h.newPrice : '']);
    const csv = [header.map(esc).join(','), ...rows.map(r => r.map(esc).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'price-history-' + today() + '.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  }

  return (
    <div>
      <div className="flex-between mb-4">
        <div className="section-title" style={{margin:0}}>Price History</div>
        {priceHistory.length > 0 && (
          <Btn className="btn-outline btn-sm" onClick={exportCsv}>⬇ Export CSV</Btn>
        )}
      </div>
      <div className="card mb-4">
        <label>Select Item to View Price Trends</label>
        <select className="input" value={selId} onChange={e=>setSelId(e.target.value)}>
          <option value="">— Choose an item —</option>
          {items.map(i=><option key={i.id} value={i.id}>{i.name} ({i.category})</option>)}
        </select>
      </div>

      {!selId&&items.length>0&&<div className="card empty-state">Select an item above to see how its prices changed over time.</div>}
      {items.length===0&&<div className="card empty-state">No items yet. Add items in the Item Database tab first.</div>}
      {selId&&hist.length===0&&(
        <div className="card empty-state">
          No price history for <strong>{selItem?.name}</strong> yet.<br/>
          <span style={{fontSize:13,color:'#bbb'}}>Price changes are recorded automatically when you edit a seller's price.</span>
        </div>
      )}

      {hist.length>0&&(
        <>
          {chartData.length>1 && (
            <Suspense fallback={<div className="card mb-4 text-muted" style={{ padding: 24, textAlign: 'center' }}>Loading chart…</div>}>
              <LazyPriceHistoryChart
                chartData={chartData}
                sellers={sellers}
                itemLabel={`${selItem?.name} (${selItem?.unit})`}
                fmt$={fmt$}
                chartColors={CHART_COLORS}
              />
            </Suspense>
          )}
          <div className="card" style={{padding:0}}>
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>Date</th><th>Seller</th><th>Old Price</th><th>New Price</th><th>Change</th><th></th></tr></thead>
                <tbody>
                  {[...hist].reverse().map(h=>{
                    const diff=h.newPrice-h.oldPrice;
                    const pct=h.oldPrice?(diff/h.oldPrice*100).toFixed(1)+'%':'—';
                    return (
                      <tr key={h.id}>
                        <td>{fmtDate(h.date)}</td>
                        <td style={{fontWeight:600}}>{h.seller}</td>
                        <td>{fmt$(h.oldPrice)}</td>
                        <td style={{fontWeight:600}}>{fmt$(h.newPrice)}</td>
                        <td style={{fontWeight:600,color:diff>0?'var(--danger)':'var(--success)'}}>{diff>0?'▲':'▼'} {fmt$(Math.abs(diff))} ({pct})</td>
                        <td><Btn className="btn-danger btn-sm" onClick={()=>setConfirmId(h.id)}>✕</Btn></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
      <Confirm
        open={!!confirmId}
        title="Delete price history row?"
        message={
          pendingDeleteHistEntry
            ? `Remove the ${fmtDate(pendingDeleteHistEntry.date)} price change for "${pendingDeleteHistEntry.seller}" on "${selItem?.name || 'item'}"?`
            : 'Remove this price history row?'
        }
        detail="This only deletes the audit row, not the current item price. Export a backup if unsure."
        dangerCode="DMG-E012 (local data change)"
        confirmLabel="Delete row"
        onConfirm={() => delEntry(confirmId)}
        onCancel={() => setConfirmId(null)}
      />
    </div>
  );
}

