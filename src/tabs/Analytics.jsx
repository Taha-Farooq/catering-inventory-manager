import React, { useState, useMemo, lazy, Suspense } from 'react';
import { CHART_COLORS } from '../constants.js';
import { fmt$ } from '../formatters.js';
const LazyAnalyticsCharts = lazy(() => import('../charts/AnalyticsCharts.jsx'));

export default function Analytics({ cateringInvoices, purchaseInvoices, dailyFinanceEntries }) {
  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo] = useState('');

  const filteredCatering=useMemo(()=>cateringInvoices.filter(i=>{
    const d=i.date||i.dateStart||i.createdAt||'';
    if(filterFrom&&d<filterFrom)return false;
    if(filterTo&&d>filterTo)return false;
    return true;
  }),[cateringInvoices,filterFrom,filterTo]);

  const filteredPurchase=useMemo(()=>purchaseInvoices.filter(i=>{
    const d=i.date||i.createdAt||'';
    if(filterFrom&&d<filterFrom)return false;
    if(filterTo&&d>filterTo)return false;
    return true;
  }),[purchaseInvoices,filterFrom,filterTo]);

  const filteredDaily=useMemo(()=>dailyFinanceEntries.filter(i=>{
    const d=i.date||'';
    if(filterFrom&&d<filterFrom)return false;
    if(filterTo&&d>filterTo)return false;
    return true;
  }),[dailyFinanceEntries,filterFrom,filterTo]);

  const totalRevenue=useMemo(()=>filteredCatering.reduce((s,i)=>s+(i.grandTotal||0),0),[filteredCatering]);
  const totalSpending=useMemo(()=>filteredPurchase.reduce((s,i)=>s+(i.total||0),0),[filteredPurchase]);
  const outstanding=useMemo(()=>filteredCatering.reduce((s,i)=>s+(i.balanceDue||0),0),[filteredCatering]);
  const manualIncome=useMemo(()=>filteredDaily.reduce((s,i)=>s+(i.income||0),0),[filteredDaily]);
  const manualExpense=useMemo(()=>filteredDaily.reduce((s,i)=>s+(i.expense||0),0),[filteredDaily]);
  const taxDue=useMemo(()=>filteredDaily.reduce((s,i)=>s+((i.salesTaxCollected||0)-(i.taxPaid||0)),0),[filteredDaily]);
  const grossProfit=useMemo(()=>+(totalRevenue+manualIncome-totalSpending-manualExpense).toFixed(2),[totalRevenue,manualIncome,totalSpending,manualExpense]);
  const grossMarginPct=useMemo(()=>{const r=totalRevenue+manualIncome;return r>0?+((grossProfit/r)*100).toFixed(1):null;},[grossProfit,totalRevenue,manualIncome]);

  const eventTypeData=useMemo(()=>{
    const m={};
    filteredCatering.forEach(i=>{const t=i.eventType||'Other';m[t]=(m[t]||0)+(i.grandTotal||0);});
    return Object.entries(m).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([name,v])=>({name,total:+v.toFixed(2)}));
  },[filteredCatering]);

  const topCustomers=useMemo(()=>{
    const m={};
    filteredCatering.forEach(i=>{const c=i.customerName||'Unknown';m[c]=(m[c]||0)+(i.grandTotal||0);});
    return Object.entries(m).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([name,v])=>({name,total:+v.toFixed(2)}));
  },[filteredCatering]);

  const monthRevenue=useMemo(()=>{
    const m={};
    filteredCatering.forEach(inv=>{const d=inv.date||inv.dateStart||inv.createdAt;if(!d)return;const k=d.substring(0,7);m[k]=(m[k]||0)+(inv.grandTotal||0);});
    return Object.entries(m).sort((a,b)=>a[0].localeCompare(b[0])).slice(-12).map(([k,v])=>({month:k.slice(5)+'/'+k.slice(2,4),total:+v.toFixed(2)}));
  },[filteredCatering]);

  const statusData=useMemo(()=>[
    {name:'Paid',value:filteredCatering.filter(i=>i.status==='paid').length},
    {name:'Unpaid',value:filteredCatering.filter(i=>i.status==='unpaid').length},
    {name:'Partial',value:filteredCatering.filter(i=>i.status==='partial').length},
  ].filter(d=>d.value>0),[filteredCatering]);

  const supplierData=useMemo(()=>{
    const m={};
    filteredPurchase.forEach(i=>{m[i.supplier]=(m[i.supplier]||0)+(i.total||0);});
    return Object.entries(m).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([name,v])=>({name,total:+v.toFixed(2)}));
  },[filteredPurchase]);

  const monthlyNetProfit=useMemo(()=>{
    const m={};
    filteredCatering.forEach(inv=>{const d=inv.date||inv.dateStart||inv.createdAt;if(!d)return;const k=d.slice(0,7);if(!m[k])m[k]={rev:0,spend:0};m[k].rev+=(inv.grandTotal||0);});
    filteredPurchase.forEach(inv=>{const d=inv.date||inv.createdAt;if(!d)return;const k=d.slice(0,7);if(!m[k])m[k]={rev:0,spend:0};m[k].spend+=(inv.total||0);});
    filteredDaily.forEach(e=>{const d=e.date;if(!d)return;const k=d.slice(0,7);if(!m[k])m[k]={rev:0,spend:0};m[k].rev+=(e.income||0);m[k].spend+=(e.expense||0);});
    return Object.entries(m).sort((a,b)=>a[0].localeCompare(b[0])).slice(-12).map(([k,v])=>{const net=+(v.rev-v.spend).toFixed(2);return{label:k.slice(5)+'/'+k.slice(2,4),net,positive:net>=0};});
  },[filteredCatering,filteredPurchase,filteredDaily]);

  const hasData=filteredCatering.length>0||filteredPurchase.length>0;
  const isFiltered=filterFrom||filterTo;

  return (
    <div>
      <div className="flex-between mb-3 flex-wrap gap-2">
        <div className="section-title" style={{margin:0}}>Analytics Dashboard</div>
        <div className="flex gap-2 flex-wrap" style={{alignItems:'center'}}>
          <input className="input" type="date" style={{width:'auto'}} value={filterFrom} onChange={e=>setFilterFrom(e.target.value)} title="From date" />
          <span style={{fontSize:12,color:'#888'}}>to</span>
          <input className="input" type="date" style={{width:'auto'}} value={filterTo} onChange={e=>setFilterTo(e.target.value)} title="To date" />
          {isFiltered&&<button className="btn btn-sm" style={{background:'#eee',color:'#666',borderRadius:12,padding:'2px 10px'}} onClick={()=>{setFilterFrom('');setFilterTo('');}}>✕ All time</button>}
          {isFiltered&&<span style={{fontSize:12,color:'#888'}}>Showing {filteredCatering.length}+{filteredPurchase.length}+{filteredDaily.length} records</span>}
        </div>
      </div>
      <div className="stat-grid">
        {[
          {v:fmt$(totalRevenue + manualIncome),l:'Total Revenue (Invoices + Daily)'},
          {v:fmt$(outstanding),l:'Outstanding Balance'},
          {v:fmt$(totalSpending + manualExpense),l:'Total Expenses (Purchases + Daily)'},
          {v:fmt$(grossProfit),l:'Gross Profit',color:grossProfit>=0?'#15803D':'#DC2626'},
          {v:grossMarginPct!=null?grossMarginPct+'%':'—',l:'Gross Margin %',color:grossMarginPct!=null&&grossMarginPct>=0?'#15803D':'#DC2626'},
          {v:fmt$(taxDue),l:'Sales Tax Due (Daily Ledger)'},
          {v:filteredCatering.length,l:'Catering Invoices'},
          {v:filteredPurchase.length,l:'Purchase Orders'},
          {v:filteredCatering.length>0?fmt$(totalRevenue/filteredCatering.length):'—',l:'Avg Invoice Value'},
        ].map((s,i)=>(
          <div key={i} className="stat-card">
            <div className="stat-val" style={s.color?{color:s.color}:{}}>{s.v}</div>
            <div className="stat-lbl">{s.l}</div>
          </div>
        ))}
      </div>

      {!hasData&&<div className="card empty-state">Create invoices to see analytics charts here.</div>}

      {eventTypeData.length > 0 && (
        <div className="card mb-4">
          <div className="section-title" style={{marginBottom:12}}>Revenue by Event Type</div>
          {(() => {
            const maxV = Math.max(...eventTypeData.map(e => e.total), 1);
            return (
              <div style={{display:'flex',flexDirection:'column',gap:6}}>
                {eventTypeData.map(e => (
                  <div key={e.name} style={{display:'flex',alignItems:'center',gap:8,fontSize:13}}>
                    <div style={{width:110,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',color:'#555',flexShrink:0}}>{e.name}</div>
                    <div style={{flex:1,background:'#F0FDF4',borderRadius:4,overflow:'hidden',height:18}}>
                      <div style={{width:`${e.total/maxV*100}%`,background:'#15803D',height:'100%',borderRadius:4}} />
                    </div>
                    <div style={{width:80,fontWeight:600,color:'#15803D',textAlign:'right',flexShrink:0}}>{fmt$(e.total)}</div>
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
      )}

      {topCustomers.length > 0 && (
        <div className="card mb-4">
          <div className="section-title" style={{marginBottom:12}}>Top Customers by Revenue</div>
          {(() => {
            const maxV = Math.max(...topCustomers.map(c => c.total), 1);
            return (
              <div style={{display:'flex',flexDirection:'column',gap:6}}>
                {topCustomers.map(c => (
                  <div key={c.name} style={{display:'flex',alignItems:'center',gap:8,fontSize:13}}>
                    <div style={{width:130,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',color:'#555',flexShrink:0}}>{c.name}</div>
                    <div style={{flex:1,background:'#EFF6FF',borderRadius:4,overflow:'hidden',height:18}}>
                      <div style={{width:`${c.total/maxV*100}%`,background:'#1D4ED8',height:'100%',borderRadius:4}} />
                    </div>
                    <div style={{width:80,fontWeight:600,color:'#1D4ED8',textAlign:'right',flexShrink:0}}>{fmt$(c.total)}</div>
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
      )}

      {monthlyNetProfit.length > 1 && (
        <div className="card mb-4">
          <div className="section-title" style={{marginBottom:12}}>Net Profit by Month</div>
          {(() => {
            const maxAbs = Math.max(...monthlyNetProfit.map(m => Math.abs(m.net)), 1);
            return (
              <div style={{display:'flex',flexDirection:'column',gap:6}}>
                {monthlyNetProfit.map(m => (
                  <div key={m.label} style={{display:'flex',alignItems:'center',gap:8,fontSize:13}}>
                    <div style={{width:42,color:'#555',flexShrink:0,textAlign:'right'}}>{m.label}</div>
                    <div style={{flex:1,display:'flex',alignItems:'center',gap:4,overflow:'hidden'}}>
                      <div style={{flex:1,background:'#F3F4F6',borderRadius:4,overflow:'hidden',height:18}}>
                        <div style={{width:`${Math.abs(m.net)/maxAbs*100}%`,background:m.positive?'#15803D':'#DC2626',height:'100%',borderRadius:4,marginLeft:m.positive?0:'auto'}} />
                      </div>
                    </div>
                    <div style={{width:80,fontWeight:600,color:m.positive?'#15803D':'#DC2626',textAlign:'right',flexShrink:0}}>{fmt$(m.net)}</div>
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
      )}

      {(monthRevenue.length > 1 || supplierData.length > 0 || statusData.length > 0) && (
        <Suspense fallback={<div className="card mb-4 text-muted" style={{ padding: 24, textAlign: 'center' }}>Loading charts…</div>}>
          <LazyAnalyticsCharts
            monthRevenue={monthRevenue}
            supplierData={supplierData}
            statusData={statusData}
            fmt$={fmt$}
            chartColors={CHART_COLORS}
          />
        </Suspense>
      )}
    </div>
  );
}

