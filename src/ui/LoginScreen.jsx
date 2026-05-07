import React, { useState, useEffect, useMemo } from 'react';
import { load, save } from '../utils/storage.js';
import { OfflineBanner, BrowserCapsBanner } from '../ReliabilityBanners.jsx';
import { resolveAssetUrl } from '../formatters.js';
import { documentBaseHref } from '../utils/print.js';
import {
  hashPwd,
  logFailure,
  loadAdminResetApiBase,
  parseAttendanceParams,
  getAuthStatus,
  loginViaBackend,
  syncCredentialsToBackend,
  mergeBrandingWithOverrides,
  requestAdminResetEmail,
  downloadFailureLog,
  pushAuditEvent,
} from '../authHelpers.js';
import {
  userMessageForCode,
} from '../apiErrors.js';
import {
  DEFAULT_USER_PERMS,
  LOGO_OVERRIDES_KEY,
  BIZ_CONTACT_KEY,
  ADMIN_RESET_CODE_KEY,
} from '../constants.js';
import FirstRunSetup from './FirstRunSetup.jsx';

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

export default function LoginScreen({ onLogin, bootWarnings, online }) {
  const [needsSetup, setNeedsSetup] = useState(() => load('credentials', null) === null);
  const [checkingSetup, setCheckingSetup] = useState(true);
  const [authApiBase, setAuthApiBase] = useState(() => loadAdminResetApiBase());
  const [useCentralAuth, setUseCentralAuth] = useState(false);
  const [uname, setUname] = useState('');
  const [pwd, setPwd] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [showForgot, setShowForgot] = useState(false);
  const [showQuickReset, setShowQuickReset] = useState(false);
  const [resetCode, setResetCode] = useState('');
  const [resetPwd, setResetPwd] = useState('');
  const [resetPwdC, setResetPwdC] = useState('');
  const [resetMsg, setResetMsg] = useState('');
  const [resetErr, setResetErr] = useState('');
  const [rememberDevice, setRememberDevice] = useState(() => !!parseAttendanceParams());
  const attParams = useMemo(() => parseAttendanceParams(), []);
  const loginBranding = useMemo(() => mergeBrandingWithOverrides(load(LOGO_OVERRIDES_KEY, {}), load(BIZ_CONTACT_KEY, {})), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const st = await getAuthStatus(authApiBase);
      if (cancelled) return;
      if (st.ok && st.hasUsers) {
        setNeedsSetup(false);
        setUseCentralAuth(true);
        if (st.base) setAuthApiBase(st.base);
        setCheckingSetup(false);
        return;
      }
      const localCreds = load('credentials', null);
      if (localCreds && Object.keys(localCreds).length) {
        if (!cancelled) {
          setNeedsSetup(false);
          setUseCentralAuth(false);
          setCheckingSetup(false);
        }
        return;
      }
      setNeedsSetup(true);
      setUseCentralAuth(false);
      setCheckingSetup(false);
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!attParams) return;
    const remembered = load('_rememberedCheckinLogin', null);
    if (!remembered?.username || !remembered?.authHash) return;
    setUname(String(remembered.username || ''));
    setLoading(true);
    loginViaBackend(String(remembered.username || ''), String(remembered.authHash || ''), authApiBase).then(remote => {
      if (!remote.ok || !remote.user) { setLoading(false); return; }
      onLogin({
        username: remote.user.username,
        role: remote.user.role,
        name: remote.user.displayName,
        permissions: remote.user.permissions || DEFAULT_USER_PERMS,
        authHash: String(remembered.authHash || '')
      });
    }).catch(() => setLoading(false));
  }, []);

  if (checkingSetup) {
    return (
      <div className="login-screen">
        <div className="login-card">
          <OfflineBanner online={online} />
          <BrowserCapsBanner warnings={bootWarnings} />
          <div className="text-center" style={{color:'#777'}}>Checking account setup...</div>
        </div>
      </div>
    );
  }
  if (needsSetup) return <FirstRunSetup apiBase={authApiBase} onDone={() => setNeedsSetup(false)} />;

  async function handleLogin(e) {
    e.preventDefault();
    setErr('');
    try {
      if (!globalThis.crypto?.subtle) {
        const wc = bootWarnings.find((m) => m.message.includes('Password hashing'));
        setErr(wc?.message || 'Cannot sign in: Web Crypto is not available (DMG-E050/E051).');
        return;
      }
      const creds = load('credentials', null);
      const key = uname.trim().toLowerCase();
      setLoading(true);
      if (!useCentralAuth && creds && creds[key]) {
        const saltedHash = await hashPwd(pwd, key);
        const legacyHash  = await hashPwd(pwd);
        const stored = creds[key].password;
        let activeHash = null;
        if (stored === saltedHash) {
          activeHash = saltedHash;
        } else if (stored === legacyHash) {
          // Legacy no-salt hash matched — upgrade silently to salted hash
          const upgraded = { ...creds, [key]: { ...creds[key], password: saltedHash } };
          save('credentials', upgraded);
          activeHash = saltedHash;
        }
        if (!activeHash) { setLoading(false); setErr('Invalid username or password.'); return; }
        if (rememberDevice) save('_rememberedCheckinLogin', { username: key, authHash: activeHash });
        else save('_rememberedCheckinLogin', null);
        setTimeout(() => {
          onLogin({ username: key, role: creds[key].role || (key === 'admin' ? 'admin' : 'user'),
            name: creds[key].displayName || (key === 'admin' ? 'Administrator' : key), permissions: creds[key].permissions || DEFAULT_USER_PERMS, authHash: activeHash });
        }, 400);
        return;
      }
      const hash = await hashPwd(pwd, key);
      const remote = await loginViaBackend(key, hash, authApiBase);
      if (!remote.ok || !remote.user) {
        setLoading(false);
        if (useCentralAuth && remote.code && remote.code !== 'DMG-E020') {
          setErr(userMessageForCode(remote.code, remote.error));
        } else {
          setErr('Invalid username or password.');
        }
        return;
      }
      if (rememberDevice) save('_rememberedCheckinLogin', { username: remote.user.username, authHash: hash });
      else save('_rememberedCheckinLogin', null);
      setTimeout(() => {
        onLogin({ username: remote.user.username, role: remote.user.role, name: remote.user.displayName, permissions: remote.user.permissions || DEFAULT_USER_PERMS, authHash: hash });
      }, 400);
    } catch (e2) {
      logFailure({ area:'login', action:'handle_login_exception', error:e2 });
      setLoading(false);
      setErr('Login failed unexpectedly. Please try again.');
    }
  }

  async function handleQuickAdminReset(e) {
    e.preventDefault();
    setResetErr('');
    setResetMsg('');
    const codeHash = load(ADMIN_RESET_CODE_KEY, '');
    if (!codeHash) { setResetErr('Reset is not configured yet. Ask manager to set Reset Code in Settings.'); return; }
    if (!globalThis.crypto?.subtle) {
      const wc = bootWarnings.find((m) => m.message.includes('Password hashing'));
      setResetErr(wc?.message || 'Cannot reset: Web Crypto is not available (DMG-E050/E051).');
      return;
    }
    if (!resetCode) { setResetErr('Enter Reset Code.'); return; }
    if (resetPwd.length < 6) { setResetErr('New password must be at least 6 characters.'); return; }
    if (resetPwd !== resetPwdC) { setResetErr('Passwords do not match.'); return; }
    const enteredHash = await hashPwd(resetCode);
    if (enteredHash !== codeHash) { setResetErr('Invalid Reset Code.'); return; }
    const creds = load('credentials', {});
    if (!creds.admin) creds.admin = { role:'admin', displayName:'Administrator', password:'' };
    creds.admin.password = await hashPwd(resetPwd);
    save('credentials', creds);
    const syncResult = await syncCredentialsToBackend(creds, authApiBase);
    if (!syncResult.ok) {
      logFailure({ area:'login', action:'quick_admin_reset_sync', error:syncResult.error });
    }
    pushAuditEvent('admin_password_reset', 'Quick reset completed from login screen');
    setResetCode('');
    setResetPwd('');
    setResetPwdC('');
    setResetMsg('Admin password reset complete. You can now sign in with the new password.');
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <OfflineBanner online={online} />
        <BrowserCapsBanner warnings={bootWarnings} />
        <div className="login-logo">
          <div className="login-brand-row">
            <img className="login-brand-logo" src={resolveAssetUrl(loginBranding.degrill.logo, documentBaseHref())} alt="DeGrill logo" />
            <img className="login-brand-logo" src={resolveAssetUrl(loginBranding.parathas.logo, documentBaseHref())} alt="Parathas and Platters logo" />
            <img className="login-brand-logo" src={resolveAssetUrl(loginBranding.dera.logo, documentBaseHref())} alt="Dera Masala Grill logo" />
          </div>
          <h1>DMG Software Suite</h1>
          <p>DeGrill · Parathas &amp; Platters · Dera Masala Grill</p>
        </div>
        <div style={{background:'#FFF8DC',border:'1px solid #DEB887',borderRadius:8,padding:'9px 12px',marginBottom:14,fontSize:12.5,color:'#7a5c00'}}>
          Tip: Enter the username/password provided by your admin. Most devices will go straight to login. Starter-file import only appears when no central accounts are available yet.
        </div>

        <form onSubmit={handleLogin}>
          <div className="field">
            <label>Username</label>
            <input className="input" placeholder="Enter your username" value={uname} onChange={e=>{setUname(e.target.value);setErr('');}} autoFocus autoCapitalize="none" autoCorrect="off" />
          </div>
          <div className="field">
            <label>Password</label>
            <input className="input" type="password" placeholder="Enter password" value={pwd} onChange={e=>{setPwd(e.target.value);setErr('');}} />
          </div>
          <label style={{display:'flex',gap:8,alignItems:'center',fontSize:12.5,color:'#6b4b20',marginBottom:10}}>
            <input type="checkbox" checked={rememberDevice} onChange={e=>setRememberDevice(e.target.checked)} />
            Remember this device for faster Check In/Out login
          </label>
          {err && <div style={{background:'#fee2e2',color:'#991b1b',padding:'8px 12px',borderRadius:5,marginBottom:12,fontSize:13}}>{err}</div>}
          <button type="submit" className="btn btn-primary" style={{width:'100%',padding:'10px',fontSize:15,marginTop:4}} disabled={loading}>
            {loading ? 'Signing in…' : '🔐 Sign In'}
          </button>
        </form>

        <button type="button" onClick={()=>setShowForgot(f=>!f)} style={{background:'none',border:'none',color:'var(--brown)',fontSize:13,cursor:'pointer',textDecoration:'underline',display:'block',textAlign:'center',marginTop:12,width:'100%'}}>
          Forgot your password?
        </button>
        {showForgot && (
          <div style={{background:'#FFF8DC',borderRadius:8,padding:'14px 16px',marginTop:8,border:'1px solid #DEB887',fontSize:13,lineHeight:1.8}}>
            <div>🔐 <strong>Admin password:</strong> To reset, email{' '}
              <a href="mailto:fatimfarooq@yahoo.com" style={{color:'var(--brown)',fontWeight:700}}>fatimfarooq@yahoo.com</a>
            </div>
            <Btn className="btn-outline btn-sm" style={{marginTop:8}} onClick={()=>requestAdminResetEmail('login_forgot_password')}>
              ✉️ Send Admin Password Reset Request
            </Btn>
            <Btn className="btn-outline btn-sm" style={{marginTop:8,marginLeft:8}} onClick={()=>setShowQuickReset(v=>!v)}>
              🔐 Quick Admin Reset
            </Btn>
            <div>👤 <strong>Staff password:</strong> Ask your admin — they can reset it from the ⚙ Settings panel once logged in.</div>
            <Btn className="btn-outline btn-sm" style={{marginTop:8,marginLeft:8}} onClick={downloadFailureLog}>
              ⬇ Download Failure Log
            </Btn>
            {showQuickReset && (
              <form onSubmit={handleQuickAdminReset} style={{marginTop:10,paddingTop:10,borderTop:'1px solid #E7CFA6'}}>
                <FI label="Reset Code" type="password" value={resetCode} onChange={e=>{setResetCode(e.target.value);setResetErr('');}} placeholder="Manager reset code" />
                <FI label="New Admin Password" type="password" value={resetPwd} onChange={e=>{setResetPwd(e.target.value);setResetErr('');}} placeholder="Min 6 characters" />
                <FI label="Confirm New Password" type="password" value={resetPwdC} onChange={e=>{setResetPwdC(e.target.value);setResetErr('');}} placeholder="Re-enter password" />
                {resetErr && <div style={{background:'#fee2e2',color:'#991b1b',padding:'8px 12px',borderRadius:5,marginBottom:10,fontSize:12.5}}>{resetErr}</div>}
                {resetMsg && <div style={{background:'#dcfce7',color:'#166534',padding:'8px 12px',borderRadius:5,marginBottom:10,fontSize:12.5}}>{resetMsg}</div>}
                <button type="submit" className="btn btn-primary btn-sm">Save New Admin Password</button>
              </form>
            )}
          </div>
        )}

      </div>
    </div>
  );
}
