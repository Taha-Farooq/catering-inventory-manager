import React, { useState, useMemo, useEffect, useRef, Suspense, lazy, useId } from 'react';
import * as XLSX from 'xlsx';
import { showToast } from '../toastContext.jsx';
import { BUSINESSES } from '../constants.js';
import { fmt$, fmtDate } from '../formatters.js';
import { logActivity, logFailure, today } from '../tabUtils.js';

const LazyDailyFinanceCharts = lazy(() => import('../charts/DailyFinanceCharts.jsx'));

function FI({ label, suggestions, fieldStyle, ...props }) {
  const listId = useId();
  const hasSuggestions = Array.isArray(suggestions) && suggestions.length > 0;
  return (
    <div className="field" style={{ ...(label ? {} : { marginBottom: 0 }), ...fieldStyle }}>
      {label && <label>{label}</label>}
      <input className="input" {...props} list={hasSuggestions ? listId : undefined} />
      {hasSuggestions && (
        <datalist id={listId}>
          {suggestions.map(s => <option key={s} value={s} />)}
        </datalist>
      )}
    </div>
  );
}

function Btn({ className = '', children, ...p }) {
  return <button className={`btn ${className}`} {...p}>{children}</button>;
}

export default function DailyIncomeExpense({ entries, setEntries, selectedBusiness, save }) {
  const importRef = useRef();
  const [form, setForm] = useState(() => ({
    date: today(),
    business: selectedBusiness || 'degrill',
    income: '',
    expense: '',
    salesTaxCollected: '',
    taxPaid: '',
    notes: ''
  }));
  const [monthF, setMonthF] = useState('');
  const [yearF, setYearF] = useState('');

  useEffect(() => {
    setForm(f => ({ ...f, business: selectedBusiness || f.business || 'degrill' }));
  }, [selectedBusiness]);

  const sorted = useMemo(
    () => [...entries].sort((a, b) => (b.date || '').localeCompare(a.date || '')),
    [entries]
  );

  const filtered = useMemo(() => sorted.filter(r => {
    if (monthF && (r.date || '').slice(5, 7) !== monthF) return false;
    if (yearF && (r.date || '').slice(0, 4) !== yearF) return false;
    return true;
  }), [sorted, monthF, yearF]);

  const totals = useMemo(() => filtered.reduce((acc, r) => {
    acc.income += +(r.income || 0);
    acc.expense += +(r.expense || 0);
    acc.salesTaxCollected += +(r.salesTaxCollected || 0);
    acc.taxPaid += +(r.taxPaid || 0);
    return acc;
  }, { income: 0, expense: 0, salesTaxCollected: 0, taxPaid: 0 }), [filtered]);

  const net = +(totals.income - totals.expense).toFixed(2);
  const estimatedIncomeTax = +(Math.max(net, 0) * 0.22).toFixed(2);
  const salesTaxDue = +(totals.salesTaxCollected - totals.taxPaid).toFixed(2);

  const monthly = useMemo(() => {
    const m = {};
    entries.forEach(r => {
      const d = (r.date || '').slice(0, 7);
      if (!d) return;
      if (!m[d]) m[d] = { month: d, income: 0, expense: 0, tax: 0 };
      m[d].income += +(r.income || 0);
      m[d].expense += +(r.expense || 0);
      m[d].tax += +((r.salesTaxCollected || 0) - (r.taxPaid || 0));
    });
    return Object.values(m).sort((a, b) => a.month.localeCompare(b.month)).slice(-18).map(x => ({
      ...x,
      net: +(x.income - x.expense).toFixed(2),
      label: `${x.month.slice(5)}/${x.month.slice(2, 4)}`
    }));
  }, [entries]);

  function parseNum(v) {
    if (v === '' || v == null) return 0;
    const n = parseFloat(String(v).replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? +n.toFixed(2) : 0;
  }

  function saveRow() {
    if (!form.date) { showToast('Date is required. [DMG-E006]', 'error'); return; }
    const row = {
      id: crypto.randomUUID(),
      date: form.date,
      business: form.business || selectedBusiness || 'degrill',
      income: parseNum(form.income),
      expense: parseNum(form.expense),
      salesTaxCollected: parseNum(form.salesTaxCollected),
      taxPaid: parseNum(form.taxPaid),
      notes: String(form.notes || '').trim(),
      createdAt: new Date().toISOString()
    };
    const next = [...entries, row];
    setEntries(next);
    save('_dailyFinanceEntries', next);
    setForm(f => ({ ...f, income: '', expense: '', salesTaxCollected: '', taxPaid: '', notes: '' }));
    logActivity('add_item', `Added daily finance row ${row.date}`);
    showToast('Daily finance entry saved.');
  }

  function deleteRow(id) {
    const next = entries.filter(x => x.id !== id);
    setEntries(next);
    save('_dailyFinanceEntries', next);
    showToast('Entry deleted.');
  }

  function toExcelRows(rows) {
    return rows.map(r => ({
      Date: r.date || '',
      Business: BUSINESSES[r.business]?.name || r.business || '',
      Income: +(r.income || 0).toFixed(2),
      Expense: +(r.expense || 0).toFixed(2),
      'Net Profit': +((r.income || 0) - (r.expense || 0)).toFixed(2),
      'Sales Tax Collected': +(r.salesTaxCollected || 0).toFixed(2),
      'Tax Paid': +(r.taxPaid || 0).toFixed(2),
      'Sales Tax Due': +((r.salesTaxCollected || 0) - (r.taxPaid || 0)).toFixed(2),
      Notes: r.notes || ''
    }));
  }

  function exportExcel() {
    const wb = XLSX.utils.book_new();
    const dataRows = toExcelRows(filtered);
    const summaryRows = [{
      Scope: `${yearF || 'All years'} ${monthF ? `month ${monthF}` : ''}`.trim(),
      Income: +totals.income.toFixed(2),
      Expense: +totals.expense.toFixed(2),
      'Net Profit': +net.toFixed(2),
      'Estimated Income Tax (22%)': +estimatedIncomeTax.toFixed(2),
      'Sales Tax Collected': +totals.salesTaxCollected.toFixed(2),
      'Tax Paid': +totals.taxPaid.toFixed(2),
      'Sales Tax Due': +salesTaxDue.toFixed(2),
      'Generated At': new Date().toLocaleString()
    }];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(dataRows.length ? dataRows : [{
      Date: '', Business: '', Income: '', Expense: '', 'Net Profit': '',
      'Sales Tax Collected': '', 'Tax Paid': '', 'Sales Tax Due': '', Notes: ''
    }]), 'Daily Ledger');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), 'Tax Summary');
    XLSX.writeFile(wb, `daily-income-expense-${today()}.xlsx`);
    logActivity('export_xlsx', 'Exported daily income/expense Excel');
    showToast('Daily finance + tax summary exported.');
  }

  function normalizeDate(v) {
    if (typeof v === 'number' && Number.isFinite(v) && XLSX?.SSF?.parse_date_code) {
      const p = XLSX.SSF.parse_date_code(v);
      if (p && p.y && p.m && p.d) return `${String(p.y).padStart(4, '0')}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
    }
    const s = String(v || '').trim();
    if (!s) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    return '';
  }

  function pick(row, keys) {
    const norm = {};
    Object.keys(row || {}).forEach(k => { norm[String(k).toLowerCase().replace(/[^a-z0-9]/g, '')] = row[k]; });
    for (const key of keys) {
      const n = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (Object.prototype.hasOwnProperty.call(norm, n)) return norm[n];
    }
    return '';
  }

  async function importExcel(file) {
    try {
      if (!file) return;
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
      if (!rows.length) { showToast('No rows found in uploaded file.', 'error'); return; }
      const mapped = rows.map(r => {
        const date = normalizeDate(pick(r, ['date', 'day', 'transaction date', 'entry date']));
        const bizRaw = String(pick(r, ['business', 'store', 'location']) || '').toLowerCase();
        const business = Object.keys(BUSINESSES).find(k =>
          bizRaw.includes(k) || bizRaw.includes(BUSINESSES[k].name.toLowerCase())
        ) || selectedBusiness || 'degrill';
        return {
          id: crypto.randomUUID(),
          date: date || today(),
          business,
          income: parseNum(pick(r, ['income', 'revenue', 'sales', 'cashin'])),
          expense: parseNum(pick(r, ['expense', 'expenses', 'cost', 'spend', 'cashout'])),
          salesTaxCollected: parseNum(pick(r, ['salestaxcollected', 'taxcollected', 'sales tax'])),
          taxPaid: parseNum(pick(r, ['taxpaid', 'tax payment', 'tax remitted'])),
          notes: String(pick(r, ['notes', 'memo', 'description']) || '').trim(),
          createdAt: new Date().toISOString()
        };
      }).filter(r => r.date);
      if (!mapped.length) { showToast('No valid rows detected.', 'error'); return; }
      const next = [...entries, ...mapped];
      setEntries(next);
      save('_dailyFinanceEntries', next);
      logActivity('restore_backup', `Imported ${mapped.length} daily finance rows from Excel`);
      showToast(`Imported ${mapped.length} rows from Excel.`);
    } catch (e) {
      logFailure({ area: 'daily_finance', action: 'import_excel', error: e });
      showToast('Excel import failed. Check column names and try again.', 'error');
    }
  }

  return (
    <div>
      <div className="flex-between mb-3 flex-wrap gap-2">
        <div className="section-title" style={{ margin: 0 }}>Daily Income & Expense</div>
        <div className="flex gap-2">
          <Btn className="btn-outline btn-sm" onClick={() => importRef.current?.click()}>⬆ Upload Excel (2025/2026)</Btn>
          <input ref={importRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }} onChange={e => { importExcel(e.target.files?.[0]); e.target.value = ''; }} />
          <Btn className="btn-success btn-sm" onClick={exportExcel}>⬇ Export Excel</Btn>
        </div>
      </div>
      <div className="hint-card">Use this for daily accounting, backfill old records via Excel, and auto-generate tax-ready summaries.</div>

      <div className="card mb-3">
        <div className="grid-3">
          <FI label="Date" type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} />
          <div className="field">
            <label>Business</label>
            <select className="input" value={form.business} onChange={e => setForm(f => ({ ...f, business: e.target.value }))}>
              {Object.entries(BUSINESSES).map(([k, v]) => <option key={k} value={k}>{v.name}</option>)}
            </select>
          </div>
          <FI label="Daily Income" type="number" step="0.01" value={form.income} onChange={e => setForm(f => ({ ...f, income: e.target.value }))} />
          <FI label="Daily Expense" type="number" step="0.01" value={form.expense} onChange={e => setForm(f => ({ ...f, expense: e.target.value }))} />
          <FI label="Sales Tax Collected" type="number" step="0.01" value={form.salesTaxCollected} onChange={e => setForm(f => ({ ...f, salesTaxCollected: e.target.value }))} />
          <FI label="Tax Paid" type="number" step="0.01" value={form.taxPaid} onChange={e => setForm(f => ({ ...f, taxPaid: e.target.value }))} />
        </div>
        <FI label="Notes" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
        <div className="flex" style={{ justifyContent: 'flex-end' }}>
          <Btn className="btn-primary" onClick={saveRow}>Save Daily Entry</Btn>
        </div>
      </div>

      <div className="card mb-3">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 10, marginBottom: 8 }}>
          <div className="field" style={{ margin: 0 }}>
            <label>Year</label>
            <input className="input" placeholder="e.g. 2026" value={yearF} onChange={e => setYearF(e.target.value.replace(/[^0-9]/g, '').slice(0, 4))} />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>Month</label>
            <select className="input" value={monthF} onChange={e => setMonthF(e.target.value)}>
              <option value="">All</option>
              {Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0')).map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {[
            ['this', 'This Month', () => { const n=new Date(); setYearF(String(n.getFullYear())); setMonthF(String(n.getMonth()+1).padStart(2,'0')); }],
            ['last', 'Last Month', () => { const n=new Date(new Date().getFullYear(),new Date().getMonth()-1,1); setYearF(String(n.getFullYear())); setMonthF(String(n.getMonth()+1).padStart(2,'0')); }],
          ].map(([k, label, fn]) => (
            <Btn key={k} className="btn-sm" style={{background:'#eee',color:'#555',borderRadius:12,padding:'2px 10px'}} onClick={fn}>{label}</Btn>
          ))}
          {(yearF || monthF) && <Btn className="btn-sm" style={{background:'#eee',color:'#666',borderRadius:12,padding:'2px 10px'}} onClick={() => { setYearF(''); setMonthF(''); }}>✕ Clear</Btn>}
        </div>
      </div>

      <div className="stat-grid">
        {[
          { v: fmt$(totals.income), l: 'Income' },
          { v: fmt$(totals.expense), l: 'Expense' },
          { v: fmt$(net), l: 'Net Profit' },
          { v: fmt$(estimatedIncomeTax), l: 'Estimated Income Tax' },
          { v: fmt$(salesTaxDue), l: 'Sales Tax Due' },
          { v: filtered.length, l: 'Daily Entries' }
        ].map((s, i) => <div key={i} className="stat-card"><div className="stat-val">{s.v}</div><div className="stat-lbl">{s.l}</div></div>)}
      </div>

      {monthly.length > 1 && (
        <Suspense fallback={<div className="card mb-3 text-muted" style={{ padding: 24, textAlign: 'center' }}>Loading chart…</div>}>
          <LazyDailyFinanceCharts monthly={monthly} fmt$={fmt$} />
        </Suspense>
      )}

      <div className="card" style={{ padding: 0 }}>
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr><th>Date</th><th>Business</th><th>Income</th><th>Expense</th><th>Net</th><th>Tax Collected</th><th>Tax Paid</th><th>Tax Due</th><th>Notes</th><th></th></tr>
            </thead>
            <tbody>
              {filtered.map(r => (
                <tr key={r.id}>
                  <td>{fmtDate(r.date)}</td>
                  <td>{BUSINESSES[r.business]?.name || r.business}</td>
                  <td>{fmt$(r.income || 0)}</td>
                  <td>{fmt$(r.expense || 0)}</td>
                  <td style={{ fontWeight: 700, color: (r.income - r.expense) >= 0 ? 'var(--success)' : 'var(--danger)' }}>{fmt$((r.income || 0) - (r.expense || 0))}</td>
                  <td>{fmt$(r.salesTaxCollected || 0)}</td>
                  <td>{fmt$(r.taxPaid || 0)}</td>
                  <td>{fmt$((r.salesTaxCollected || 0) - (r.taxPaid || 0))}</td>
                  <td>{r.notes || '—'}</td>
                  <td><Btn className="btn-danger btn-sm" onClick={() => deleteRow(r.id)}>Delete</Btn></td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={10} style={{ textAlign: 'center', padding: 20, color: '#999' }}>No daily finance records yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
