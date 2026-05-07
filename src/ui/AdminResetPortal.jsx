import React, { useState, useEffect, useMemo } from 'react';
import { load, save } from '../utils/storage.js';
import {
  hashPwd,
  logFailure,
  loadAdminResetApiBase,
  resolveResetApiBase,
  parseAdminResetParams,
  pushAuditEvent,
} from '../authHelpers.js';
import { ADMIN_RESET_QUERY_KEY } from '../constants.js';

function FI({ label, suggestions, fieldStyle, ...props }) {
  const baseFieldStyle = label ? {} : { marginBottom: 0 };
  return (
    <div className="field" style={{ ...baseFieldStyle, ...fieldStyle }}>
      {label&&<label>{label}</label>}
      <input className="input" {...props} />
    </div>
  );
}
function Btn({ className='', children, ...p }) {
  return <button className={`btn ${className}`} {...p}>{children}</button>;
}

export default function AdminResetPortal() {
  const access = useMemo(() => parseAdminResetParams(), []);
  const [apiBase, setApiBase] = useState(() => loadAdminResetApiBase());
  const [pwd, setPwd] = useState('');
  const [confirm, setConfirm] = useState('');
  const [approver, setApprover] = useState('');
  const [authorized, setAuthorized] = useState(false);
  const [status, setStatus] = useState('checking');
  const [meta, setMeta] = useState(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!access) { setStatus('invalid'); return; }
    setStatus('checking');
    resolveResetApiBase(apiBase).then(async resolved => {
      if (!resolved.ok) throw new Error('Reset service is unavailable. Please contact support.');
      setApiBase(resolved.base);
      const r = await fetch(`${resolved.base}/api/admin-reset/validate`, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ token: access.token, requestId: access.requestId })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.valid) throw new Error(data.error || 'Reset link validation failed.');
      setMeta(data);
      setStatus('valid');
    }).catch(e => {
      logFailure({ area:'admin_reset_portal', action:'validate_link', error:e, extra:{ apiBase } });
      setErr(String(e.message || e));
      setStatus('invalid');
    });
  }, [access?.token, access?.requestId]);

  async function handleReset(e) {
    e.preventDefault();
    setErr('');
    setMsg('');
    if (!access || status !== 'valid') { setErr('Reset link is invalid or expired. Request a new one.'); return; }
    if (!authorized) { setErr('Please confirm this reset is authorized.'); return; }
    if (!approver.trim()) { setErr('Enter approver name for audit logging.'); return; }
    if (pwd.length < 6) { setErr('Password must be at least 6 characters.'); return; }
    if (pwd !== confirm) { setErr('Passwords do not match.'); return; }
    setSaving(true);
    const newPasswordHash = await hashPwd(pwd);
    const resolved = await resolveResetApiBase(apiBase);
    if (!resolved.ok) {
      setSaving(false);
      setErr('Reset service is unavailable. Please try again later.');
      logFailure({ area:'admin_reset_portal', action:'complete_reset_precheck', error:'service unavailable', extra:{ apiBase } });
      return;
    }
    setApiBase(resolved.base);
    const r = await fetch(`${resolved.base}/api/admin-reset/complete`, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        token: access.token,
        requestId: access.requestId,
        approver: approver.trim(),
        newPasswordHash
      })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) {
      setSaving(false);
      setErr(data.error || 'Reset failed.');
      logFailure({ area:'admin_reset_portal', action:'complete_reset_api', error:data.error || `HTTP ${r.status}`, extra:{ requestId: access.requestId, apiBase: resolved.base } });
      return;
    }
    const creds = load('credentials', {});
    if (!creds.admin) creds.admin = { role: 'admin', displayName: 'Administrator', password: '' };
    creds.admin.password = newPasswordHash;
    save('credentials', creds);
    pushAuditEvent('admin_password_reset', `Completed ${access.requestId} by ${approver.trim()} (${data.auditId || 'no-audit'})`);
    setPwd('');
    setConfirm('');
    setApprover('');
    setAuthorized(false);
    setSaving(false);
    setMsg('Admin password has been reset successfully.');
  }

  function closePortal() {
    const clean = new URL(window.location.href);
    clean.searchParams.delete(ADMIN_RESET_QUERY_KEY);
    window.location.href = clean.toString();
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-logo">
          <div className="icon">🔐</div>
          <h1>Private Admin Reset</h1>
          <p>Use this page only for approved admin password resets.</p>
        </div>
        <div style={{background:'#FFF8DC',border:'1px solid #DEB887',borderRadius:8,padding:'10px 14px',marginBottom:14,fontSize:13,color:'#7a5c00'}}>
          This reset portal is hidden from normal navigation and requires backend validation.
        </div>
        <div style={{fontSize:12,color:'#777',marginBottom:10}}>
          Reset service: <code>{apiBase}</code>
        </div>
        {!access || status === 'invalid' ? (
          <div style={{background:'#fee2e2',color:'#991b1b',padding:'8px 12px',borderRadius:5,marginBottom:12,fontSize:13}}>
            {err || 'Reset link is missing, invalid, expired, or backend is unavailable.'}
          </div>
        ) : null}
        {access && status === 'checking' && (
          <div style={{background:'#E8F4FC',border:'1px solid #B6DBF7',borderRadius:8,padding:'10px 12px',marginBottom:12,fontSize:12.5,color:'#1e4f72'}}>
            Validating reset link with secure backend...
          </div>
        )}
        {access && status === 'valid' && (
          <div style={{background:'#E8F4FC',border:'1px solid #B6DBF7',borderRadius:8,padding:'10px 12px',marginBottom:12,fontSize:12.5,color:'#1e4f72',lineHeight:1.6}}>
            <div><strong>Request ID:</strong> {meta?.requestId || access.requestId}</div>
            <div><strong>Source:</strong> {meta?.source || 'app'}</div>
            <div><strong>Expires:</strong> {meta?.expiresAt ? new Date(meta.expiresAt).toLocaleString() : 'n/a'}</div>
          </div>
        )}
        <form onSubmit={handleReset}>
          <FI label="Approver Name" value={approver} onChange={e=>{setApprover(e.target.value);setErr('');}} placeholder="e.g. Saba" />
          <FI label="New Admin Password" type="password" value={pwd} onChange={e=>{setPwd(e.target.value);setErr('');}} placeholder="Min 6 characters" />
          <FI label="Confirm New Password" type="password" value={confirm} onChange={e=>{setConfirm(e.target.value);setErr('');}} placeholder="Re-enter password" />
          <label style={{display:'flex',alignItems:'center',gap:8,fontSize:12.5,color:'#5a3010',marginBottom:10}}>
            <input type="checkbox" checked={authorized} onChange={e=>{setAuthorized(e.target.checked);setErr('');}} />
            I confirm this reset is approved by management.
          </label>
          {err && status === 'valid' && <div style={{background:'#fee2e2',color:'#991b1b',padding:'8px 12px',borderRadius:5,marginBottom:12,fontSize:13}}>{err}</div>}
          {msg && <div style={{background:'#dcfce7',color:'#166534',padding:'8px 12px',borderRadius:5,marginBottom:12,fontSize:13}}>{msg}</div>}
          <button type="submit" className="btn btn-primary" style={{width:'100%',padding:'10px',fontSize:15}} disabled={saving || !access || status !== 'valid'}>
            {saving ? 'Saving…' : '💾 Reset Admin Password'}
          </button>
        </form>
        <Btn className="btn-outline" style={{width:'100%',marginTop:10}} onClick={closePortal}>Back to Login</Btn>
      </div>
    </div>
  );
}
