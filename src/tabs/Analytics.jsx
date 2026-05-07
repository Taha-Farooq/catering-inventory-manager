import React, { useMemo, lazy, Suspense } from 'react';
import { CHART_COLORS } from '../constants.js';
import { fmt$ } from '../formatters.js';
const LazyAnalyticsCharts = lazy(() => import('../charts/AnalyticsCharts.jsx'));

export default function Analytics({ cateringInvoices, purchaseInvoices, dailyFinanceEntries }) {
  const totalRevenue=useMemo(()=>cateringInvoices.reduce((s,i)=>s+(i.grandTotal||0),0),[cateringInvoices]);
  const totalSpending=useMemo(()=>purchaseInvoices.reduce((s,i)=>s+(i.total||0),0),[purchaseInvoices]);
  const outstanding=useMemo(()=>cateringInvoices.reduce((s,i)=>s+(i.balanceDue||0),0),[cateringInvoices]);
  const manualIncome=useMemo(()=>dailyFinanceEntries.reduce((s,i)=>s+(i.income||0),0),[dailyFinanceEntries]);
  const manualExpense=useMemo(()=>dailyFinanceEntries.reduce((s,i)=>s+(i.expense||0),0),[dailyFinanceEntries]);
  const taxDue=useMemo(()=>dailyFinanceEntries.reduce((s,i)=>s+((i.salesTaxCollected||0)-(i.taxPaid||0)),0),[dailyFinanceEntries]);

  const monthRevenue=useMemo(()=>{
    const m={};
    cateringInvoices.forEach(inv=>{const d=inv.date||inv.dateStart||inv.createdAt;if(!d)return;const k=d.substring(0,7);m[k]=(m[k]||0)+(inv.grandTotal||0);});
    return Object.entries(m).sort((a,b)=>a[0].localeCompare(b[0])).slice(-12).map(([k,v])=>({month:k.slice(5)+'/'+k.slice(2,4),total:+v.toFixed(2)}));
  },[cateringInvoices]);

  const statusData=useMemo(()=>[
    {name:'Paid',value:cateringInvoices.filter(i=>i.status==='paid').length},
    {name:'Unpaid',value:cateringInvoices.filter(i=>i.status==='unpaid').length},
    {name:'Partial',value:cateringInvoices.filter(i=>i.status==='partial').length},
  ].filter(d=>d.value>0),[cateringInvoices]);

  const supplierData=useMemo(()=>{
    const m={};
    purchaseInvoices.forEach(i=>{m[i.supplier]=(m[i.supplier]||0)+(i.total||0);});
    return Object.entries(m).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([name,v])=>({name,total:+v.toFixed(2)}));
  },[purchaseInvoices]);

  const hasData=cateringInvoices.length>0||purchaseInvoices.length>0;

  return (
    <div>
      <div className="section-title">Analytics Dashboard</div>
      <div className="stat-grid">
        {[
          {v:fmt$(totalRevenue + manualIncome),l:'Total Revenue (Invoices + Daily)'},
          {v:fmt$(outstanding),l:'Outstanding Balance'},
          {v:fmt$(totalSpending + manualExpense),l:'Total Expenses (Purchases + Daily)'},
          {v:fmt$(taxDue),l:'Sales Tax Due (Daily Ledger)'},
          {v:cateringInvoices.length,l:'Catering Invoices'},
          {v:purchaseInvoices.length,l:'Purchase Orders'},
          {v:cateringInvoices.length>0?fmt$(totalRevenue/cateringInvoices.length):'—',l:'Avg Invoice Value'},
        ].map((s,i)=>(
          <div key={i} className="stat-card"><div className="stat-val">{s.v}</div><div className="stat-lbl">{s.l}</div></div>
        ))}
      </div>

      {!hasData&&<div className="card empty-state">Create invoices to see analytics charts here.</div>}

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

