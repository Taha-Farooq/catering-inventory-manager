import React, { useState, useEffect, useMemo, useRef } from 'react';
import JSZip from 'jszip';
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
  // needsSetup = true only when backend is unreachable AND no local credentials exist
  const [needsSetup, setNeedsSetup] = useState(() => load('credentials', null) === null);
  const [checkingSetup, setCheckingSetup] = useState(true);
  const [serverRetrying, setServerRetrying] = useState(false);
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

  // Starter file upload (admin bootstrap)
  const [showStarter, setShowStarter] = useState(false);
  const [starterMsg, setStarterMsg] = useState('');
  const [starterErr, setStarterErr] = useState('');
  const [starterLoading, setStarterLoading] = useState(false);
  const starterRef = useRef();

  const attParams = useMemo(() => parseAttendanceParams(), []);
  const loginBranding = useMemo(() => mergeBrandingWithOverrides(load(LOGO_OVERRIDES_KEY, {}), load(BIZ_CONTACT_KEY, {})), []);

  useEffect(() => {
    let cancelled = false;
    let retryTimer = null;

    async function checkBackend() {
      const st = await getAuthStatus(authApiBase);
      if (cancelled) return;
      if (st.ok) {
        setNeedsSetup(false);
        setUseCentralAuth(!!st.hasUsers);
        if (st.base) setAuthApiBase(st.base);
        setCheckingSetup(false);
        setServerRetrying(false);
        return true;
      }
      return false;
    }

    (async () => {
      const ok = await checkBackend();
      if (cancelled) return;
      if (ok) return;

      // Backend unavailable — fall back to local credentials
      const localCreds = load('credentials', null);
      if (localCreds && Object.keys(localCreds).length) {
        setNeedsSetup(false);
        setUseCentralAuth(false);
        setCheckingSetup(false);
        return;
      }

      // No local creds either — show form but keep retrying backend in background
      // so admins on new devices connect once the server wakes (Render cold start)
      setNeedsSetup(true);
      setUseCentralAuth(false);
      setCheckingSetup(false);
      setServerRetrying(true);

      const retry = async () => {
        if (cancelled) return;
        const ok2 = await checkBackend();
        if (!cancelled && !ok2) {
          retryTimer = setTimeout(retry, 8000);
        }
      };
      retryTimer = setTimeout(retry, 8000);
    })();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
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

  async function importStarter(file) {
    if (!file) return;
    setStarterErr('');
    setStarterMsg('');
    setStarterLoading(true);
    try {
      const zip = await JSZip.loadAsync(file);
      const keys = ['items','shoppingList','purchaseInvoices','cateringInvoices',
                    'customers','priceHistory','settings','credentials',
                    '_profiles','_adminPasswordHash','_userPermissions'];
      let loadedCredentials = false;
      for (const k of keys) {
        const f = zip.file(k + '.json');
        if (!f) continue;
        const v = JSON.parse(await f.async('string'));
        if (k === 'settings' && v && v.selectedBusiness) save('_lastBiz', v.selectedBusiness);
        else save(k, v);
        if (k === 'credentials' && v && typeof v === 'object' && Object.keys(v).length > 0) loadedCredentials = true;
      }
      setStarterLoading(false);
      if (loadedCredentials) {
        const creds = load('credentials', {});
        const syncResult = await syncCredentialsToBackend(creds, authApiBase);
        if (!syncResult.ok) {
          logFailure({ area:'setup', action:'sync_credentials_backend', error:syncResult.error });
        }
        setStarterMsg('Starter file imported! You can now sign in.');
        setNeedsSetup(false);
      } else {
        setStarterErr('This file is missing login accounts. Ask your admin for a valid backup ZIP.');
      }
    } catch (e) {
      setStarterLoading(false);
      setStarterErr('Import failed — use a valid app backup ZIP file.');
    }
  }

  if (checkingSetup) {
    return (
      <div className="login-screen">
        <div className="login-card">
          <OfflineBanner online={online} />
          <BrowserCapsBanner warnings={bootWarnings} />
          <div className="text-center" style={{color:'#777'}}>Connecting to server…</div>
          <div className="text-center" style={{fontSize:12,color:'#aaa',marginTop:6}}>
            This may take a moment on first load.
          </div>
        </div>
      </div>
    );
  }

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
      const saltedHash = await hashPwd(pwd, key);
      const legacyHash  = await hashPwd(pwd);

      // Try local credentials first when available
      if (!useCentralAuth && creds && creds[key]) {
        const stored = creds[key].password;
        let activeHash = null;
        if (stored === saltedHash) {
          activeHash = saltedHash;
        } else if (stored === legacyHash) {
          // Legacy unsalted hash matched — upgrade stored hash and sync to backend
          const upgraded = { ...creds, [key]: { ...creds[key], password: saltedHash } };
          save('credentials', upgraded);
          syncCredentialsToBackend(upgraded, authApiBase).catch(() => {});
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

      // Backend login — try salted hash first, then legacy as fallback.
      // The backend may store the legacy unsalted hash if credentials were synced
      // before the salted-hash migration; trying both prevents lockout.
      let remote = await loginViaBackend(key, saltedHash, authApiBase);
      let activeHash = saltedHash;
      if (!remote.ok && remote.code === 'DMG-E020') {
        // Auth failure (not network) — try legacy unsalted hash
        const legacyRemote = await loginViaBackend(key, legacyHash, authApiBase);
        if (legacyRemote.ok && legacyRemote.user) {
          remote = legacyRemote;
          activeHash = legacyHash;
          // Upgrade backend to salted hash immediately
          const freshCreds = load('credentials', {});
          freshCreds[key] = { ...(freshCreds[key] || {}), password: saltedHash };
          save('credentials', freshCreds);
          syncCredentialsToBackend(freshCreds, authApiBase).catch(() => {});
        }
      }
      if (!remote.ok || !remote.user) {
        setLoading(false);
        if (remote.code && remote.code !== 'DMG-E020' && remote.code !== 'DMG-E021') {
          setErr(userMessageForCode(remote.code, remote.error));
        } else if (remote.code === 'DMG-E021') {
          setErr('Cannot reach server. Check your internet connection and try again.');
        } else {
          setErr('Invalid username or password.');
        }
        return;
      }
      // Backend responded — update auth state for future actions
      if (!useCentralAuth) { setUseCentralAuth(true); setNeedsSetup(false); setServerRetrying(false); }
      if (rememberDevice) save('_rememberedCheckinLogin', { username: remote.user.username, authHash: activeHash });
      else save('_rememberedCheckinLogin', null);
      setTimeout(() => {
        onLogin({ username: remote.user.username, role: remote.user.role, name: remote.user.displayName, permissions: remote.user.permissions || DEFAULT_USER_PERMS, authHash: activeHash });
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

        {needsSetup && (
          <div style={{background: serverRetrying ? '#EFF6FF' : '#FFF8DC', border:`1px solid ${serverRetrying ? '#BFDBFE' : '#DEB887'}`,borderRadius:8,padding:'9px 12px',marginBottom:14,fontSize:12.5,color: serverRetrying ? '#1e40af' : '#7a5c00',display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
            <span style={{flex:1}}>
              {serverRetrying
                ? '🔄 Server is starting up (this can take ~30 seconds). You can try signing in now — it may work already.'
                : '⚠️ Server unreachable. If you have credentials, try signing in anyway — or upload a starter file below.'}
            </span>
            <button type="button" onClick={async () => {
              setServerRetrying(true);
              const st = await getAuthStatus(authApiBase);
              if (st.ok) {
                setNeedsSetup(false);
                setUseCentralAuth(!!st.hasUsers);
                if (st.base) setAuthApiBase(st.base);
                setServerRetrying(false);
              } else {
                setServerRetrying(false);
              }
            }} style={{background:'none',border:'1px solid currentColor',borderRadius:5,padding:'2px 8px',fontSize:11.5,cursor:'pointer',whiteSpace:'nowrap'}}>
              Retry
            </button>
          </div>
        )}

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

        {/* Starter file — small admin-only bootstrap link, always accessible */}
        <div style={{marginTop:18,borderTop:'1px solid #F0E0C8',paddingTop:12,textAlign:'center'}}>
          <button type="button" onClick={()=>setShowStarter(v=>!v)}
            style={{background:'none',border:'none',color:'#aaa',fontSize:11.5,cursor:'pointer',textDecoration:'underline'}}>
            {showStarter ? '▲ Hide setup' : 'Upload starter file (admin setup)'}
          </button>
          {showStarter && (
            <div style={{marginTop:10,textAlign:'left',background:'#F9F4EE',border:'1px solid #E7CFA6',borderRadius:8,padding:'12px 14px'}}>
              <div style={{fontSize:13,color:'#5a3e00',marginBottom:8}}>
                Import a backup ZIP from your admin to initialize this device with all accounts and data.
              </div>
              <input ref={starterRef} type="file" accept=".zip" style={{display:'none'}}
                onChange={e=>{importStarter(e.target.files[0]);e.target.value='';}} />
              <Btn className="btn-outline btn-sm" disabled={starterLoading} onClick={()=>starterRef.current?.click()}>
                {starterLoading ? 'Importing…' : '⬆ Choose Backup / Starter ZIP'}
              </Btn>
              {starterMsg && <div style={{background:'#dcfce7',color:'#166534',padding:'7px 10px',borderRadius:5,marginTop:8,fontSize:13}}>{starterMsg}</div>}
              {starterErr && <div style={{background:'#fee2e2',color:'#991b1b',padding:'7px 10px',borderRadius:5,marginTop:8,fontSize:13}}>{starterErr}</div>}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
