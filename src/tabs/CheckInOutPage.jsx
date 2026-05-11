import React, { useState, useEffect } from 'react';
import * as XLSX from 'xlsx';
import QRCode from 'qrcode';
import { showToast, toastApiFailure } from '../toastContext.jsx';
import { BackendUnavailableBanner } from '../ReliabilityBanners.jsx';
import { fmt$ } from '../formatters.js';
import { load, save } from '../utils/storage.js';
import { logActivity } from '../utils/activity.js';
import { printHtmlDocument } from '../utils/print.js';

function Btn({ className='', children, ...p }) {
  return <button className={`btn ${className}`} {...p}>{children}</button>;
}

export default function CheckInOutPage({ attendanceApiCall, currentUser, attendanceToken, onEnterKiosk, kioskLock, selectedBusiness, payrollInvoices, setPayrollInvoices, isOnline, sessionTimeLeft = 0, onAttendanceComplete }) {
  const isAdmin = currentUser?.role === 'admin';
  const isKioskStation = isAdmin && kioskLock;
  const [workGate, setWorkGate] = useState({ loading: !isAdmin, ok: !!isAdmin, reason: '' });
  const [me, setMe] = useState(null);
  const [err, setErr] = useState('');
  const [backendDown, setBackendDown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState(null);
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [qrCountdown, setQrCountdown] = useState(0);
  const [weekStart, setWeekStart] = useState(() => {
    const d = new Date();
    const diff = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - diff);
    return d.toISOString().slice(0, 10);
  });
  const [summary, setSummary] = useState({ rows: [], active: {}, payRates: {} });
  const [rateDrafts, setRateDrafts] = useState({});
  const [targetUser, setTargetUser] = useState('');
  const [localCache, setLocalCache] = useState(() => load('_attendanceCache', []));
  const [showLocalCache, setShowLocalCache] = useState(false);

  async function loadMe() {
    const res = await attendanceApiCall('/api/attendance/me', { currentUser });
    if (!res.ok) {
      if (res.code === 'DMG-E021' || res.code === 'DMG-E030') setBackendDown(true);
      else toastApiFailure(res, 'Failed to load status');
      setErr(res.error || 'Failed to load status');
      return;
    }
    setBackendDown(false);
    setErr('');
    setMe(res.data);
  }
  async function validateWorkGate() {
    if (isAdmin) { setWorkGate({ loading:false, ok:true, reason:'' }); return; }
    if (!attendanceToken) {
      setWorkGate({ loading:false, ok:false, reason:'Missing live work QR token.' });
      return false;
    }
    const res = await attendanceApiCall('/api/attendance/qr/validate', {
      currentUser,
      query: { token: attendanceToken }
    });
    if (!res.ok) {
      setWorkGate({ loading:false, ok:false, reason:res.error || 'Invalid or expired work token.' });
      return false;
    }
    setWorkGate({ loading:false, ok:true, reason:'' });
    return true;
  }
  async function loadSummary() {
    if (!isAdmin) return;
    const res = await attendanceApiCall('/api/attendance/admin/summary', { currentUser, query: { weekStart } });
    if (!res.ok) {
      toastApiFailure(res, 'Failed to load payroll summary');
      setErr(res.error || 'Failed to load payroll summary');
      return;
    }
    setSummary(res.data);
  }
  useEffect(() => {
    validateWorkGate().then(ok => {
      if (!ok && !isAdmin) return;
      loadMe();
      loadSummary();
    });
  }, [weekStart, currentUser?.username, attendanceToken]);

  async function checkAction(action, overrideUser = '') {
    setBusy(true);
    const res = await attendanceApiCall('/api/attendance/check', {
      currentUser,
      method: 'POST',
      body: { action, token: attendanceToken || '', targetUser: overrideUser || undefined }
    });
    setBusy(false);
    if (!res.ok) {
      toastApiFailure(res, 'Check in/out failed');
      setErr(res.error || 'Action failed');
      return;
    }
    setErr('');
    const statusLabel = res.data.status === 'in' ? 'in' : 'out';
    showToast(`Checked ${statusLabel} successfully.`);
    // Save locally so admin can see recent activity even when backend is offline
    const entry = {
      id: crypto.randomUUID(),
      username: overrideUser || currentUser.username,
      displayName: overrideUser || currentUser.displayName || currentUser.username,
      action: statusLabel,
      timestamp: new Date().toISOString(),
      business: selectedBusiness,
      byAdmin: !!overrideUser,
    };
    setLocalCache(prev => {
      const next = [entry, ...prev].slice(0, 200);
      save('_attendanceCache', next);
      return next;
    });
    logActivity('attendance_' + statusLabel, `Checked ${statusLabel}${overrideUser ? ' (admin override for ' + overrideUser + ')' : ''}`);
    loadMe();
    loadSummary();
    if (onAttendanceComplete) onAttendanceComplete();
  }
  async function createQr() {
    const res = await attendanceApiCall('/api/attendance/qr/create', { currentUser, method:'POST' });
    if (!res.ok) {
      toastApiFailure(res, 'Failed to generate QR');
      setErr(res.error || 'Failed to generate QR');
      return;
    }
    setQr(res.data);
    setErr('');
  }
  async function saveRate(username) {
    const val = rateDrafts[username];
    const res = await attendanceApiCall('/api/attendance/admin/pay-rate', {
      currentUser,
      method: 'POST',
      body: { username, hourlyRate: Number(val || 0) }
    });
    if (!res.ok) {
      toastApiFailure(res, 'Failed to save rate');
      setErr(res.error || 'Failed to save rate');
      return;
    }
    showToast(`Pay rate saved for ${username}.`);
    loadSummary();
  }
  async function forceOut(username) {
    const res = await attendanceApiCall('/api/attendance/admin/force-out', { currentUser, method:'POST', body:{ username } });
    if (!res.ok) {
      toastApiFailure(res, 'Force out failed');
      setErr(res.error || 'Force out failed');
      return;
    }
    showToast(`${username} checked out by admin.`);
    loadSummary();
  }
  function exportPayrollCsv() {
    const header = ['Week Start','Username','Display Name','Hours','Regular Hours','Overtime Hours','Hourly Rate','Weekly Pay','Sessions'];
    const esc = v => `"${String(v ?? '').replace(/"/g,'""')}"`;
    const lines = (summary.rows || []).map(r => [
      weekStart, r.username, r.displayName || r.username, r.hours, r.regularHours, r.overtimeHours, r.hourlyRate, r.weeklyPay, r.sessions
    ].map(esc).join(','));
    const csv = [header.map(esc).join(','), ...lines].join('\n');
    const blob = new Blob([csv], { type:'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `payroll-${weekStart}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  }
  function exportPayrollPackExcel() {
    const rows = (summary.rows || []);
    const generatedDocs = rows.map((r, idx) => {
      const id = `PAY-${weekStart}-${r.username}`;
      return {
        id,
        invoiceStandard: 'PAYROLL_WEEKLY_V1',
        _type: 'payroll',
        date: weekStart,
        _date: weekStart,
        business: selectedBusiness || 'degrill',
        employeeUsername: r.username,
        employeeName: r.displayName || r.username,
        regularHours: +(r.regularHours || 0),
        overtimeHours: +(r.overtimeHours || 0),
        hours: +(r.hours || 0),
        hourlyRate: +(r.hourlyRate || 0),
        sessions: +(r.sessions || 0),
        total: +(r.weeklyPay || 0),
        status: 'unpaid',
        createdAt: new Date().toISOString(),
        notes: `Weekly salary invoice #${idx+1} for ${weekStart}`
      };
    });
    const mergedDocs = [
      ...(payrollInvoices || []).filter(x => !(x._type === 'payroll' && x.date === weekStart)),
      ...generatedDocs
    ];
    setPayrollInvoices(mergedDocs);
    save('payrollInvoices', mergedDocs);
    const payrollRows = rows.map(r => ({
      'Week Start': weekStart,
      Username: r.username,
      'Display Name': r.displayName || r.username,
      Hours: +(r.hours || 0),
      'Regular Hours': +(r.regularHours || 0),
      'Overtime Hours': +(r.overtimeHours || 0),
      'Hourly Rate': +(r.hourlyRate || 0),
      'Weekly Salary': +(r.weeklyPay || 0),
      Sessions: +(r.sessions || 0),
      'Open Shift': summary.active?.[r.username] ? 'Yes' : 'No'
    }));
    const docsSummary = [{
      'Week Start': weekStart,
      Employees: rows.length,
      'Total Hours': +rows.reduce((s, r) => s + (+r.hours || 0), 0).toFixed(2),
      'Total Payroll': +rows.reduce((s, r) => s + (+r.weeklyPay || 0), 0).toFixed(2),
      'Generated At': new Date().toLocaleString()
    }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(payrollRows.length ? payrollRows : [{ 'Week Start': weekStart, Username:'', 'Display Name':'', Hours:'', 'Regular Hours':'', 'Overtime Hours':'', 'Hourly Rate':'', 'Weekly Salary':'', Sessions:'', 'Open Shift':'' }]), 'Payroll Register');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(docsSummary), 'Payroll Summary');
    rows.forEach(r => {
      const detail = [{
        Document: 'Weekly Salary Invoice',
        'Week Start': weekStart,
        Username: r.username,
        'Display Name': r.displayName || r.username,
        'Regular Hours': +(r.regularHours || 0),
        'Overtime Hours': +(r.overtimeHours || 0),
        'Hourly Rate': +(r.hourlyRate || 0),
        'Total Hours': +(r.hours || 0),
        'Weekly Salary Due': +(r.weeklyPay || 0),
        Sessions: +(r.sessions || 0),
        'Open Shift': summary.active?.[r.username] ? 'Yes' : 'No'
      }];
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(detail), (`INV-${r.username}`).slice(0, 31));
    });
    XLSX.writeFile(wb, `payroll-pack-${weekStart}.xlsx`);
    logActivity('export_xlsx', 'Exported weekly payroll pack Excel');
    showToast('Weekly salary invoices and employee docs exported.');
  }
  function printSalaryInvoices() {
    const rows = summary.rows || [];
    if (!rows.length) { showToast('No payroll rows to print.', 'error'); return; }
    const html = `
      <div>
        <h2 style="margin:0 0 10px;color:#8B4513;">Weekly Salary Invoices</h2>
        <div style="margin-bottom:12px;color:#555;">Week Start: ${weekStart}</div>
        ${rows.map((r, idx) => `
          <div style="border:1px solid #ddd;border-radius:8px;padding:12px;margin:0 0 10px;">
            <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;">
              <div>
                <div style="font-size:16px;font-weight:700;color:#8B4513;">${r.displayName || r.username}</div>
                <div style="font-size:12px;color:#666;">@${r.username}</div>
              </div>
              <div style="text-align:right;">
                <div style="font-size:12px;color:#666;">Invoice # PAY-${weekStart}-${idx+1}</div>
                <div style="font-size:12px;color:#666;">Generated ${new Date().toLocaleDateString()}</div>
              </div>
            </div>
            <table style="margin-top:10px;width:100%;border-collapse:collapse;">
              <tr><td style="padding:6px;border:1px solid #eee;">Regular Hours</td><td style="padding:6px;border:1px solid #eee;text-align:right;">${r.regularHours || 0}</td></tr>
              <tr><td style="padding:6px;border:1px solid #eee;">Overtime Hours</td><td style="padding:6px;border:1px solid #eee;text-align:right;">${r.overtimeHours || 0}</td></tr>
              <tr><td style="padding:6px;border:1px solid #eee;">Hourly Rate</td><td style="padding:6px;border:1px solid #eee;text-align:right;">${fmt$(r.hourlyRate || 0)}</td></tr>
              <tr><td style="padding:6px;border:1px solid #eee;">Attendance Sessions</td><td style="padding:6px;border:1px solid #eee;text-align:right;">${r.sessions || 0}</td></tr>
              <tr><td style="padding:6px;border:1px solid #eee;font-weight:700;">Weekly Salary Due</td><td style="padding:6px;border:1px solid #eee;text-align:right;font-weight:700;">${fmt$(r.weeklyPay || 0)}</td></tr>
            </table>
          </div>
        `).join('')}
      </div>
    `;
    printHtmlDocument(html, `Weekly Salary Invoices ${weekStart}`);
  }
  useEffect(() => {
    if (!qr?.url) { setQrDataUrl(''); return; }
    QRCode.toDataURL(qr.url, { width: 320, margin: 2, color: { dark: '#000', light: '#fff' } })
      .then(url => setQrDataUrl(url))
      .catch(() => setQrDataUrl(''));
  }, [qr?.url]);

  useEffect(() => {
    if (!isKioskStation) return;
    createQr();
  }, [isKioskStation, currentUser?.username]);

  useEffect(() => {
    if (!isKioskStation || !qr?.expiresAt) return;
    const tick = () => {
      const left = Math.max(0, Math.floor((new Date(qr.expiresAt).getTime() - Date.now()) / 1000));
      setQrCountdown(left);
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [isKioskStation, qr?.expiresAt]);

  useEffect(() => {
    if (!isKioskStation || !qr?.expiresAt) return;
    if (qrCountdown > 5) return;
    createQr();
  }, [isKioskStation, qrCountdown, qr?.expiresAt]);

  if (workGate.loading) {
    return (
      <div className="card">
        <div className="empty-state">Verifying work access…</div>
      </div>
    );
  }
  if (!workGate.ok) {
    return (
      <div className="card" style={{maxWidth:760,margin:'10px auto',border:'1px solid #fecaca',background:'#fff7f7'}}>
        <div style={{fontWeight:800,color:'#991b1b',fontSize:20,marginBottom:8}}>Error: you are not at work!</div>
        <div style={{color:'#7f1d1d',fontSize:13,lineHeight:1.6}}>
          Access to Check In/Out is only allowed from a valid live QR check-in station session.
          <br />
          Details: {workGate.reason || 'Work verification failed.'}
        </div>
      </div>
    );
  }

  if (isKioskStation) {
    return (
      <div className="card" style={{maxWidth:760,margin:'0 auto',textAlign:'center'}}>
        <div className="section-title" style={{marginBottom:6}}>Check-In Kiosk Station</div>
        <div style={{fontSize:13,color:'#666',marginBottom:10}}>QR refreshes automatically. Users scan and check in/out.</div>
        {!qrDataUrl && <div className="empty-state" style={{padding:'24px 12px'}}>Generating secure QR…</div>}
        {qrDataUrl && (
          <div style={{display:'flex',flexDirection:'column',alignItems:'center',gap:12}}>
            <img src={qrDataUrl} alt="Attendance QR" style={{width:320,height:320,border:'1px solid #EED9B0',borderRadius:12,background:'#fff'}} />
            <div style={{fontSize:18,fontWeight:700,color:qrCountdown <= 10 ? '#b91c1c' : '#166534'}}>
              Refreshes in {qrCountdown}s
            </div>
          </div>
        )}
        <div style={{marginTop:12,fontSize:12.5,color:'#7f1d1d',background:'#fff7ed',border:'1px solid #fdba74',borderRadius:8,padding:'8px 10px'}}>
          Kiosk is locked. Logout/login is required to exit this screen.
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex-between mb-3 flex-wrap gap-2">
        <div className="section-title" style={{margin:0}}>Check In / Out</div>
        {isAdmin && <Btn className="btn-outline btn-sm" onClick={onEnterKiosk}>{kioskLock ? 'Kiosk Locked (logout required)' : 'Open Kiosk Station Mode'}</Btn>}
      </div>
      {(!isOnline || backendDown) && <BackendUnavailableBanner code={backendDown ? 'DMG-E021' : 'DMG-E030'} />}

      {/* Session countdown timer for QR-verified staff */}
      {!isAdmin && sessionTimeLeft > 0 && (
        <div style={{
          background: sessionTimeLeft <= 30 ? '#FEF2F2' : sessionTimeLeft <= 60 ? '#FFFBEB' : '#F0FDF4',
          border: `2px solid ${sessionTimeLeft <= 30 ? '#FCA5A5' : sessionTimeLeft <= 60 ? '#FCD34D' : '#86EFAC'}`,
          borderRadius: 10, padding: '10px 14px', marginBottom: 12,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
        }}>
          <div style={{fontSize: 13, fontWeight: 600, color: sessionTimeLeft <= 30 ? '#991b1b' : sessionTimeLeft <= 60 ? '#92400e' : '#166534'}}>
            {sessionTimeLeft <= 30 ? '⚠️ Session expiring!' : '⏱ Session active'}
          </div>
          <div style={{
            fontSize: 22, fontWeight: 800, fontFamily: 'monospace',
            color: sessionTimeLeft <= 30 ? '#DC2626' : sessionTimeLeft <= 60 ? '#D97706' : '#16A34A',
          }}>
            {String(Math.floor(sessionTimeLeft / 60)).padStart(2, '0')}:{String(sessionTimeLeft % 60).padStart(2, '0')}
          </div>
          <div style={{fontSize: 12, color: '#666'}}>Check in or out before time runs out</div>
        </div>
      )}

      <div style={{background:'#E8F4FC',border:'1px solid #B6DBF7',borderRadius:8,padding:'10px 12px',marginBottom:12,fontSize:12.5,color:'#1e4f72'}}>
        {sessionTimeLeft > 0 ? 'QR verified — tap Check In or Check Out.' : 'Scan QR, log in, then tap Check In or Check Out.'}
      </div>
      {!isAdmin && <div className="hint-card">Tip: If a phone is used daily, enable "Remember this device" at login.</div>}
      {err && <div style={{background:'#fee2e2',color:'#991b1b',padding:'8px 12px',borderRadius:6,marginBottom:10,fontSize:12.5}}>{err}</div>}

      <div className="card mb-4">
        <div style={{fontWeight:700,color:'var(--brown)',marginBottom:8}}>My Status</div>
        <div style={{display:'flex',gap:10,flexWrap:'wrap',alignItems:'center'}}>
          {isAdmin
            ? <span style={{fontSize:13,color:'#555'}}>Admins are excluded from attendance tracking.</span>
            : (() => {
                // Show backend status if available; fall back to local cache if backend is down
                if (me) {
                  return <span style={{fontSize:13,color:'#555'}}>Status: <strong style={{color: me.active ? '#15803D' : '#374151'}}>{me.active ? '✅ Currently Checked In' : '⏹ Currently Checked Out'}</strong></span>;
                }
                const lastLocal = localCache.find(e => e.username === currentUser?.username);
                if (lastLocal) {
                  return <span style={{fontSize:13,color:'#888'}}>
                    Last recorded: <strong style={{color: lastLocal.action === 'in' ? '#15803D' : '#374151'}}>
                      {lastLocal.action === 'in' ? '✅ Checked In' : '⏹ Checked Out'}
                    </strong> at {new Date(lastLocal.timestamp).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}
                    <span style={{fontSize:11,marginLeft:6,color:'#aaa'}}>(local record — server unavailable)</span>
                  </span>;
                }
                return <span style={{fontSize:13,color:'#aaa'}}>Status loading…</span>;
              })()}
          {!isAdmin && me && <span style={{fontSize:13,color:'#555'}}>This week: <strong>{me.weekHours || 0} hours</strong></span>}
          {!isAdmin && <span style={{fontSize:13,color: attendanceToken ? '#166534' : '#9a3412'}}>
            {attendanceToken ? 'Work QR verified for this session.' : 'Scan work QR to enable check in/out.'}
          </span>}
        </div>
        {!isAdmin && (
          <div style={{marginTop:10,display:'flex',gap:8,flexWrap:'wrap'}}>
            <Btn className="btn-primary btn-sm" disabled={busy || !attendanceToken} onClick={()=>checkAction('in')}>✅ Check In</Btn>
            <Btn className="btn-outline btn-sm" disabled={busy || !attendanceToken} onClick={()=>checkAction('out')}>⏹ Check Out</Btn>
          </div>
        )}
      </div>

      {isAdmin && (
        <>
          <div className="card mb-4">
            <div className="flex-between mb-2">
              <div style={{fontWeight:700,color:'var(--brown)'}}>Admin QR Station</div>
              <Btn className="btn-primary btn-sm" onClick={createQr}>Generate Fresh QR</Btn>
            </div>
            <div style={{fontSize:12.5,color:'#666',marginBottom:8}}>QR is one-time and short-lived for safer attendance check-in.</div>
            {qr && (
              <div style={{display:'flex',gap:12,alignItems:'center',flexWrap:'wrap'}}>
                <img src={qrDataUrl} alt="Attendance QR" style={{width:220,height:220,border:'1px solid #EED9B0',borderRadius:8,background:'#fff'}} />
                <div style={{maxWidth:460}}>
                  <div style={{fontWeight:700,marginBottom:4}}>Expires:</div>
                  <div style={{fontSize:13,marginBottom:8}}>{qr.expiresAt ? new Date(qr.expiresAt).toLocaleString() : 'Soon'}</div>
                  <div style={{fontWeight:700,marginBottom:4}}>Scan URL:</div>
                  <div style={{fontSize:12,wordBreak:'break-all',background:'#f9f9f9',padding:8,borderRadius:6}}>{qr.url}</div>
                </div>
              </div>
            )}
          </div>

          <div className="card mb-4">
            <div className="flex-between mb-2 flex-wrap gap-2">
              <div style={{fontWeight:700,color:'var(--brown)'}}>Manual Admin Override</div>
              <div style={{display:'flex',gap:8,alignItems:'center'}}>
                <input className="input" placeholder="username" value={targetUser} onChange={e=>setTargetUser(e.target.value)} style={{maxWidth:180}} />
                <Btn className="btn-outline btn-sm" onClick={()=>checkAction('in', targetUser)}>Check In User</Btn>
                <Btn className="btn-outline btn-sm" onClick={()=>checkAction('out', targetUser)}>Check Out User</Btn>
              </div>
            </div>
            <div style={{fontSize:12.5,color:'#666'}}>Admins can check users in/out if needed (audited in backend records).</div>
          </div>

          <div className="card">
            <div className="flex-between mb-2 flex-wrap gap-2">
              <div style={{fontWeight:700,color:'var(--brown)'}}>Weekly Payroll</div>
              <div style={{display:'flex',gap:8}}>
                <input className="input" type="date" value={weekStart} onChange={e=>setWeekStart(e.target.value)} />
                <Btn className="btn-outline btn-sm" onClick={loadSummary}>Refresh</Btn>
                <Btn className="btn-success btn-sm" onClick={exportPayrollCsv}>Export CSV</Btn>
                <Btn className="btn-success btn-sm" onClick={exportPayrollPackExcel}>Export Payroll Pack</Btn>
                <Btn className="btn-outline btn-sm" onClick={printSalaryInvoices}>Print Salary Invoices</Btn>
              </div>
            </div>
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>User</th><th>Hours</th><th>Regular</th><th>OT</th><th>Rate</th><th>Weekly Pay</th><th>Open Shift</th><th>Actions</th></tr></thead>
                <tbody>
                  {(summary.rows || []).map(r => (
                    <tr key={r.username}>
                      <td>{r.displayName || r.username} <span style={{fontSize:11,color:'#777'}}>@{r.username}</span></td>
                      <td>{r.hours}</td>
                      <td>{r.regularHours}</td>
                      <td>{r.overtimeHours}</td>
                      <td style={{minWidth:130}}>
                        <div style={{display:'flex',gap:6,alignItems:'center'}}>
                          <input className="input" type="number" min="0" step="0.01" style={{maxWidth:80}} value={rateDrafts[r.username] ?? r.hourlyRate ?? 0}
                            onChange={e=>setRateDrafts(prev=>({ ...prev, [r.username]: e.target.value }))} />
                          <Btn className="btn-outline btn-sm" onClick={()=>saveRate(r.username)}>Save</Btn>
                        </div>
                      </td>
                      <td style={{fontWeight:700}}>{fmt$(r.weeklyPay)}</td>
                      <td>{summary.active?.[r.username] ? <span className="badge badge-admin">In</span> : '—'}</td>
                      <td>{summary.active?.[r.username] && <Btn className="btn-danger btn-sm" onClick={()=>forceOut(r.username)}>Force Out</Btn>}</td>
                    </tr>
                  ))}
                  {!(summary.rows || []).length && <tr><td colSpan={8}><div className="empty-state">No attendance sessions for this week yet.</div></td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          {/* Local attendance cache — visible even when backend is offline */}
          <div className="card mt-4">
            <button
              style={{width:'100%',background:'none',border:'none',cursor:'pointer',display:'flex',justifyContent:'space-between',alignItems:'center',fontWeight:700,color:'var(--brown)',fontSize:14,padding:0,marginBottom: showLocalCache ? 12 : 0}}
              onClick={() => setShowLocalCache(v => !v)}
            >
              <span>📋 Recent Attendance Log ({localCache.length} local records)</span>
              <span>{showLocalCache ? '▲' : '▼'}</span>
            </button>
            {showLocalCache && (
              <>
                <div style={{fontSize:12,color:'#888',marginBottom:10}}>
                  Saved on this device when staff check in/out. Persists across sessions. Complements the backend weekly summary above.
                  <button style={{marginLeft:12,fontSize:12,color:'#DC2626',background:'none',border:'none',cursor:'pointer',padding:0}} onClick={() => {
                    if (window.confirm('Clear all local attendance records on this device?')) {
                      setLocalCache([]); save('_attendanceCache', []);
                    }
                  }}>🗑 Clear all</button>
                </div>
                {localCache.length === 0 ? (
                  <div style={{color:'#aaa',fontSize:13,textAlign:'center',padding:'12px 0'}}>No local records yet. Records appear here when staff check in or out.</div>
                ) : (
                  <div className="tbl-wrap">
                    <table>
                      <thead><tr><th>Time</th><th>Employee</th><th>Action</th><th>Business</th><th>By Admin</th></tr></thead>
                      <tbody>
                        {localCache.slice(0, 100).map((e, i) => (
                          <tr key={e.id || i}>
                            <td style={{whiteSpace:'nowrap',fontSize:12}}>{new Date(e.timestamp).toLocaleString()}</td>
                            <td style={{fontWeight:600}}>{e.displayName} {e.username !== e.displayName && <span style={{fontSize:11,color:'#888'}}>@{e.username}</span>}</td>
                            <td>
                              <span style={{padding:'2px 10px',borderRadius:10,fontSize:12,fontWeight:600,background:e.action==='in'?'#DCFCE7':'#FEE2E2',color:e.action==='in'?'#15803D':'#DC2626'}}>
                                {e.action === 'in' ? 'Checked In' : 'Checked Out'}
                              </span>
                            </td>
                            <td style={{fontSize:12,color:'#555'}}>{e.business || '—'}</td>
                            <td style={{fontSize:12,color:e.byAdmin?'#7C3AED':'#aaa'}}>{e.byAdmin ? '✓ Admin' : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

