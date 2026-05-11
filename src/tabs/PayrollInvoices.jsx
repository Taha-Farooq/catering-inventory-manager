import React, { useState, useMemo } from 'react';
import * as XLSX from 'xlsx';
import { BUSINESSES } from '../constants.js';
import { showToast } from '../toastContext.jsx';
import { reportError } from '../errors.js';
import { fmt$, fmtDate } from '../formatters.js';
import Modal from '../ui/Modal.jsx';
import Confirm from '../ui/Confirm.jsx';

function FI({ label, ...props }) {
  return (
    <div className="field">
      {label && <label>{label}</label>}
      <input className="input" {...props} />
    </div>
  );
}
function FS({ label, children, ...props }) {
  return <div className="field">{label && <label>{label}</label>}<select className="input" {...props}>{children}</select></div>;
}
function Btn({ className = '', children, ...p }) {
  return <button className={`btn ${className}`} {...p}>{children}</button>;
}

const today = () => new Date().toISOString().slice(0, 10);
const uid = () => crypto.randomUUID();
export const EMPLOYEE_REGISTRY_KEY = '_employeeRegistry';

export function loadEmployeeRegistry() {
  try { return JSON.parse(localStorage.getItem(EMPLOYEE_REGISTRY_KEY) || '{}'); } catch { return {}; }
}
function persistRegistry(reg) {
  try { localStorage.setItem(EMPLOYEE_REGISTRY_KEY, JSON.stringify(reg)); } catch {}
}

function calcPeriodEnd(start, periodType) {
  const d = new Date(start + 'T12:00:00');
  if (periodType === 'weekly') d.setDate(d.getDate() + 6);
  else if (periodType === 'biweekly') d.setDate(d.getDate() + 13);
  else { d.setMonth(d.getMonth() + 1); d.setDate(0); }
  return d.toISOString().slice(0, 10);
}

const PAY_PERIODS = [
  { value: 'weekly',   label: 'Weekly (7 days)' },
  { value: 'biweekly', label: 'Bi-weekly (14 days)' },
  { value: 'monthly',  label: 'Monthly' },
];

function calcLinePay(payRate, regularHours, overtimeHours) {
  const rate = parseFloat(payRate) || 0;
  const reg  = Math.max(0, parseFloat(regularHours) || 0);
  const ot   = Math.max(0, parseFloat(overtimeHours) || 0);
  return { rate, reg, ot, total: reg * rate + ot * rate * 1.5 };
}

function blankHeader(selectedBusiness) {
  const start = today();
  return {
    business: selectedBusiness || Object.keys(BUSINESSES)[0] || '',
    payPeriod: 'weekly',
    periodStart: start,
    periodEnd: calcPeriodEnd(start, 'weekly'),
    status: 'unpaid',
    notes: '',
  };
}

function getInvEmployeeName(inv) {
  if (Array.isArray(inv.lines) && inv.lines.length > 0)
    return inv.lines.length === 1 ? inv.lines[0].name : `${inv.lines.length} employees`;
  return inv.employeeName || '—';
}

function PayrollInvoiceView({ inv, brandingMap, onClose, onEdit, onCopy, onPrint }) {
  const brand = (() => {
    const b = brandingMap?.[inv.business];
    return b || { mark: 'PAY', name: inv.business || 'Business', address: '', phone: '', email: '' };
  })();

  const hasLines = Array.isArray(inv.lines) && inv.lines.length > 0;

  return (
    <div id={`payroll-view-${inv.id}`}>
      <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <div style={{ width: 42, height: 42, borderRadius: '50%', background: '#8B4513', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 12, flexShrink: 0 }}>
            {brand.mark}
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--brown)' }}>{brand.name}</div>
            {brand.address && <div style={{ fontSize: 12, color: '#888' }}>{brand.address}</div>}
            {brand.phone  && <div style={{ fontSize: 12, color: '#888' }}>Tel: {brand.phone}</div>}
            {brand.email  && <div style={{ fontSize: 12, color: '#888' }}>{brand.email}</div>}
          </div>
        </div>
        <div style={{ textAlign: 'right', fontSize: 13 }}>
          <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--brown)' }}>{inv.id}</div>
          <div><strong>Type:</strong> Payroll Invoice</div>
          <div><strong>Created:</strong> {fmtDate(inv.createdAt || inv.date)}</div>
          <span className={`badge badge-${inv.status || 'unpaid'}`} style={{ marginTop: 4, display: 'inline-block' }}>{inv.status || 'unpaid'}</span>
        </div>
      </div>

      <div style={{ background: 'var(--cream)', borderRadius: 8, padding: '8px 14px', marginBottom: 12, fontSize: 13 }}>
        <strong>Pay Period:</strong> {fmtDate(inv.periodStart)} – {fmtDate(inv.periodEnd)}
        {inv.payPeriod ? ` (${PAY_PERIODS.find(p => p.value === inv.payPeriod)?.label || inv.payPeriod})` : ''}
        {' · '}<strong>Business:</strong> {BUSINESSES[inv.business]?.name || inv.business || '—'}
      </div>

      {hasLines ? (
        <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 16, fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#F5ECD7' }}>
              <th style={{ padding: '7px 10px', border: '1px solid #EED9B0', textAlign: 'left' }}>Employee</th>
              <th style={{ padding: '7px 10px', border: '1px solid #EED9B0', textAlign: 'right' }}>Reg Hrs</th>
              <th style={{ padding: '7px 10px', border: '1px solid #EED9B0', textAlign: 'right' }}>OT Hrs</th>
              <th style={{ padding: '7px 10px', border: '1px solid #EED9B0', textAlign: 'right' }}>Rate</th>
              <th style={{ padding: '7px 10px', border: '1px solid #EED9B0', textAlign: 'right' }}>Pay</th>
            </tr>
          </thead>
          <tbody>
            {inv.lines.map((line, i) => (
              <tr key={line.id || i}>
                <td style={{ padding: '7px 10px', border: '1px solid #EED9B0', fontWeight: 600 }}>{line.name}</td>
                <td style={{ padding: '7px 10px', border: '1px solid #EED9B0', textAlign: 'right' }}>{line.regularHours || 0}</td>
                <td style={{ padding: '7px 10px', border: '1px solid #EED9B0', textAlign: 'right' }}>{line.overtimeHours || 0}</td>
                <td style={{ padding: '7px 10px', border: '1px solid #EED9B0', textAlign: 'right' }}>{fmt$(line.payRate)}/hr</td>
                <td style={{ padding: '7px 10px', border: '1px solid #EED9B0', textAlign: 'right', fontWeight: 600 }}>{fmt$(line.total)}</td>
              </tr>
            ))}
            <tr style={{ background: '#fffdf8' }}>
              <td colSpan={4} style={{ padding: '7px 10px', border: '1px solid #EED9B0', fontWeight: 700, textAlign: 'right' }}>Total Payroll</td>
              <td style={{ padding: '7px 10px', border: '1px solid #EED9B0', fontWeight: 700, fontSize: 16, color: 'var(--brown)', textAlign: 'right' }}>{fmt$(inv.total)}</td>
            </tr>
          </tbody>
        </table>
      ) : (
        // Legacy single-employee layout
        <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 16, fontSize: 13 }}>
          <tbody>
            <tr><td style={{ padding: '7px 10px', border: '1px solid #EED9B0' }}>Employee</td>
                <td style={{ padding: '7px 10px', border: '1px solid #EED9B0', fontWeight: 600 }}>{inv.employeeName}</td></tr>
            <tr><td style={{ padding: '7px 10px', border: '1px solid #EED9B0' }}>Regular Hours</td>
                <td style={{ padding: '7px 10px', border: '1px solid #EED9B0' }}>{inv.regularHours || 0}</td></tr>
            {+inv.overtimeHours > 0 && (
              <tr><td style={{ padding: '7px 10px', border: '1px solid #EED9B0' }}>Overtime Hours (1.5×)</td>
                  <td style={{ padding: '7px 10px', border: '1px solid #EED9B0' }}>{inv.overtimeHours}</td></tr>
            )}
            <tr><td style={{ padding: '7px 10px', border: '1px solid #EED9B0' }}>Hourly Rate</td>
                <td style={{ padding: '7px 10px', border: '1px solid #EED9B0' }}>{fmt$(inv.hourlyRate)}/hr</td></tr>
            <tr style={{ background: '#fffdf8' }}>
              <td style={{ padding: '7px 10px', border: '1px solid #EED9B0', fontWeight: 700 }}>Total Pay</td>
              <td style={{ padding: '7px 10px', border: '1px solid #EED9B0', fontWeight: 700, fontSize: 16, color: 'var(--brown)' }}>{fmt$(inv.total)}</td>
            </tr>
          </tbody>
        </table>
      )}

      {inv.notes && <div style={{ fontSize: 13, color: '#666', fontStyle: 'italic', marginBottom: 12 }}>Notes: {inv.notes}</div>}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
        <Btn className="btn-outline" onClick={onPrint}>🖨 Print / Save PDF</Btn>
        <Btn className="btn-outline" onClick={onCopy}>Copy</Btn>
        <Btn className="btn-secondary" onClick={onEdit}>Edit</Btn>
        <Btn className="btn-primary" onClick={onClose}>Close</Btn>
      </div>
    </div>
  );
}

export default function PayrollInvoices({ payrollInvoices, setPayrollInvoices, selectedBusiness, brandingMap }) {
  const [showForm, setShowForm]         = useState(false);
  const [editingId, setEditingId]       = useState(null);
  const [header, setHeader]             = useState(() => blankHeader(selectedBusiness));
  const [lines, setLines]               = useState([]);
  const [lineForm, setLineForm]         = useState({ name: '', payRate: '', regularHours: '', overtimeHours: '' });
  const [editingLineId, setEditingLineId] = useState(null);
  const [registry, setRegistry]         = useState(() => loadEmployeeRegistry());
  const [viewInv, setViewInv]           = useState(null);
  const [confirmObj, setConfirmObj]     = useState(null);
  const [showAllBiz, setShowAllBiz]     = useState(true);
  const [filterStatus, setFilterStatus] = useState('all');
  const [filterEmployee, setFilterEmployee] = useState('');
  const [showSummary, setShowSummary]   = useState(false);

  const inv = payrollInvoices || [];

  const visible = useMemo(() => {
    let sorted = [...inv].sort((a, b) => (b.createdAt || b.date || '').localeCompare(a.createdAt || a.date || ''));
    if (!showAllBiz) sorted = sorted.filter(i => !i.business || i.business === selectedBusiness);
    if (filterStatus !== 'all') sorted = sorted.filter(i => (i.status || 'unpaid') === filterStatus);
    const q = filterEmployee.toLowerCase().trim();
    if (q) sorted = sorted.filter(i => {
      if (Array.isArray(i.lines)) return i.lines.some(l => (l.name || '').toLowerCase().includes(q));
      return (i.employeeName || '').toLowerCase().includes(q);
    });
    return sorted;
  }, [inv, showAllBiz, selectedBusiness, filterStatus, filterEmployee]);

  const outstandingTotal = useMemo(() =>
    inv.filter(i => i.status !== 'paid').reduce((s, i) => s + (i.total || 0), 0),
    [inv]
  );

  const monthlyPayroll = useMemo(() => {
    const m = {};
    inv.forEach(r => {
      const d = (r.periodStart || r.date || '').slice(0, 7);
      if (!d) return;
      if (!m[d]) m[d] = { month: d, total: 0, count: 0 };
      m[d].total += r.total || 0;
      m[d].count++;
    });
    return Object.values(m).sort((a, b) => b.month.localeCompare(a.month)).slice(0, 6);
  }, [inv]);

  const employeeSummary = useMemo(() => {
    const m = {};
    inv.forEach(r => {
      const isUnpaid = (r.status || 'unpaid') !== 'paid';
      const add = (name, reg, ot, total) => {
        if (!m[name]) m[name] = { name, totalPay: 0, totalRegHours: 0, totalOtHours: 0, count: 0, unpaidTotal: 0 };
        m[name].totalPay += total;
        m[name].totalRegHours += reg;
        m[name].totalOtHours += ot;
        m[name].count++;
        if (isUnpaid) m[name].unpaidTotal += total;
      };
      if (Array.isArray(r.lines) && r.lines.length > 0) {
        r.lines.forEach(l => add(l.name || 'Unknown', parseFloat(l.regularHours) || 0, parseFloat(l.overtimeHours) || 0, l.total || 0));
      } else {
        add(r.employeeName || 'Unknown', parseFloat(r.regularHours) || 0, parseFloat(r.overtimeHours) || 0, r.total || 0);
      }
    });
    return Object.values(m).sort((a, b) => b.totalPay - a.totalPay);
  }, [inv]);

  function saveInv(data) {
    setPayrollInvoices(data);
    try { localStorage.setItem('payrollInvoices', JSON.stringify(data)); } catch (e) {
      reportError('DMG-E010', { key: 'payrollInvoices', message: String(e?.message || e) });
      showToast('Could not save payroll invoices (DMG-E010).', 'error');
    }
  }

  function exportCsv() {
    if (!visible.length) { showToast('No payroll records to export.', 'error'); return; }
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const hdr = ['Invoice#', 'Employee', 'Period Start', 'Period End', 'Business', 'Status', 'Reg Hours', 'OT Hours', 'Pay Rate', 'Total', 'Notes'];
    const rows = [];
    visible.forEach(r => {
      if (Array.isArray(r.lines) && r.lines.length > 0) {
        r.lines.forEach(l => rows.push([r.id, l.name, r.periodStart || r.date, r.periodEnd || '', r.business || '', r.status || 'unpaid', l.regularHours || 0, l.overtimeHours || 0, l.payRate || 0, +(l.total || 0).toFixed(2), r.notes || '']));
      } else {
        rows.push([r.id, r.employeeName, r.periodStart || r.date, r.periodEnd || '', r.business || '', r.status || 'unpaid', r.regularHours || '', r.overtimeHours || '', r.hourlyRate || '', +(r.total || 0).toFixed(2), r.notes || '']);
      }
    });
    const csv = [hdr.map(esc).join(','), ...rows.map(row => row.map(esc).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'payroll-invoices-' + today() + '.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    showToast('Payroll exported as CSV.');
  }

  function exportExcel() {
    if (!visible.length) { showToast('No payroll records to export.', 'error'); return; }
    const wb = XLSX.utils.book_new();
    const hdr = ['Invoice#', 'Employee', 'Period Start', 'Period End', 'Business', 'Status', 'Reg Hours', 'OT Hours', 'Pay Rate', 'Total', 'Notes'];
    const rows = [];
    visible.forEach(r => {
      if (Array.isArray(r.lines) && r.lines.length > 0) {
        r.lines.forEach(l => rows.push([r.id, l.name, r.periodStart || r.date, r.periodEnd || '', r.business || '', r.status || 'unpaid', +(l.regularHours || 0), +(l.overtimeHours || 0), +(l.payRate || 0), +(l.total || 0).toFixed(2), r.notes || '']));
      } else {
        rows.push([r.id, r.employeeName, r.periodStart || r.date, r.periodEnd || '', r.business || '', r.status || 'unpaid', +(r.regularHours || 0), +(r.overtimeHours || 0), +(r.hourlyRate || 0), +(r.total || 0).toFixed(2), r.notes || '']);
      }
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([hdr, ...rows]), 'Payroll Records');
    const byMonth = {};
    visible.forEach(r => {
      const mo = (r.periodStart || r.date || '').slice(0, 7);
      if (!mo) return;
      if (!byMonth[mo]) byMonth[mo] = { month: mo, total: 0, count: 0 };
      byMonth[mo].total += r.total || 0;
      byMonth[mo].count++;
    });
    const mRows = Object.values(byMonth).sort((a, b) => a.month.localeCompare(b.month)).map(m => [m.month, m.count, +m.total.toFixed(2)]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Month', 'Invoices', 'Total'], ...mRows]), 'Monthly Summary');
    XLSX.writeFile(wb, 'payroll-invoices-' + today() + '.xlsx');
    showToast('Payroll exported as Excel.');
  }

  // ──── Form state helpers ──────────────────────────────────────────────────

  function openNew() {
    setEditingId(null);
    setHeader(blankHeader(selectedBusiness));
    setLines([]);
    setLineForm({ name: '', payRate: '', regularHours: '', overtimeHours: '' });
    setEditingLineId(null);
    setShowForm(true);
  }

  function loadIntoForm(record) {
    setHeader({
      business:    record.business || selectedBusiness,
      payPeriod:   record.payPeriod || 'weekly',
      periodStart: record.periodStart || record.date || today(),
      periodEnd:   record.periodEnd || '',
      status:      record.status || 'unpaid',
      notes:       record.notes || '',
    });
    if (Array.isArray(record.lines) && record.lines.length > 0) {
      setLines(record.lines.map(l => ({ ...l, id: l.id || uid() })));
    } else if (record.employeeName) {
      setLines([{ id: uid(), name: record.employeeName, payRate: record.hourlyRate || 0, regularHours: record.regularHours || 0, overtimeHours: record.overtimeHours || 0, total: record.total || 0 }]);
    } else {
      setLines([]);
    }
    setLineForm({ name: '', payRate: '', regularHours: '', overtimeHours: '' });
    setEditingLineId(null);
  }

  function openEdit(record) {
    setEditingId(record.id);
    loadIntoForm(record);
    setShowForm(true);
  }

  function copyRecord(record) {
    setViewInv(null);
    setEditingId(null);
    const start = today();
    const period = record.payPeriod || 'weekly';
    loadIntoForm({ ...record, periodStart: start, periodEnd: calcPeriodEnd(start, period), status: 'unpaid' });
    setShowForm(true);
    showToast('Payroll record copied — review and save as new.');
  }

  function handleLineNameChange(name) {
    const reg = loadEmployeeRegistry();
    const known = reg[name.trim()];
    setLineForm(f => ({ ...f, name, payRate: known ? String(known.payRate) : f.payRate }));
  }

  function addLine() {
    const name = lineForm.name.trim();
    if (!name) { showToast('Employee name is required.', 'error'); return; }
    if (!(parseFloat(lineForm.payRate) > 0)) { showToast('Pay rate must be greater than 0.', 'error'); return; }
    if (!(parseFloat(lineForm.regularHours) >= 0)) { showToast('Regular hours must be 0 or more.', 'error'); return; }

    const { rate, reg, ot, total } = calcLinePay(lineForm.payRate, lineForm.regularHours, lineForm.overtimeHours);

    const reg2 = loadEmployeeRegistry();
    reg2[name] = { payRate: rate, lastUsed: new Date().toISOString() };
    persistRegistry(reg2);
    setRegistry(reg2);

    if (editingLineId) {
      setLines(prev => prev.map(l => l.id === editingLineId
        ? { id: editingLineId, name, payRate: rate, regularHours: reg, overtimeHours: ot, total }
        : l));
      setEditingLineId(null);
    } else {
      setLines(prev => [...prev, { id: uid(), name, payRate: rate, regularHours: reg, overtimeHours: ot, total }]);
    }
    setLineForm({ name: '', payRate: '', regularHours: '', overtimeHours: '' });
  }

  function editLine(line) {
    setLineForm({ name: line.name, payRate: String(line.payRate), regularHours: String(line.regularHours), overtimeHours: String(line.overtimeHours || 0) });
    setEditingLineId(line.id);
  }

  function removeLine(id) {
    setLines(prev => prev.filter(l => l.id !== id));
    if (editingLineId === id) {
      setEditingLineId(null);
      setLineForm({ name: '', payRate: '', regularHours: '', overtimeHours: '' });
    }
  }

  function submitInvoice() {
    if (lines.length === 0) { showToast('Add at least one employee before saving.', 'error'); return; }
    if (!header.periodStart) { showToast('Period start date is required. [DMG-E006]', 'error'); return; }
    if (!header.periodEnd)   { showToast('Period end date is required. [DMG-E006]', 'error'); return; }
    if (header.periodEnd < header.periodStart) { showToast('Period end must be on or after period start. [DMG-E006]', 'error'); return; }

    const invoiceTotal = lines.reduce((s, l) => s + (l.total || 0), 0);
    const primaryName  = lines.length === 1 ? lines[0].name : `${lines.length} employees`;

    if (editingId) {
      const updated = inv.map(r => r.id !== editingId ? r : {
        ...r,
        invoiceStandard: 'PAYROLL_MULTI_V2',
        employeeName: primaryName,
        business: header.business,
        payPeriod: header.payPeriod,
        periodStart: header.periodStart,
        periodEnd: header.periodEnd,
        date: header.periodStart,
        lines,
        total: invoiceTotal,
        status: header.status,
        notes: header.notes,
        updatedAt: new Date().toISOString(),
      });
      saveInv(updated);
      setShowForm(false);
      setEditingId(null);
      showToast('Payroll invoice updated.');
    } else {
      const newId = `PAY-${header.periodStart}-${primaryName.replace(/\s+/g, '-').slice(0, 15)}-${uid().slice(0, 6)}`;
      saveInv([...inv, {
        id: newId,
        invoiceStandard: 'PAYROLL_MULTI_V2',
        _type: 'payroll',
        source: 'manual',
        employeeName: primaryName,
        business: header.business,
        payPeriod: header.payPeriod,
        periodStart: header.periodStart,
        periodEnd: header.periodEnd,
        date: header.periodStart,
        _date: header.periodStart,
        lines,
        total: invoiceTotal,
        status: header.status,
        notes: header.notes,
        createdAt: new Date().toISOString(),
      }]);
      setShowForm(false);
      showToast(`Payroll invoice created (${lines.length} employee${lines.length !== 1 ? 's' : ''}).`);
    }
  }

  function deleteRecord(record) {
    saveInv(inv.filter(r => r.id !== record.id));
    setConfirmObj(null);
    showToast('Payroll invoice deleted.');
  }

  function markPaid(id) {
    saveInv(inv.map(r => r.id === id ? { ...r, status: 'paid' } : r));
    showToast('Marked paid.');
  }

  function printInv(record) {
    const el = document.getElementById(`payroll-view-${record.id}`);
    if (!el) { showToast('Print content not found.', 'error'); return; }
    const w = window.open('', '_blank', 'width=900,height=700');
    if (!w) { showToast('Pop-up blocked. Please allow pop-ups.', 'error'); return; }
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"/><title>Payroll Invoice ${record.id}</title>
<style>body{font-family:Segoe UI,Arial,sans-serif;margin:20px;color:#222}.print-wrap{max-width:700px;margin:0 auto}table{width:100%;border-collapse:collapse}td,th{border:1px solid #ddd;padding:8px;font-size:13px}@media print{body{margin:8mm}}</style>
</head><body><div class="print-wrap">${el.outerHTML}</div></body></html>`);
    w.document.close(); w.focus();
    setTimeout(() => w.print(), 300);
  }

  const linePreview   = calcLinePay(lineForm.payRate, lineForm.regularHours, lineForm.overtimeHours);
  const registryNames = Object.keys(registry).sort();

  return (
    <div>
      {/* Header bar */}
      <div className="flex-between mb-4 flex-wrap gap-2">
        <div className="section-title" style={{ margin: 0 }}>Payroll Invoices</div>
        <div className="flex gap-2 flex-wrap" style={{ alignItems: 'center' }}>
          <label style={{ fontSize: 13, color: '#666', display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
            <input type="checkbox" checked={showAllBiz} onChange={e => setShowAllBiz(e.target.checked)} />
            All businesses
          </label>
          <select className="input" style={{ width: 'auto' }} value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
            <option value="all">All statuses</option>
            <option value="unpaid">Unpaid only</option>
            <option value="paid">Paid only</option>
          </select>
          <input className="input" style={{ width: 160 }} placeholder="Search employee…" value={filterEmployee} onChange={e => setFilterEmployee(e.target.value)} />
          <Btn className="btn-outline" onClick={exportCsv}>⬇ CSV</Btn>
          <Btn className="btn-outline" onClick={exportExcel}>⬇ Excel</Btn>
          <Btn className="btn-primary" onClick={openNew}>+ New Payroll Invoice</Btn>
        </div>
      </div>

      {outstandingTotal > 0 && (
        <div style={{ background: '#FEF3C7', border: '1px solid #FDE68A', borderRadius: 8, padding: '10px 16px', marginBottom: 16, fontSize: 13.5, color: '#92400E', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontWeight: 700 }}>⚠ Outstanding:</span>
          {fmt$(outstandingTotal)} unpaid across {inv.filter(i => i.status !== 'paid').length} payroll record{inv.filter(i => i.status !== 'paid').length !== 1 ? 's' : ''}
        </div>
      )}

      {monthlyPayroll.length > 0 && (
        <div className="card mb-4">
          <div className="section-title" style={{ marginBottom: 10 }}>Monthly Payroll (Last 6 Months)</div>
          {(() => {
            const maxV = Math.max(...monthlyPayroll.map(m => m.total), 1);
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {monthlyPayroll.map(m => (
                  <div key={m.month} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
                    <div style={{ width: 52, color: '#888', textAlign: 'right', flexShrink: 0 }}>{m.month.slice(5) + '/' + m.month.slice(2, 4)}</div>
                    <div style={{ flex: 1, background: '#F5ECD7', borderRadius: 4, overflow: 'hidden', height: 16 }}>
                      <div style={{ width: `${m.total / maxV * 100}%`, background: 'var(--brown)', height: '100%', borderRadius: 4 }} />
                    </div>
                    <div style={{ width: 68, fontWeight: 600, color: 'var(--brown)', flexShrink: 0 }}>{fmt$(m.total)}</div>
                    <div style={{ width: 40, color: '#888', textAlign: 'right', fontSize: 11, flexShrink: 0 }}>{m.count} inv</div>
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
      )}

      <div className="card mb-4" style={{ padding: 0 }}>
        <button
          style={{ width: '100%', padding: '12px 16px', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontWeight: 700, color: 'var(--brown)', fontSize: 14 }}
          onClick={() => setShowSummary(v => !v)}
        >
          <span>👥 Employee Summary ({employeeSummary.length} employee{employeeSummary.length !== 1 ? 's' : ''})</span>
          <span>{showSummary ? '▲' : '▼'}</span>
        </button>
        {showSummary && (
          <div className="tbl-wrap" style={{ borderTop: '1px solid #EED9B0' }}>
            <table>
              <thead><tr><th>Employee</th><th>Pay Periods</th><th>Reg Hrs</th><th>OT Hrs</th><th>Total Pay</th><th>Unpaid</th></tr></thead>
              <tbody>
                {employeeSummary.map(e => (
                  <tr key={e.name}>
                    <td style={{ fontWeight: 600 }}>{e.name}</td>
                    <td style={{ color: '#777' }}>{e.count}</td>
                    <td>{e.totalRegHours.toFixed(1)}</td>
                    <td>{e.totalOtHours.toFixed(1)}</td>
                    <td style={{ fontWeight: 700, color: 'var(--brown)' }}>{fmt$(e.totalPay)}</td>
                    <td style={{ color: e.unpaidTotal > 0 ? '#DC2626' : '#15803D', fontWeight: e.unpaidTotal > 0 ? 600 : 400 }}>{e.unpaidTotal > 0 ? fmt$(e.unpaidTotal) : 'Paid'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {visible.length === 0 ? (
        <div className="card empty-state">
          {inv.length === 0 ? 'No payroll invoices yet. Click "+ New Payroll Invoice" to create one.' : 'No invoices match filters.'}
        </div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Invoice #</th>
                  <th>Employees</th>
                  <th>Period</th>
                  <th>Business</th>
                  <th>Total Pay</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {visible.map(r => (
                  <tr key={r.id}>
                    <td style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 12 }}>{r.id}</td>
                    <td style={{ fontWeight: 600 }}>{getInvEmployeeName(r)}</td>
                    <td style={{ fontSize: 12 }}>{fmtDate(r.periodStart)} – {fmtDate(r.periodEnd || r.date)}</td>
                    <td style={{ fontSize: 12, color: '#777' }}>{BUSINESSES[r.business]?.name || r.business || '—'}</td>
                    <td style={{ fontWeight: 600 }}>{fmt$(r.total)}</td>
                    <td><span className={`badge badge-${r.status || 'unpaid'}`}>{r.status || 'unpaid'}</span></td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <Btn className="btn-secondary btn-sm" style={{ marginRight: 4 }} onClick={() => setViewInv(r)}>View</Btn>
                      <Btn className="btn-outline btn-sm" style={{ marginRight: 4 }} onClick={() => openEdit(r)}>Edit</Btn>
                      <Btn className="btn-outline btn-sm" style={{ marginRight: 4 }} onClick={() => copyRecord(r)}>Copy</Btn>
                      {r.status !== 'paid' && <Btn className="btn-success btn-sm" style={{ marginRight: 4 }} onClick={() => markPaid(r.id)}>Mark Paid</Btn>}
                      <Btn className="btn-danger btn-sm" onClick={() => setConfirmObj(r)}>Delete</Btn>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Create / Edit modal */}
      <Modal open={showForm} onClose={() => { setShowForm(false); setEditingId(null); }} title={editingId ? 'Edit Payroll Invoice' : 'New Payroll Invoice'} maxW={700}>

        {/* ── Invoice header ── */}
        <div style={{ background: '#F9F5EF', borderRadius: 8, padding: '12px 14px', marginBottom: 16 }}>
          <div style={{ fontWeight: 700, fontSize: 13, color: '#7a5c00', marginBottom: 10 }}>Invoice Details</div>
          <div className="grid-2 mb-2">
            <FS label="Business Entity" value={header.business} onChange={e => setHeader(h => ({ ...h, business: e.target.value }))}>
              {Object.entries(BUSINESSES).map(([k, v]) => <option key={k} value={k}>{v.name}</option>)}
            </FS>
            <FS label="Pay Period Type" value={header.payPeriod} onChange={e => setHeader(h => ({ ...h, payPeriod: e.target.value, periodEnd: h.periodStart ? calcPeriodEnd(h.periodStart, e.target.value) : h.periodEnd }))}>
              {PAY_PERIODS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
            </FS>
          </div>
          <div className="grid-2 mb-2">
            <FI label="Period Start *" type="date" value={header.periodStart} onChange={e => setHeader(h => ({ ...h, periodStart: e.target.value, periodEnd: e.target.value ? calcPeriodEnd(e.target.value, h.payPeriod) : h.periodEnd }))} />
            <FI label="Period End *"   type="date" value={header.periodEnd}   onChange={e => setHeader(h => ({ ...h, periodEnd: e.target.value }))} />
          </div>
          <div className="grid-2">
            <FS label="Status" value={header.status} onChange={e => setHeader(h => ({ ...h, status: e.target.value }))}>
              <option value="unpaid">Unpaid</option>
              <option value="paid">Paid</option>
            </FS>
            <div className="field">
              <label>Notes</label>
              <input className="input" value={header.notes} onChange={e => setHeader(h => ({ ...h, notes: e.target.value }))} placeholder="Optional…" />
            </div>
          </div>
        </div>

        {/* ── Employee line entry ── */}
        <div style={{ background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: 8, padding: '12px 14px', marginBottom: 12 }}>
          <div style={{ fontWeight: 700, fontSize: 13, color: '#1e40af', marginBottom: 10 }}>
            {editingLineId ? '✏️ Edit Employee Entry' : '➕ Add Employee'}
          </div>
          <div className="field mb-2">
            <label>Employee Name *</label>
            <input
              className="input"
              list="emp-names-list"
              value={lineForm.name}
              onChange={e => handleLineNameChange(e.target.value)}
              placeholder="Type or select name…"
            />
            <datalist id="emp-names-list">
              {registryNames.map(n => <option key={n} value={n} />)}
            </datalist>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 10, marginBottom: 10 }}>
            <FI label="Pay Rate ($/hr) *" type="number" min="0" step="0.01" value={lineForm.payRate}       onChange={e => setLineForm(f => ({ ...f, payRate: e.target.value }))}       placeholder="0.00" />
            <FI label="Regular Hours"     type="number" min="0" step="0.5"  value={lineForm.regularHours}  onChange={e => setLineForm(f => ({ ...f, regularHours: e.target.value }))}  placeholder="0" />
            <FI label="OT Hours (1.5×)"   type="number" min="0" step="0.5"  value={lineForm.overtimeHours} onChange={e => setLineForm(f => ({ ...f, overtimeHours: e.target.value }))} placeholder="0" />
            <div className="field" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
              <div style={{ padding: '9px 10px', background: '#fff', border: '1px solid #BFDBFE', borderRadius: 6, textAlign: 'center' }}>
                <div style={{ fontSize: 11, color: '#666', marginBottom: 2 }}>Subtotal</div>
                <span style={{ color: '#1e40af', fontWeight: 700, fontSize: 14 }}>{fmt$(linePreview.total)}</span>
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn className="btn-primary" onClick={addLine}>
              {editingLineId ? 'Update Entry' : '+ Add to Invoice'}
            </Btn>
            {editingLineId && (
              <Btn className="btn-outline" onClick={() => { setEditingLineId(null); setLineForm({ name: '', payRate: '', regularHours: '', overtimeHours: '' }); }}>
                Cancel Edit
              </Btn>
            )}
          </div>
        </div>

        {/* ── Built lines list ── */}
        {lines.length > 0 ? (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontWeight: 700, fontSize: 13, color: '#444', marginBottom: 8 }}>
              Invoice Lines — {lines.length} employee{lines.length !== 1 ? 's' : ''}
            </div>
            <div style={{ border: '1px solid #EED9B0', borderRadius: 8, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#F5ECD7' }}>
                    <th style={{ padding: '7px 10px', textAlign: 'left' }}>Employee</th>
                    <th style={{ padding: '7px 10px', textAlign: 'right' }}>Reg Hrs</th>
                    <th style={{ padding: '7px 10px', textAlign: 'right' }}>OT Hrs</th>
                    <th style={{ padding: '7px 10px', textAlign: 'right' }}>Rate</th>
                    <th style={{ padding: '7px 10px', textAlign: 'right' }}>Pay</th>
                    <th style={{ padding: '7px 10px' }}></th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, i) => (
                    <tr key={line.id} style={{ background: editingLineId === line.id ? '#EFF6FF' : (i % 2 === 0 ? '#fff' : '#fffdf8') }}>
                      <td style={{ padding: '7px 10px', fontWeight: 600 }}>{line.name}</td>
                      <td style={{ padding: '7px 10px', textAlign: 'right' }}>{line.regularHours}</td>
                      <td style={{ padding: '7px 10px', textAlign: 'right' }}>{line.overtimeHours || 0}</td>
                      <td style={{ padding: '7px 10px', textAlign: 'right' }}>{fmt$(line.payRate)}/hr</td>
                      <td style={{ padding: '7px 10px', textAlign: 'right', fontWeight: 600, color: 'var(--brown)' }}>{fmt$(line.total)}</td>
                      <td style={{ padding: '7px 10px', textAlign: 'center', whiteSpace: 'nowrap' }}>
                        <Btn className="btn-outline btn-sm" style={{ marginRight: 4 }} onClick={() => editLine(line)}>Edit</Btn>
                        <Btn className="btn-danger btn-sm" onClick={() => removeLine(line.id)}>✕</Btn>
                      </td>
                    </tr>
                  ))}
                  <tr style={{ background: '#F9F5EF', fontWeight: 700 }}>
                    <td colSpan={4} style={{ padding: '9px 10px', textAlign: 'right', fontSize: 14 }}>Invoice Total</td>
                    <td style={{ padding: '9px 10px', textAlign: 'right', fontSize: 15, color: 'var(--brown)' }}>{fmt$(lines.reduce((s, l) => s + l.total, 0))}</td>
                    <td></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div style={{ textAlign: 'center', color: '#aaa', fontSize: 13, padding: '12px 0', marginBottom: 12 }}>
            No employees added yet — fill in the form above and click "Add to Invoice".
          </div>
        )}

        <div className="flex gap-2" style={{ justifyContent: 'flex-end' }}>
          <Btn className="btn-outline" onClick={() => { setShowForm(false); setEditingId(null); }}>Cancel</Btn>
          <Btn className="btn-primary" disabled={lines.length === 0} onClick={submitInvoice}>
            {editingId ? 'Save Changes' : `Create Invoice (${lines.length} employee${lines.length !== 1 ? 's' : ''})`}
          </Btn>
        </div>
      </Modal>

      {/* View modal */}
      <Modal open={!!viewInv} onClose={() => setViewInv(null)} title={`Payroll Invoice ${viewInv?.id || ''}`} wide closeOnBackdrop>
        {viewInv && (
          <PayrollInvoiceView
            inv={viewInv}
            brandingMap={brandingMap}
            onClose={() => setViewInv(null)}
            onEdit={() => { const v = viewInv; setViewInv(null); openEdit(v); }}
            onCopy={() => copyRecord(viewInv)}
            onPrint={() => printInv(viewInv)}
          />
        )}
      </Modal>

      <Confirm
        open={!!confirmObj}
        title="Delete payroll invoice?"
        message={confirmObj ? `Permanently delete invoice ${confirmObj.id} for ${getInvEmployeeName(confirmObj)}?` : ''}
        confirmLabel="Delete"
        confirmClass="btn-danger"
        onConfirm={() => deleteRecord(confirmObj)}
        onCancel={() => setConfirmObj(null)}
      />
    </div>
  );
}
