import React, { useState, useMemo, useRef } from 'react';
import { BUSINESSES } from '../constants.js';
import { showToast } from '../toastContext.jsx';
import { reportError } from '../errors.js';
import { fmt$, fmtDate } from '../formatters.js';
import Modal from '../ui/Modal.jsx';
import Confirm from '../ui/Confirm.jsx';

// ─── inline UI primitives (same pattern as App.jsx) ─────────────────────────
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

const PAY_PERIODS = [
  { value: 'weekly',    label: 'Weekly (7 days)' },
  { value: 'biweekly',  label: 'Bi-weekly (14 days)' },
  { value: 'monthly',   label: 'Monthly' },
];

function blankForm(selectedBusiness) {
  return {
    employeeName: '',
    business: selectedBusiness || 'degrill',
    payPeriod: 'weekly',
    periodStart: today(),
    periodEnd: '',
    hourlyRate: '',
    regularHours: '',
    overtimeHours: '',
    notes: '',
    status: 'unpaid',
  };
}

function calcPayroll(form) {
  const rate = parseFloat(form.hourlyRate) || 0;
  const reg = parseFloat(form.regularHours) || 0;
  const ot = parseFloat(form.overtimeHours) || 0;
  const total = reg * rate + ot * rate * 1.5;
  return { rate, reg, ot, total };
}

function PayrollInvoiceView({ inv, brandingMap, onClose, onEdit, onCopy, onPrint }) {
  const brand = (() => {
    const b = brandingMap?.[inv.business];
    return b || { mark: 'PAY', name: inv.business || 'Business', address: '', phone: '', email: '' };
  })();

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
            {brand.phone && <div style={{ fontSize: 12, color: '#888' }}>Tel: {brand.phone}</div>}
            {brand.email && <div style={{ fontSize: 12, color: '#888' }}>{brand.email}</div>}
          </div>
        </div>
        <div style={{ textAlign: 'right', fontSize: 13 }}>
          <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--brown)' }}>{inv.id}</div>
          <div><strong>Type:</strong> Payroll Invoice</div>
          <div><strong>Created:</strong> {fmtDate(inv.createdAt || inv.date)}</div>
          <span className={`badge badge-${inv.status || 'unpaid'}`} style={{ marginTop: 4, display: 'inline-block' }}>{inv.status || 'unpaid'}</span>
        </div>
      </div>

      <div style={{ background: 'var(--cream)', borderRadius: 8, padding: '12px 14px', marginBottom: 16 }}>
        <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>{inv.employeeName}</div>
        {inv.employeeUsername && inv.employeeUsername !== inv.employeeName && (
          <div style={{ fontSize: 12, color: '#777' }}>@{inv.employeeUsername}</div>
        )}
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 16, fontSize: 13 }}>
        <tbody>
          <tr><td style={{ padding: '7px 10px', border: '1px solid #EED9B0' }}>Pay Period</td>
              <td style={{ padding: '7px 10px', border: '1px solid #EED9B0', fontWeight: 600 }}>{fmtDate(inv.periodStart)} – {fmtDate(inv.periodEnd)}{inv.payPeriod ? ` (${PAY_PERIODS.find(p=>p.value===inv.payPeriod)?.label || inv.payPeriod})` : ''}</td></tr>
          <tr><td style={{ padding: '7px 10px', border: '1px solid #EED9B0' }}>Regular Hours</td>
              <td style={{ padding: '7px 10px', border: '1px solid #EED9B0' }}>{inv.regularHours || 0}</td></tr>
          {(+inv.overtimeHours > 0) && (
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
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(() => blankForm(selectedBusiness));
  const [viewInv, setViewInv] = useState(null);
  const [confirmObj, setConfirmObj] = useState(null);
  const [showAllBiz, setShowAllBiz] = useState(false);

  const inv = payrollInvoices || [];

  const visible = useMemo(() => {
    const sorted = [...inv].sort((a, b) => (b.createdAt || b.date || '').localeCompare(a.createdAt || a.date || ''));
    return showAllBiz ? sorted : sorted.filter(i => !i.business || i.business === selectedBusiness);
  }, [inv, showAllBiz, selectedBusiness]);

  function save(data) {
    setPayrollInvoices(data);
    try { localStorage.setItem('payrollInvoices', JSON.stringify(data)); } catch (e) {
      reportError('DMG-E010', { key: 'payrollInvoices', message: String(e?.message || e) });
      showToast('Could not save payroll invoices (DMG-E010).', 'error');
    }
  }

  function openNew() {
    setEditingId(null);
    setForm(blankForm(selectedBusiness));
    setShowForm(true);
  }

  function openEdit(record) {
    setEditingId(record.id);
    setForm({
      employeeName: record.employeeName || '',
      business: record.business || selectedBusiness,
      payPeriod: record.payPeriod || 'weekly',
      periodStart: record.periodStart || record.date || today(),
      periodEnd: record.periodEnd || '',
      hourlyRate: String(record.hourlyRate || ''),
      regularHours: String(record.regularHours || ''),
      overtimeHours: String(record.overtimeHours || ''),
      notes: record.notes || '',
      status: record.status || 'unpaid',
    });
    setShowForm(true);
  }

  function copyRecord(record) {
    setEditingId(null);
    setViewInv(null);
    setForm({
      employeeName: record.employeeName || '',
      business: record.business || selectedBusiness,
      payPeriod: record.payPeriod || 'weekly',
      periodStart: today(),
      periodEnd: '',
      hourlyRate: String(record.hourlyRate || ''),
      regularHours: String(record.regularHours || ''),
      overtimeHours: String(record.overtimeHours || ''),
      notes: record.notes || '',
      status: 'unpaid',
    });
    setShowForm(true);
    showToast('Payroll record copied — review and save as new.');
  }

  function submit() {
    if (!form.employeeName.trim()) { showToast('Employee name is required. [DMG-E006]', 'error'); return; }
    if (!form.periodStart) { showToast('Period start date is required. [DMG-E006]', 'error'); return; }
    if (!form.periodEnd) { showToast('Period end date is required. [DMG-E006]', 'error'); return; }
    if (!(parseFloat(form.hourlyRate) > 0)) { showToast('Hourly rate must be greater than 0. [DMG-E006]', 'error'); return; }
    if (!(parseFloat(form.regularHours) >= 0)) { showToast('Regular hours must be 0 or more. [DMG-E006]', 'error'); return; }

    const { rate, reg, ot, total } = calcPayroll(form);

    if (editingId) {
      const updated = inv.map(r => r.id !== editingId ? r : {
        ...r,
        employeeName: form.employeeName.trim(),
        business: form.business,
        payPeriod: form.payPeriod,
        periodStart: form.periodStart,
        periodEnd: form.periodEnd,
        date: form.periodStart,
        hourlyRate: rate,
        regularHours: reg,
        overtimeHours: ot,
        total,
        notes: form.notes,
        status: form.status,
        updatedAt: new Date().toISOString(),
      });
      save(updated);
      setShowForm(false);
      setEditingId(null);
      showToast('Payroll invoice updated.');
    } else {
      const newId = `PAY-${form.periodStart}-${form.employeeName.trim().replace(/\s+/g, '-').slice(0, 20)}-${uid().slice(0, 6)}`;
      const record = {
        id: newId,
        invoiceStandard: 'PAYROLL_MANUAL_V1',
        _type: 'payroll',
        source: 'manual',
        employeeName: form.employeeName.trim(),
        employeeUsername: '',
        business: form.business,
        payPeriod: form.payPeriod,
        periodStart: form.periodStart,
        periodEnd: form.periodEnd,
        date: form.periodStart,
        _date: form.periodStart,
        hourlyRate: rate,
        regularHours: reg,
        overtimeHours: ot,
        hours: reg + ot,
        total,
        status: form.status,
        notes: form.notes,
        createdAt: new Date().toISOString(),
      };
      save([...inv, record]);
      setShowForm(false);
      showToast('Payroll invoice created.');
    }
  }

  function deleteRecord(record) {
    const updated = inv.filter(r => r.id !== record.id);
    save(updated);
    setConfirmObj(null);
    showToast('Payroll invoice deleted.');
  }

  function markPaid(id) {
    const updated = inv.map(r => r.id === id ? { ...r, status: 'paid' } : r);
    save(updated);
    showToast('Marked paid.');
  }

  function printInv(record) {
    const el = document.getElementById(`payroll-view-${record.id}`);
    if (!el) { showToast('Print content not found.', 'error'); return; }
    const w = window.open('', '_blank', 'width=900,height=700');
    if (!w) { showToast('Pop-up blocked. Please allow pop-ups.', 'error'); return; }
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"/><title>Payroll Invoice ${record.id}</title>
<style>body{font-family:Segoe UI,Arial,sans-serif;margin:20px;color:#222}.print-wrap{max-width:700px;margin:0 auto}table{width:100%;border-collapse:collapse}td{border:1px solid #ddd;padding:8px;font-size:13px}@media print{body{margin:8mm}}</style>
</head><body><div class="print-wrap">${el.outerHTML}</div></body></html>`);
    w.document.close(); w.focus();
    setTimeout(() => w.print(), 300);
  }

  const { total: previewTotal } = calcPayroll(form);

  return (
    <div>
      <div className="flex-between mb-4 flex-wrap gap-2">
        <div className="section-title" style={{ margin: 0 }}>Payroll Invoices — {BUSINESSES[selectedBusiness]?.name || selectedBusiness}</div>
        <div className="flex gap-2 flex-wrap" style={{ alignItems: 'center' }}>
          <label style={{ fontSize: 13, color: '#666', display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
            <input type="checkbox" checked={showAllBiz} onChange={e => setShowAllBiz(e.target.checked)} />
            All businesses
          </label>
          <Btn className="btn-primary" onClick={openNew}>+ New Payroll Invoice</Btn>
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="card empty-state">
          {inv.length === 0 ? 'No payroll invoices yet. Click "+ New Payroll Invoice" to create one.' : 'No invoices for this business. Use "All businesses" to see others.'}
        </div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Invoice #</th>
                  <th>Employee</th>
                  <th>Period</th>
                  <th>Business</th>
                  <th>Pay</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {visible.map(r => (
                  <tr key={r.id}>
                    <td style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 12 }}>{r.id}</td>
                    <td style={{ fontWeight: 600 }}>{r.employeeName}</td>
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
      <Modal open={showForm} onClose={() => { setShowForm(false); setEditingId(null); }} title={editingId ? 'Edit Payroll Invoice' : 'New Payroll Invoice'} maxW={620}>
        <div className="grid-2 mb-3">
          <FI label="Employee Name *" value={form.employeeName} onChange={e => setForm(f => ({ ...f, employeeName: e.target.value }))} placeholder="Full name" />
          <FS label="Business Entity *" value={form.business} onChange={e => setForm(f => ({ ...f, business: e.target.value }))}>
            {Object.entries(BUSINESSES).map(([k, v]) => <option key={k} value={k}>{v.name}</option>)}
          </FS>
        </div>
        <div className="grid-2 mb-3">
          <FS label="Pay Period Type" value={form.payPeriod} onChange={e => setForm(f => ({ ...f, payPeriod: e.target.value }))}>
            {PAY_PERIODS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
          </FS>
          <FS label="Status" value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
            <option value="unpaid">Unpaid</option>
            <option value="paid">Paid</option>
          </FS>
        </div>
        <div className="grid-2 mb-3">
          <FI label="Period Start *" type="date" value={form.periodStart} onChange={e => setForm(f => ({ ...f, periodStart: e.target.value }))} />
          <FI label="Period End *" type="date" value={form.periodEnd} onChange={e => setForm(f => ({ ...f, periodEnd: e.target.value }))} />
        </div>
        <div className="grid-2 mb-3">
          <FI label="Hourly Rate ($/hr) *" type="number" min="0" step="0.01" value={form.hourlyRate} onChange={e => setForm(f => ({ ...f, hourlyRate: e.target.value }))} placeholder="0.00" />
          <FI label="Regular Hours" type="number" min="0" step="0.5" value={form.regularHours} onChange={e => setForm(f => ({ ...f, regularHours: e.target.value }))} placeholder="0" />
        </div>
        <div className="grid-2 mb-3">
          <FI label="Overtime Hours (1.5×)" type="number" min="0" step="0.5" value={form.overtimeHours} onChange={e => setForm(f => ({ ...f, overtimeHours: e.target.value }))} placeholder="0" />
          <div className="field" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
            <div style={{ padding: '10px 12px', background: 'var(--cream)', borderRadius: 6, fontSize: 14 }}>
              <strong>Total Pay:</strong>{' '}
              <span style={{ color: 'var(--brown)', fontWeight: 700, fontSize: 16 }}>{fmt$(previewTotal)}</span>
            </div>
          </div>
        </div>
        <div className="field mb-3">
          <label>Notes</label>
          <textarea className="input" rows={2} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Optional notes..." />
        </div>
        <div className="flex gap-2" style={{ justifyContent: 'flex-end' }}>
          <Btn className="btn-outline" onClick={() => { setShowForm(false); setEditingId(null); }}>Cancel</Btn>
          <Btn className="btn-primary" onClick={submit}>{editingId ? 'Save Changes' : 'Create Invoice'}</Btn>
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
        message={confirmObj ? `Permanently delete invoice ${confirmObj.id} for ${confirmObj.employeeName}?` : ''}
        confirmLabel="Delete"
        confirmClass="btn-danger"
        onConfirm={() => deleteRecord(confirmObj)}
        onCancel={() => setConfirmObj(null)}
      />
    </div>
  );
}
