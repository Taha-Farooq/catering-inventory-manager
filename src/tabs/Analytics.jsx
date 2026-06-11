import React, { useState, useMemo, lazy, Suspense } from 'react';
import * as XLSX from 'xlsx';
import { CHART_COLORS, BUSINESSES } from '../constants.js';
import { fmt$ } from '../formatters.js';
import { showToast } from '../toastContext.jsx';
import { logActivity } from '../utils/activity.js';
import { printHtmlDocument } from '../utils/print.js';
import { buildProfessionalDoc, docSection, docMoney } from '../utils/professionalDoc.js';
const LazyAnalyticsCharts = lazy(() => import('../charts/AnalyticsCharts.jsx'));

const fmtD = d => d.toISOString().slice(0, 10);

function periodLabelFrom(from, to) {
  if (!from && !to) return 'All time';
  const fmtNice = s => { try { return new Date(s + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }); } catch { return s; } };
  if (from && to) return `${fmtNice(from)} – ${fmtNice(to)}`;
  if (from) return `From ${fmtNice(from)}`;
  return `Through ${fmtNice(to)}`;
}

export default function Analytics({ cateringInvoices, purchaseInvoices, dailyFinanceEntries, payrollInvoices = [], brandingMap = null }) {
  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo] = useState('');
  const [preset, setPreset] = useState('');
  const [filterBiz, setFilterBiz] = useState('');

  function applyPreset(p) {
    const now = new Date();
    if (p === '7d') { const f = new Date(now); f.setDate(f.getDate() - 6); setFilterFrom(fmtD(f)); setFilterTo(fmtD(now)); }
    else if (p === '30d') { const f = new Date(now); f.setDate(f.getDate() - 29); setFilterFrom(fmtD(f)); setFilterTo(fmtD(now)); }
    else if (p === 'month') { setFilterFrom(fmtD(new Date(now.getFullYear(), now.getMonth(), 1))); setFilterTo(fmtD(new Date(now.getFullYear(), now.getMonth() + 1, 0))); }
    else if (p === 'lastmonth') { setFilterFrom(fmtD(new Date(now.getFullYear(), now.getMonth() - 1, 1))); setFilterTo(fmtD(new Date(now.getFullYear(), now.getMonth(), 0))); }
    else if (p === 'year') { setFilterFrom(`${now.getFullYear()}-01-01`); setFilterTo(fmtD(now)); }
    else { setFilterFrom(''); setFilterTo(''); }
    setPreset(p === preset ? '' : p);
  }

  const filteredCatering=useMemo(()=>cateringInvoices.filter(i=>{
    const d=i.date||i.dateStart||i.createdAt||'';
    if(filterFrom&&d<filterFrom)return false;
    if(filterTo&&d>filterTo)return false;
    if(filterBiz&&(i.business||'')!==filterBiz)return false;
    return true;
  }),[cateringInvoices,filterFrom,filterTo,filterBiz]);

  const filteredPurchase=useMemo(()=>purchaseInvoices.filter(i=>{
    const d=i.date||i.createdAt||'';
    if(filterFrom&&d<filterFrom)return false;
    if(filterTo&&d>filterTo)return false;
    if(filterBiz&&(i.business||'')!==filterBiz)return false;
    return true;
  }),[purchaseInvoices,filterFrom,filterTo,filterBiz]);

  const filteredDaily=useMemo(()=>dailyFinanceEntries.filter(i=>{
    const d=i.date||'';
    if(filterFrom&&d<filterFrom)return false;
    if(filterTo&&d>filterTo)return false;
    if(filterBiz&&(i.business||'')!==filterBiz)return false;
    return true;
  }),[dailyFinanceEntries,filterFrom,filterTo,filterBiz]);

  // Payroll falls in the period when its pay-period start lands in range.
  const filteredPayroll=useMemo(()=>(payrollInvoices||[]).filter(p=>{
    const d=p.periodStart||p.periodEnd||p.createdAt||'';
    if(filterFrom&&d<filterFrom)return false;
    if(filterTo&&d>filterTo)return false;
    if(filterBiz&&(p.business||'')!==filterBiz)return false;
    return true;
  }),[payrollInvoices,filterFrom,filterTo,filterBiz]);
  const payrollTotal=useMemo(()=>filteredPayroll.reduce((s,p)=>s+(p.total||0),0),[filteredPayroll]);

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
    filteredCatering.forEach(i=>{const t=i.eventType||'Other';if(!m[t])m[t]={total:0,count:0};m[t].total+=(i.grandTotal||0);m[t].count++;});
    return Object.entries(m).sort((a,b)=>b[1].total-a[1].total).slice(0,8).map(([name,v])=>({name,total:+v.total.toFixed(2),count:v.count}));
  },[filteredCatering]);

  const topCustomers=useMemo(()=>{
    const m={};
    filteredCatering.forEach(i=>{const c=i.customerName||'Unknown';if(!m[c])m[c]={total:0,count:0};m[c].total+=(i.grandTotal||0);m[c].count++;});
    return Object.entries(m).sort((a,b)=>b[1].total-a[1].total).slice(0,8).map(([name,v])=>({name,total:+v.total.toFixed(2),count:v.count}));
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

  const repeatCustomers=useMemo(()=>{
    const m={};
    filteredCatering.forEach(i=>{const c=i.customerName||'Unknown';m[c]=(m[c]||0)+1;});
    const total=Object.keys(m).length;
    const repeat=Object.values(m).filter(v=>v>1).length;
    return{total,repeat,pct:total>0?+((repeat/total)*100).toFixed(0):0};
  },[filteredCatering]);

  const hasData=filteredCatering.length>0||filteredPurchase.length>0;
  const isFiltered=filterFrom||filterTo||filterBiz;

  function brandingForReport() {
    if (filterBiz && brandingMap?.[filterBiz]) return brandingMap[filterBiz];
    // Combined view: a neutral letterhead listing the three businesses.
    return {
      name: 'DMG Restaurant Group',
      address: 'DeGrill · Parathas & Platters · Dera Masala Grill',
      phone: brandingMap?.dera?.phone || '',
      email: brandingMap?.dera?.email || '',
      logo: brandingMap?.dera?.logo || '',
    };
  }

  // Profit & Loss statement — the document for a partner conversation. Unlike
  // the on-screen "Gross Profit" stat (which omits payroll), this statement
  // includes payroll as an operating expense for the true bottom line.
  function printProfitAndLoss() {
    const revenue = totalRevenue + manualIncome;
    const supplies = totalSpending;
    const otherExp = manualExpense;
    const totalExp = supplies + payrollTotal + otherExp;
    const net = +(revenue - totalExp).toFixed(2);
    const margin = revenue > 0 ? ((net / revenue) * 100).toFixed(1) + '%' : '—';

    if (!filteredCatering.length && !filteredPurchase.length && !filteredDaily.length && !filteredPayroll.length) {
      showToast('No financial data in this period to build a statement.', 'error');
      return;
    }

    const revSection = docSection({
      heading: 'Revenue',
      rows: [
        { label: 'Catering & event revenue', value: docMoney(totalRevenue), indent: true },
        ...(manualIncome ? [{ label: 'Other income (daily ledger)', value: docMoney(manualIncome), indent: true }] : []),
      ],
      total: { label: 'Total Revenue', value: docMoney(revenue) },
    });
    const expSection = docSection({
      heading: 'Operating Expenses',
      rows: [
        { label: 'Supplies & purchases', value: docMoney(supplies), indent: true },
        { label: 'Payroll & wages', value: docMoney(payrollTotal), indent: true },
        ...(otherExp ? [{ label: 'Other expenses (daily ledger)', value: docMoney(otherExp), indent: true }] : []),
      ],
      total: { label: 'Total Operating Expenses', value: docMoney(totalExp) },
    });
    const netSection = docSection({
      rows: [
        { label: 'Net margin', value: margin, muted: true },
      ],
      total: { label: net >= 0 ? 'NET PROFIT' : 'NET LOSS', value: docMoney(net), accent: net >= 0 ? '#15803D' : '#DC2626' },
    });
    const memoSection = docSection({
      heading: 'Memoranda (not included in net profit)',
      rows: [
        { label: 'Outstanding receivables (unpaid invoices)', value: docMoney(outstanding), indent: true, muted: true },
        { label: 'Sales tax collected, net of paid', value: docMoney(taxDue), indent: true, muted: true },
        { label: 'Catering invoices in period', value: String(filteredCatering.length), indent: true, muted: true },
        { label: 'Purchase orders in period', value: String(filteredPurchase.length), indent: true, muted: true },
      ],
    });

    const html = buildProfessionalDoc({
      branding: brandingForReport(),
      docType: 'PROFIT & LOSS STATEMENT',
      docNumber: 'PL-' + new Date().toISOString().slice(0, 10).replace(/-/g, ''),
      periodLabel: periodLabelFrom(filterFrom, filterTo),
      bodyHtml: revSection + '<div style="height:8px"></div>' + expSection + '<div style="height:8px"></div>' + netSection + '<div style="height:14px"></div>' + memoSection,
      footerNote: 'Prepared from catering invoices, purchase orders, payroll records, and the daily income/expense ledger. Figures reflect recorded transactions in the selected period and business scope; this statement is a management summary, not an audited financial statement.',
      confidential: true,
    });
    printHtmlDocument(html, 'Profit & Loss Statement');
    logActivity('print_report', `Printed P&L statement (${periodLabelFrom(filterFrom, filterTo)}${filterBiz ? ', ' + (BUSINESSES[filterBiz]?.name || filterBiz) : ''})`);
  }

  function exportExcel() {
    const wb = XLSX.utils.book_new();
    // Summary sheet
    const sumRows = [
      ['Metric', 'Value'],
      ['Total Revenue', +(totalRevenue + manualIncome).toFixed(2)],
      ['Outstanding Balance', +outstanding.toFixed(2)],
      ['Total Expenses', +(totalSpending + manualExpense).toFixed(2)],
      ['Gross Profit', grossProfit],
      ['Gross Margin %', grossMarginPct != null ? grossMarginPct : ''],
      ['Sales Tax Due', +taxDue.toFixed(2)],
      ['Catering Invoices', filteredCatering.length],
      ['Purchase Orders', filteredPurchase.length],
      ['Avg Invoice Value', filteredCatering.length > 0 ? +(totalRevenue / filteredCatering.length).toFixed(2) : ''],
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sumRows), 'Summary');
    // Top Customers
    if (topCustomers.length) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
        ['Customer', 'Events', 'Total Revenue', 'Avg per Event'],
        ...topCustomers.map(c => [c.name, c.count, c.total, c.count > 0 ? +(c.total / c.count).toFixed(2) : '']),
      ]), 'Top Customers');
    }
    // Event Types
    if (eventTypeData.length) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
        ['Event Type', 'Events', 'Total Revenue', 'Avg per Event'],
        ...eventTypeData.map(e => [e.name, e.count, e.total, e.count > 0 ? +(e.total / e.count).toFixed(2) : '']),
      ]), 'Event Types');
    }
    // Monthly Net Profit
    if (monthlyNetProfit.length) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
        ['Month', 'Net Profit'],
        ...monthlyNetProfit.map(m => [m.label, m.net]),
      ]), 'Monthly Net Profit');
    }
    XLSX.writeFile(wb, `analytics-${new Date().toISOString().slice(0, 10)}.xlsx`);
    showToast('Analytics exported as Excel.');
    logActivity('export_xlsx', 'Exported analytics Excel');
  }

  function exportCsv() {
    const esc = v => `"${String(v ?? '').replace(/"/g,'""')}"`;
    const rows = [
      ['Metric','Value'],
      ['Total Revenue', (totalRevenue + manualIncome).toFixed(2)],
      ['Outstanding Balance', outstanding.toFixed(2)],
      ['Total Expenses', (totalSpending + manualExpense).toFixed(2)],
      ['Gross Profit', grossProfit.toFixed(2)],
      ['Gross Margin %', grossMarginPct != null ? grossMarginPct : ''],
      ['Sales Tax Due', taxDue.toFixed(2)],
      ['Catering Invoices', filteredCatering.length],
      ['Purchase Orders', filteredPurchase.length],
      ['', ''],
      ['Top Customers', ''],
      ...topCustomers.map(c => [c.name, c.total.toFixed(2)]),
      ['', ''],
      ['Monthly Net Profit', ''],
      ...monthlyNetProfit.map(m => [m.label, m.net.toFixed(2)]),
    ];
    const csv = rows.map(r => r.map(esc).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `analytics-${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    showToast('Analytics exported as CSV.');
    logActivity('export_csv', 'Exported analytics CSV');
  }

  return (
    <div>
      <div className="flex-between mb-3 flex-wrap gap-2">
        <div className="section-title" style={{margin:0}}>Analytics Dashboard</div>
        <button className="btn btn-primary btn-sm" onClick={printProfitAndLoss} title="Print a professional Profit & Loss statement for the selected period and business">🧾 P&amp;L Statement</button>
        <button className="btn btn-outline btn-sm" onClick={exportCsv}>⬇ CSV</button>
        <button className="btn btn-outline btn-sm" onClick={exportExcel}>⬇ Excel</button>
      </div>
      <div className="card mb-3">
        <div className="flex gap-2 flex-wrap" style={{alignItems:'center',marginBottom:8}}>
          <input className="input" type="date" style={{width:'auto'}} value={filterFrom} onChange={e=>{setFilterFrom(e.target.value);setPreset('');}} title="From date" />
          <span style={{fontSize:12,color:'#888'}}>to</span>
          <input className="input" type="date" style={{width:'auto'}} value={filterTo} onChange={e=>{setFilterTo(e.target.value);setPreset('');}} title="To date" />
          <select className="input" style={{width:'auto',minWidth:160}} value={filterBiz} onChange={e=>setFilterBiz(e.target.value)} title="Filter by business">
            <option value="">All Businesses</option>
            {Object.entries(BUSINESSES).map(([k,v])=><option key={k} value={k}>{v.name}</option>)}
          </select>
        </div>
        <div style={{display:'flex',flexWrap:'wrap',gap:6}}>
          {[['7d','Last 7d'],['30d','Last 30d'],['month','This Month'],['lastmonth','Last Month'],['year','This Year']].map(([k,label])=>(
            <button key={k} className="btn btn-sm" style={{background:preset===k?'var(--brown)':'#eee',color:preset===k?'#fff':'#555',borderRadius:12,padding:'2px 10px'}} onClick={()=>applyPreset(k)}>{label}</button>
          ))}
          {isFiltered&&<button className="btn btn-sm" style={{background:'#eee',color:'#666',borderRadius:12,padding:'2px 10px'}} onClick={()=>applyPreset('')}>✕ All time</button>}
        </div>
        {isFiltered&&<div style={{fontSize:12,color:'#888',marginTop:6}}>Showing {filteredCatering.length} catering · {filteredPurchase.length} purchase · {filteredDaily.length} daily records{filterBiz?` for ${BUSINESSES[filterBiz]?.name||filterBiz}`:''}</div>}
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
          {v:repeatCustomers.total>0?`${repeatCustomers.repeat}/${repeatCustomers.total} (${repeatCustomers.pct}%)`:'—',l:'Repeat Customers'},
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
                    <div style={{width:50,color:'#888',textAlign:'right',flexShrink:0,fontSize:11}}>{e.count} evt{e.count!==1?'s':''}</div>
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
                    <div style={{width:50,color:'#888',textAlign:'right',flexShrink:0,fontSize:11}}>{c.count} event{c.count!==1?'s':''}</div>
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

