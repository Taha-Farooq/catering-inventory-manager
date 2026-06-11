import React, { useState, useMemo, lazy, Suspense } from 'react';
import * as XLSX from 'xlsx';
import { CHART_COLORS, BUSINESSES } from '../constants.js';
import { fmt$ } from '../formatters.js';
import { showToast } from '../toastContext.jsx';
import { logActivity } from '../utils/activity.js';
import { printHtmlDocument } from '../utils/print.js';
import { buildProfessionalDoc, docSection, docMoney, esc } from '../utils/professionalDoc.js';
import { load } from '../utils/storage.js';
import { OWNERS_KEY } from '../constants.js';
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
  const [showReportsMenu, setShowReportsMenu] = useState(false);

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

  // Owner / partner distribution statement. Uses the same net-profit number
  // as the P&L; subtracts each owner's salary draw recognized during the
  // period; distributes the remainder by share %.
  function printDistribution() {
    const owners = load(OWNERS_KEY, []);
    if (!Array.isArray(owners) || owners.length === 0) {
      showToast('Add owners in Settings → Owners & Profit Distribution first.', 'error');
      return;
    }
    const sharePctTotal = owners.reduce((s, o) => s + (Number(o.sharePct) || 0), 0);
    if (Math.abs(sharePctTotal - 100) > 0.01) {
      showToast(`Owner shares total ${sharePctTotal.toFixed(1)}%; set them to 100% in Settings before printing.`, 'error');
      return;
    }

    const revenue = totalRevenue + manualIncome;
    const expenses = totalSpending + payrollTotal + manualExpense;
    const netProfit = +(revenue - expenses).toFixed(2);

    const totalSalary = owners.reduce((s, o) => s + (Number(o.salary) || 0), 0);
    const distributable = +(netProfit - totalSalary).toFixed(2);

    const rows = owners.map(o => {
      const share = Number(o.sharePct) || 0;
      const salary = Number(o.salary) || 0;
      const distribution = +((distributable * share) / 100).toFixed(2);
      const totalComp = +(salary + distribution).toFixed(2);
      return { name: o.name || '(unnamed)', share, salary, distribution, totalComp };
    });

    const head = `<tr style="background:#FBF6EC">
      <th style="text-align:left;padding:7px 10px;border-bottom:1.5px solid #8B4513;font-size:10.5px;letter-spacing:.5px;color:#8B4513;text-transform:uppercase;">Owner</th>
      <th style="text-align:right;padding:7px 10px;border-bottom:1.5px solid #8B4513;font-size:10.5px;letter-spacing:.5px;color:#8B4513;text-transform:uppercase;">Share</th>
      <th style="text-align:right;padding:7px 10px;border-bottom:1.5px solid #8B4513;font-size:10.5px;letter-spacing:.5px;color:#8B4513;text-transform:uppercase;">Salary Drawn</th>
      <th style="text-align:right;padding:7px 10px;border-bottom:1.5px solid #8B4513;font-size:10.5px;letter-spacing:.5px;color:#8B4513;text-transform:uppercase;">Profit Distribution</th>
      <th style="text-align:right;padding:7px 10px;border-bottom:1.5px solid #8B4513;font-size:10.5px;letter-spacing:.5px;color:#8B4513;text-transform:uppercase;">Total Compensation</th>
    </tr>`;
    const bodyRows = rows.map(r => `<tr>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:13px;font-weight:600;">${esc(r.name)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:right;font-size:13px;font-variant-numeric:tabular-nums;">${r.share.toFixed(1)}%</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:right;font-size:13px;font-variant-numeric:tabular-nums;">${esc(docMoney(r.salary))}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:right;font-size:13px;font-variant-numeric:tabular-nums;color:${r.distribution >= 0 ? '#15803d' : '#b91c1c'};">${esc(docMoney(r.distribution))}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:right;font-size:13px;font-weight:800;font-variant-numeric:tabular-nums;">${esc(docMoney(r.totalComp))}</td>
    </tr>`).join('');
    const totalCompSum = rows.reduce((s, r) => s + r.totalComp, 0);
    const totalRow = `<tr>
      <td style="padding:10px;border-top:2px solid #333;font-weight:800;font-size:13px;">TOTAL</td>
      <td style="padding:10px;border-top:2px solid #333;text-align:right;font-weight:800;font-size:13px;font-variant-numeric:tabular-nums;">${sharePctTotal.toFixed(1)}%</td>
      <td style="padding:10px;border-top:2px solid #333;text-align:right;font-weight:800;font-size:13px;font-variant-numeric:tabular-nums;">${esc(docMoney(totalSalary))}</td>
      <td style="padding:10px;border-top:2px solid #333;text-align:right;font-weight:800;font-size:13px;font-variant-numeric:tabular-nums;">${esc(docMoney(distributable))}</td>
      <td style="padding:10px;border-top:2px solid #333;text-align:right;font-weight:800;font-size:14px;font-variant-numeric:tabular-nums;">${esc(docMoney(totalCompSum))}</td>
    </tr>`;
    const table = `<table style="width:100%;border-collapse:collapse;margin-bottom:6px;">${head}${bodyRows}${totalRow}</table>`;

    const summary = docSection({
      heading: 'Period Summary',
      rows: [
        { label: 'Total revenue', value: docMoney(revenue), indent: true, muted: true },
        { label: 'Total expenses (incl. payroll)', value: docMoney(expenses), indent: true, muted: true },
        { label: 'Net profit (before owner draws)', value: docMoney(netProfit), indent: true, strong: true },
        { label: 'Less: salaries already drawn by owners', value: docMoney(totalSalary), indent: true, muted: true },
      ],
      total: { label: 'Distributable Profit', value: docMoney(distributable), accent: distributable >= 0 ? '#15803D' : '#DC2626' },
    });

    // Signature block.
    const signatures = `<div style="margin-top:32px;display:flex;gap:24px;">
      ${rows.map(r => `<div style="flex:1;">
        <div style="border-bottom:1px solid #333;height:36px;"></div>
        <div style="font-size:11.5px;color:#555;margin-top:4px;">${esc(r.name)} — date</div>
      </div>`).join('')}
    </div>`;

    const html = buildProfessionalDoc({
      branding: brandingForReport(),
      docType: 'OWNER DISTRIBUTION STATEMENT',
      docNumber: 'DIST-' + new Date().toISOString().slice(0, 10).replace(/-/g, ''),
      periodLabel: periodLabelFrom(filterFrom, filterTo) + (filterBiz ? ' · ' + (BUSINESSES[filterBiz]?.name || filterBiz) : ''),
      bodyHtml: summary + '<div style="height:14px"></div>' + table + signatures,
      footerNote: 'Each owner signs to acknowledge agreement with the period results. Salary drawn reflects amounts already paid as salary during the period; profit distributions are pro-rated by share. This statement is a management record, not an audited financial statement.',
      confidential: true,
    });
    printHtmlDocument(html, 'Owner Distribution Statement');
    logActivity('print_report', `Printed owner distribution statement (${periodLabelFrom(filterFrom, filterTo)})`);
  }

  // One-page "Monthly Business Report" — the document she can print every
  // month and hand to a partner / accountant. Combines P&L, top customers,
  // payroll summary, and sales tax in a single page.
  function printMonthlyReport() {
    const revenue = totalRevenue + manualIncome;
    const expenses = totalSpending + payrollTotal + manualExpense;
    const net = +(revenue - expenses).toFixed(2);
    const margin = revenue > 0 ? ((net / revenue) * 100).toFixed(1) + '%' : '—';

    if (!filteredCatering.length && !filteredPurchase.length && !filteredDaily.length && !filteredPayroll.length) {
      showToast('No data in this period to report on.', 'error');
      return;
    }

    // Mini bar chart inline (no external lib — just divs scaled to the max).
    const customersBlock = topCustomers.length === 0 ? '' : (() => {
      const maxV = Math.max(...topCustomers.map(c => c.total), 1);
      const bars = topCustomers.slice(0, 5).map(c => `
        <tr>
          <td style="padding:4px 8px;font-size:12.5px;color:#444;white-space:nowrap;max-width:160px;overflow:hidden;text-overflow:ellipsis;">${esc(c.name)}</td>
          <td style="padding:4px 8px;width:100%;">
            <div style="background:#EFF6FF;border-radius:4px;height:14px;overflow:hidden;">
              <div style="width:${(c.total / maxV * 100).toFixed(1)}%;background:#1D4ED8;height:14px;"></div>
            </div>
          </td>
          <td style="padding:4px 8px;font-size:12.5px;font-weight:700;color:#1D4ED8;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;">${esc(docMoney(c.total))}</td>
          <td style="padding:4px 8px;font-size:11px;color:#888;text-align:right;white-space:nowrap;">${c.count} evt${c.count!==1?'s':''}</td>
        </tr>`).join('');
      return `<div style="margin-top:18px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:.6px;color:#1D4ED8;text-transform:uppercase;border-bottom:1.5px solid #1D4ED8;padding-bottom:4px;margin-bottom:6px;">Top Customers</div>
        <table style="width:100%;border-collapse:collapse;">${bars}</table>
      </div>`;
    })();

    // Payroll summary by employee.
    const empRollup = {};
    filteredPayroll.forEach(p => {
      const lines = Array.isArray(p.lines) && p.lines.length ? p.lines : [{ name: p.employeeName || p.name || '(employee)', total: p.total || 0, regularHours: p.regularHours, overtimeHours: p.overtimeHours, payRate: p.hourlyRate || p.payRate }];
      lines.forEach(l => {
        const k = (l.name || '').toLowerCase().trim() || 'unknown';
        if (!empRollup[k]) empRollup[k] = { name: l.name || 'Unknown', regH: 0, otH: 0, total: 0 };
        empRollup[k].regH += Number(l.regularHours) || 0;
        empRollup[k].otH += Number(l.overtimeHours) || 0;
        empRollup[k].total += Number(l.total) || 0;
      });
    });
    const empRows = Object.values(empRollup).sort((a, b) => b.total - a.total).slice(0, 8);
    const payrollBlock = empRows.length === 0 ? '' : (() => {
      const rows = empRows.map(e => `<tr>
        <td style="padding:4px 8px;font-size:12.5px;color:#444;">${esc(e.name)}</td>
        <td style="padding:4px 8px;font-size:12px;color:#777;text-align:right;font-variant-numeric:tabular-nums;">${e.regH.toFixed(2)}</td>
        <td style="padding:4px 8px;font-size:12px;color:#777;text-align:right;font-variant-numeric:tabular-nums;">${e.otH.toFixed(2)}</td>
        <td style="padding:4px 8px;font-size:13px;font-weight:700;text-align:right;font-variant-numeric:tabular-nums;">${esc(docMoney(e.total))}</td>
      </tr>`).join('');
      return `<div style="margin-top:18px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:.6px;color:#8B4513;text-transform:uppercase;border-bottom:1.5px solid #8B4513;padding-bottom:4px;margin-bottom:6px;">Payroll by Employee</div>
        <table style="width:100%;border-collapse:collapse;">
          <tr><th style="text-align:left;padding:3px 8px;font-size:10px;color:#888;letter-spacing:.4px;">EMPLOYEE</th><th style="text-align:right;padding:3px 8px;font-size:10px;color:#888;">REG HRS</th><th style="text-align:right;padding:3px 8px;font-size:10px;color:#888;">OT HRS</th><th style="text-align:right;padding:3px 8px;font-size:10px;color:#888;">GROSS PAY</th></tr>
          ${rows}
        </table>
      </div>`;
    })();

    // P&L mini summary table.
    const plMini = `<div style="margin-top:6px;">
      <div style="font-size:11px;font-weight:700;letter-spacing:.6px;color:#15803D;text-transform:uppercase;border-bottom:1.5px solid #15803D;padding-bottom:4px;margin-bottom:6px;">Profit &amp; Loss</div>
      <table style="width:100%;border-collapse:collapse;">
        <tr><td style="padding:4px 8px;font-size:13px;">Total revenue</td><td style="padding:4px 8px;text-align:right;font-size:13px;font-variant-numeric:tabular-nums;">${esc(docMoney(revenue))}</td></tr>
        <tr><td style="padding:4px 8px;font-size:13px;padding-left:20px;color:#666;">Catering invoices</td><td style="padding:4px 8px;text-align:right;font-size:12.5px;color:#666;font-variant-numeric:tabular-nums;">${esc(docMoney(totalRevenue))}</td></tr>
        ${manualIncome ? `<tr><td style="padding:4px 8px;font-size:13px;padding-left:20px;color:#666;">Other income</td><td style="padding:4px 8px;text-align:right;font-size:12.5px;color:#666;font-variant-numeric:tabular-nums;">${esc(docMoney(manualIncome))}</td></tr>` : ''}
        <tr><td style="padding:4px 8px;font-size:13px;">Total expenses</td><td style="padding:4px 8px;text-align:right;font-size:13px;font-variant-numeric:tabular-nums;">${esc(docMoney(expenses))}</td></tr>
        <tr><td style="padding:4px 8px;font-size:13px;padding-left:20px;color:#666;">Supplies &amp; purchases</td><td style="padding:4px 8px;text-align:right;font-size:12.5px;color:#666;font-variant-numeric:tabular-nums;">${esc(docMoney(totalSpending))}</td></tr>
        <tr><td style="padding:4px 8px;font-size:13px;padding-left:20px;color:#666;">Payroll</td><td style="padding:4px 8px;text-align:right;font-size:12.5px;color:#666;font-variant-numeric:tabular-nums;">${esc(docMoney(payrollTotal))}</td></tr>
        ${manualExpense ? `<tr><td style="padding:4px 8px;font-size:13px;padding-left:20px;color:#666;">Other expenses</td><td style="padding:4px 8px;text-align:right;font-size:12.5px;color:#666;font-variant-numeric:tabular-nums;">${esc(docMoney(manualExpense))}</td></tr>` : ''}
        <tr><td style="padding:8px;font-size:14px;font-weight:800;border-top:2px solid #333;">${net >= 0 ? 'Net profit' : 'Net loss'}</td><td style="padding:8px;text-align:right;font-size:14px;font-weight:800;border-top:2px solid #333;color:${net >= 0 ? '#15803D' : '#DC2626'};font-variant-numeric:tabular-nums;">${esc(docMoney(net))}</td></tr>
        <tr><td style="padding:4px 8px;font-size:12px;color:#777;">Margin</td><td style="padding:4px 8px;text-align:right;font-size:12px;color:#777;font-variant-numeric:tabular-nums;">${esc(margin)}</td></tr>
      </table>
    </div>`;

    // Key stats strip.
    const statTile = (lbl, val, color) => `<div style="background:#FBF6EC;border:1px solid #EED9B0;border-radius:6px;padding:10px;text-align:center;">
      <div style="font-size:18px;font-weight:800;color:${color || '#8B4513'};font-variant-numeric:tabular-nums;">${esc(val)}</div>
      <div style="font-size:10px;color:#888;text-transform:uppercase;letter-spacing:.5px;margin-top:3px;">${esc(lbl)}</div>
    </div>`;
    const stats = `<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-top:14px;">
      ${statTile('Catering invoices', String(filteredCatering.length))}
      ${statTile('Outstanding A/R', docMoney(outstanding), outstanding > 0 ? '#b91c1c' : '#8B4513')}
      ${statTile('Sales tax due', docMoney(taxDue), taxDue > 0 ? '#b91c1c' : '#15803d')}
      ${statTile('Avg invoice', filteredCatering.length > 0 ? docMoney(totalRevenue / filteredCatering.length) : '—')}
      ${statTile('Repeat customers', repeatCustomers.total > 0 ? `${repeatCustomers.pct}%` : '—')}
    </div>`;

    const html = buildProfessionalDoc({
      branding: brandingForReport(),
      docType: 'MONTHLY BUSINESS REPORT',
      docNumber: 'MBR-' + new Date().toISOString().slice(0, 10).replace(/-/g, ''),
      periodLabel: periodLabelFrom(filterFrom, filterTo) + (filterBiz ? ' · ' + (BUSINESSES[filterBiz]?.name || filterBiz) : ' · All businesses'),
      bodyHtml: plMini + stats + customersBlock + payrollBlock,
      footerNote: 'Single-page management summary for the period. Detailed source documents (P&L statement, payroll register, sales-tax report) are available from their respective tabs.',
    });
    printHtmlDocument(html, 'Monthly Business Report');
    logActivity('print_report', `Printed monthly business report (${periodLabelFrom(filterFrom, filterTo)})`);
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
        <div style={{ position: 'relative' }}>
          <button className="btn btn-primary btn-sm" onClick={() => setShowReportsMenu(v => !v)} title="Print professional reports for the selected period">📄 Reports ▾</button>
          {showReportsMenu && (
            <div style={{ position: 'absolute', top: '110%', right: 0, zIndex: 50, background: '#fff', border: '1px solid #ddd', borderRadius: 8, boxShadow: '0 6px 20px rgba(0,0,0,.12)', minWidth: 250, overflow: 'hidden' }}>
              {[
                { icon: '📈', label: 'Monthly Business Report', hint: 'One-page summary for the period', fn: printMonthlyReport },
                { icon: '🧾', label: 'Profit & Loss Statement', hint: 'Formal P&L on letterhead', fn: printProfitAndLoss },
                { icon: '🤝', label: 'Owner Profit Split', hint: 'Distribution statement with signatures', fn: printDistribution },
              ].map(item => (
                <button key={item.label} onClick={() => { setShowReportsMenu(false); item.fn(); }}
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '10px 14px', background: 'none', border: 'none', borderBottom: '1px solid #f3f3f3', cursor: 'pointer', fontSize: 13.5 }}
                  onMouseEnter={e => e.currentTarget.style.background = '#FBF6EC'}
                  onMouseLeave={e => e.currentTarget.style.background = 'none'}>
                  <span style={{ marginRight: 8 }}>{item.icon}</span><strong>{item.label}</strong>
                  <div style={{ fontSize: 11.5, color: '#888', marginLeft: 26 }}>{item.hint}</div>
                </button>
              ))}
            </div>
          )}
        </div>
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

