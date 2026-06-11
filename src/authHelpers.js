/**
 * authHelpers.js — shared module-level helpers used by login, admin-reset, and settings components.
 *
 * Extracted from App.jsx as part of Epic C (BL-07) component extraction.
 * No behaviour changes — function bodies are copied verbatim from App.jsx.
 */

import { load, save, uid, today } from './utils/storage.js';
import { reportError } from './errors.js';
import { showToast } from './toastContext.jsx';
import { getBootCapabilityWarnings } from './browserCaps.js';
import {
  classifyFetchException,
  classifyHttpStatus,
  mergeApiFailure,
  userMessageForCode,
} from './apiErrors.js';
import {
  normalizeApiBase,
  parseUrlSafe,
  isLoopbackHost,
  trimText,
  normalizeLogoOverrides,
} from './formatters.js';
import {
  ADMIN_RESET_QUERY_KEY,
  ADMIN_RESET_REQ_KEY,
  ADMIN_RESET_EMAIL,
  ADMIN_RESET_API_BASE,
  ADMIN_RESET_API_ENDPOINTS,
  ADMIN_RESET_API_BASE_KEY,
  CENTRAL_AUTH_CONFIG_PATH,
  FAILURE_LOG_KEY,
  ATT_QR_QUERY_KEY,
  LOGO_OVERRIDES_KEY,
  BIZ_CONTACT_KEY,
} from './constants.js';

// username is used as a deterministic salt (see BL-19 / AGENTS.md password-hashing section).
// Legacy callers pass no username → unsalted SHA-256 for backward-compat transition.
export async function hashPwd(pwd, username = '') {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Web Crypto is not available (DMG-E050/E051)');
  }
  const input = username ? `${pwd}:${username.toLowerCase()}` : pwd;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2,'0')).join('');
}

export const parseAdminResetParams = () => {
  try {
    const q = new URLSearchParams(window.location.search);
    const token = q.get(ADMIN_RESET_QUERY_KEY) || '';
    const requestId = q.get(ADMIN_RESET_REQ_KEY) || '';
    if (!token || !requestId) return null;
    return { token, requestId };
  } catch {
    return null;
  }
};

export const parseAttendanceParams = () => {
  try {
    const q = new URLSearchParams(window.location.search);
    const token = q.get(ATT_QR_QUERY_KEY) || '';
    const mode = q.get('attMode') === '1';
    if (!mode || !token) return null;
    return { token };
  } catch {
    return null;
  }
};

export const loadAdminResetApiBase = () => {
  const saved = load(ADMIN_RESET_API_BASE_KEY, '');
  if (typeof saved === 'string' && saved.trim()) return saved.trim();
  return ADMIN_RESET_API_BASE;
};

export const saveAdminResetApiBase = (url) => save(ADMIN_RESET_API_BASE_KEY, String(url || '').trim());

const shouldSkipApiCandidate = (base) => {
  if (!base) return true;
  const parsed = parseUrlSafe(base);
  if (!parsed) return true;
  // GitHub Pages runs on HTTPS. Avoid mixed-content blocked HTTP targets except localhost loopback.
  if (window.location.protocol === 'https:' && parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) return true;
  return false;
};

export const readApiBaseFromUrl = () => {
  try {
    const q = new URLSearchParams(window.location.search);
    return normalizeApiBase(q.get('apiBase') || q.get('authApi') || '');
  } catch {
    return '';
  }
};

export const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout')), ms))]);

async function readSharedApiBaseConfig() {
  try {
    const r = await withTimeout(fetch(`${CENTRAL_AUTH_CONFIG_PATH}?v=${Date.now()}`, { method:'GET', cache:'no-store' }), 2500);
    if (!r.ok) return '';
    const data = await r.json().catch(() => ({}));
    return normalizeApiBase((data && typeof data.apiBase === 'string') ? data.apiBase : '');
  } catch {
    return '';
  }
}

export async function probeResetApi(baseUrl, timeoutMs = 3500) {
  const base = normalizeApiBase(baseUrl);
  if (!base) return { ok:false, base, error:'Empty URL' };
  if (shouldSkipApiCandidate(base)) return { ok:false, base, error:'Blocked by browser security (HTTPS page cannot call this HTTP host)' };
  try {
    const r = await withTimeout(fetch(`${base}/health`, { method:'GET' }), timeoutMs);
    if (!r.ok) return { ok:false, base, error:`HTTP ${r.status}` };
    const data = await r.json().catch(() => ({}));
    if (data && data.ok) return { ok:true, base };
    return { ok:false, base, error:'Invalid health response' };
  } catch (e) {
    return { ok:false, base, error:String(e.message || e) };
  }
}

export async function resolveResetApiBase(preferredBase) {
  const sharedConfigBase = await readSharedApiBaseConfig();
  // sharedConfigBase (auth-api-config.json) is the authoritative production URL;
  // list it first so it wins when probed in parallel.
  const candidates = [
    sharedConfigBase,
    preferredBase,
    readApiBaseFromUrl(),
    loadAdminResetApiBase(),
    ...ADMIN_RESET_API_ENDPOINTS
  ].map(normalizeApiBase).filter(Boolean);
  const uniq = [...new Set(candidates)];

  // Probe all candidates simultaneously — the first to succeed wins.
  // Use a generous timeout so cloud backends (Render free tier) have time
  // to wake from a cold start without blocking the user for too long.
  const PROBE_TIMEOUT = 20000;
  try {
    const winner = await Promise.any(
      uniq.map(async c => {
        const chk = await probeResetApi(c, PROBE_TIMEOUT);
        if (!chk.ok) throw new Error(chk.error || 'probe failed');
        return c;
      })
    );
    saveAdminResetApiBase(winner);
    return { ok:true, base:winner };
  } catch {
    return { ok:false, base:normalizeApiBase(preferredBase || loadAdminResetApiBase() || ADMIN_RESET_API_BASE) };
  }
}

export async function getAuthStatus(preferredBase) {
  const resolved = await resolveResetApiBase(preferredBase);
  if (!resolved.ok) {
    reportError('DMG-E021', { phase: 'auth_status', detail: 'resolve_failed' });
    return { ok: false, code: 'DMG-E021', error: 'Auth backend unavailable' };
  }
  const path = '/api/auth/status';
  let r;
  try {
    r = await fetch(`${resolved.base}${path}`);
  } catch (e) {
    const { code } = classifyFetchException(e, path);
    reportError(code, { phase: 'auth_status', message: String(e?.message || e) });
    return { ok: false, code, error: userMessageForCode(code), base: resolved.base };
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const { code } = classifyHttpStatus(r.status, path);
    reportError(code, { phase: 'auth_status', httpStatus: r.status, detail: data.error });
    return {
      ok: false,
      code,
      error: data.error || `HTTP ${r.status}`,
      base: resolved.base,
      httpStatus: r.status,
    };
  }
  return { ok: true, base: resolved.base, ...data };
}

export async function loginViaBackend(username, passwordHash, preferredBase) {
  const resolved = await resolveResetApiBase(preferredBase);
  if (!resolved.ok) {
    reportError('DMG-E021', { phase: 'login', detail: 'resolve_failed' });
    return { ok: false, code: 'DMG-E021', error: 'Auth backend unavailable', user: null };
  }
  const path = '/api/auth/login';
  let r;
  try {
    r = await fetch(`${resolved.base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, passwordHash }),
    });
  } catch (e) {
    const { code } = classifyFetchException(e, path);
    reportError(code, { phase: 'login', message: String(e?.message || e) });
    return { ok: false, code, error: userMessageForCode(code), user: null };
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) {
    const code = !r.ok ? classifyHttpStatus(r.status, path).code : 'DMG-E020';
    reportError(code, { phase: 'login', httpStatus: r.ok ? undefined : r.status });
    return {
      ok: false,
      code,
      error: data.error || 'Login failed',
      user: null,
    };
  }
  if (data.credentialsSnapshot) save('credentials', data.credentialsSnapshot);
  return { ok: true, code: null, user: data.user };
}

export async function syncCredentialsToBackend(credentials, preferredBase, auth = null) {
  const resolved = await resolveResetApiBase(preferredBase);
  if (!resolved.ok) {
    reportError('DMG-E021', { phase: 'sync_credentials', detail: 'resolve_failed' });
    return { ok: false, code: 'DMG-E021', error: 'Auth backend unavailable' };
  }
  const path = '/api/auth/sync';
  const headers = { 'Content-Type': 'application/json' };
  if (auth?.username && auth?.passwordHash) {
    headers['x-auth-user'] = String(auth.username);
    headers['x-auth-hash'] = String(auth.passwordHash);
  }
  let r;
  try {
    r = await fetch(`${resolved.base}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ credentials }),
    });
  } catch (e) {
    const { code } = classifyFetchException(e, path);
    reportError(code, { phase: 'sync_credentials', message: String(e?.message || e) });
    return { ok: false, code, error: userMessageForCode(code) };
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) {
    const { code } = mergeApiFailure({ response: r, path });
    reportError(code, { phase: 'sync_credentials', httpStatus: r.status });
    return { ok: false, code, error: data.error || 'Sync failed' };
  }
  return { ok: true, code: null };
}

export async function scanApiCall(pathName, { method='GET', body=null, currentUser, query=null, preferredBase=null } = {}) {
  // Scanner should "just work" on admin Windows device: prefer local backend automatically.
  const localFirst = await resolveResetApiBase(preferredBase || 'http://localhost:8787');
  const resolved = localFirst.ok ? localFirst : await resolveResetApiBase(preferredBase);
  if (!resolved.ok) {
    reportError('DMG-E021', { phase: 'scan_api', path: pathName, detail: 'resolve_failed' });
    return { ok: false, code: 'DMG-E021', error: 'Backend unavailable (local scanner service not reachable)' };
  }
  const qs = query ? '?' + new URLSearchParams(query).toString() : '';
  const headers = {
    'Content-Type': 'application/json',
    'x-auth-user': String(currentUser?.username || ''),
    'x-auth-hash': String(currentUser?.authHash || '')
  };
  let r;
  try {
    r = await fetch(`${resolved.base}${pathName}${qs}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (e) {
    const { code } = classifyFetchException(e, pathName);
    reportError(code, { phase: 'scan_api', path: pathName, message: String(e?.message || e) });
    return { ok: false, code, error: userMessageForCode(code), base: resolved.base };
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) {
    const { code } = mergeApiFailure({ response: r, path: pathName });
    reportError(code, { phase: 'scan_api', path: pathName, httpStatus: r.status });
    return { ok: false, code, error: data.error || `HTTP ${r.status}`, base: resolved.base };
  }
  return { ok: true, data, base: resolved.base };
}

export async function attendanceApiCall(pathName, { method='GET', body=null, currentUser, query=null, preferredBase=null } = {}) {
  const resolved = await resolveResetApiBase(preferredBase);
  if (!resolved.ok) {
    reportError('DMG-E021', { phase: 'attendance_api', path: pathName, detail: 'resolve_failed' });
    return { ok: false, code: 'DMG-E021', error: 'Attendance backend unavailable' };
  }
  const qs = query ? '?' + new URLSearchParams(query).toString() : '';
  const headers = {
    'Content-Type': 'application/json',
    'x-auth-user': String(currentUser?.username || ''),
    'x-auth-hash': String(currentUser?.authHash || '')
  };
  let r;
  try {
    r = await fetch(`${resolved.base}${pathName}${qs}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (e) {
    const { code } = classifyFetchException(e, pathName);
    reportError(code, { phase: 'attendance_api', path: pathName, message: String(e?.message || e) });
    return { ok: false, code, error: userMessageForCode(code) };
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) {
    const { code } = mergeApiFailure({ response: r, path: pathName });
    reportError(code, { phase: 'attendance_api', path: pathName, httpStatus: r.status });
    return { ok: false, code, error: data.error || `HTTP ${r.status}` };
  }
  return { ok: true, data };
}

const buildAdminResetRequestMailto = (requestSource = 'app') => {
  const subject = 'Admin Password Change Request';
  const body =
`Hello,

Please reset the admin password for Catering Inventory Manager.

Requested from: ${requestSource}

Generate a secure reset link from the backend utility and send it to the requester.

Requested by: `;
  return `mailto:${ADMIN_RESET_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
};

export const requestAdminResetEmail = (requestSource = 'app') => { window.location.href = buildAdminResetRequestMailto(requestSource); };

export const pushAuditEvent = (action, details) => {
  const entry = { id:uid(), username:'system', action, details, timestamp:new Date().toISOString() };
  const log = load('_activityLog', []);
  log.push(entry);
  if (log.length > 2000) log.splice(0, log.length - 2000);
  save('_activityLog', log);
};

const parseErrorDetail = (errorLike) => {
  if (!errorLike) return 'Unknown error';
  if (typeof errorLike === 'string') return trimText(errorLike, 2000);
  if (errorLike instanceof Error) return trimText(`${errorLike.name}: ${errorLike.message}\n${errorLike.stack || ''}`, 3000);
  try { return trimText(JSON.stringify(errorLike), 2000); } catch { return trimText(String(errorLike), 2000); }
};

const appendFailureLog = (entry) => {
  const logs = load(FAILURE_LOG_KEY, []);
  logs.push(entry);
  if (logs.length > 500) logs.splice(0, logs.length - 500);
  save(FAILURE_LOG_KEY, logs);
};

export const logFailure = ({ area='unknown', action='unknown', error=null, extra={} }) => {
  const session = load('_session', null);
  appendFailureLog({
    id: uid(),
    timestamp: new Date().toISOString(),
    area,
    action,
    error: parseErrorDetail(error),
    extra,
    page: window.location.href,
    userAgent: navigator.userAgent || '',
    username: session?.username || 'anonymous'
  });
};

export const initGlobalFailureCapture = () => {
  if (window.__failureCaptureInit) return;
  window.__failureCaptureInit = true;
  window.addEventListener('error', (ev) => {
    logFailure({
      area: 'global',
      action: 'window_error',
      error: ev.error || ev.message || 'Window error',
      extra: { file: ev.filename, line: ev.lineno, col: ev.colno }
    });
  });
  window.addEventListener('unhandledrejection', (ev) => {
    logFailure({
      area: 'global',
      action: 'unhandled_rejection',
      error: ev.reason || 'Unhandled promise rejection'
    });
  });
};

export const downloadFailureLog = () => {
  const payload = {
    exportedAt: new Date().toISOString(),
    app: 'DMG Software Suite',
    page: window.location.href,
    userAgent: navigator.userAgent || '',
    failures: load(FAILURE_LOG_KEY, [])
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `cim-failure-log-${today()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

/** GitHub repo for issue templates from Settings → diagnostics */
export const DIAGNOSTICS_ISSUES_NEW_URL = 'https://github.com/Taha-Farooq/catering-inventory-manager/issues/new';
export const SUPPORT_CONTACT_EMAIL = 'fatimfarooq@yahoo.com';

async function getStorageQuotaHint() {
  if (!navigator.storage?.estimate) return { ok: true, pct: null, msg: 'Storage usage estimate not available in this browser.' };
  try {
    const est = await navigator.storage.estimate();
    const used = est.usage || 0;
    const quota = est.quota || 1;
    const pct = Math.min(100, Math.round((100 * used) / quota));
    if (pct > 92) return { ok: false, level: 'error', pct, msg: `Browser storage is nearly full (~${pct}% used). Export a backup (ZIP above) before you lose space.` };
    if (pct > 82) return { ok: false, level: 'warning', pct, msg: `Browser storage is getting full (~${pct}% used). Consider exporting a backup soon.` };
    return { ok: true, pct, msg: `Browser storage OK (~${pct}% used, ~${(used / 1e6).toFixed(1)} MB).` };
  } catch {
    return { ok: true, pct: null, msg: 'Could not read storage usage.' };
  }
}

export async function gatherDiagnosticsPayload(localFeatureWarning) {
  const healthResetApi = await probeResetApi(loadAdminResetApiBase());
  const storageHint = await getStorageQuotaHint();
  const failures = load(FAILURE_LOG_KEY, []);
  const bootCaps = getBootCapabilityWarnings();
  return {
    generatedAt: new Date().toISOString(),
    app: 'DMG Software Suite',
    pageUrl: window.location.href,
    userAgent: navigator.userAgent || '',
    username: load('_session', null)?.username || 'anonymous',
    resetApiUrl: loadAdminResetApiBase(),
    healthResetApi,
    storageHint,
    localFeatureWarning: localFeatureWarning || '',
    navigatorOnline:
      typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean'
        ? navigator.onLine
        : null,
    bootCapabilityCodes: bootCaps.map((w) => w.code),
    failuresRecent: failures.slice(-40)
  };
}

function diagnosticsPlainText(payload) {
  let s = `=== Catering Inventory Manager — Diagnostics ===
Generated: ${payload.generatedAt}
User: ${payload.username}
Page: ${payload.pageUrl}
Browser: ${payload.userAgent}

Reset API URL: ${payload.resetApiUrl}
Backend /health: ${payload.healthResetApi?.ok ? `OK (${payload.healthResetApi.base})` : `FAIL — ${payload.healthResetApi?.error || 'unknown'}`}
${payload.storageHint?.msg || ''}
Navigator onLine: ${payload.navigatorOnline === null ? 'unknown' : payload.navigatorOnline ? 'true (browser thinks online)' : 'false (offline or flaky network)'}
Boot capability warnings: ${(payload.bootCapabilityCodes || []).length ? (payload.bootCapabilityCodes || []).join(', ') : 'none'}
`;
  if (payload.localFeatureWarning) s += `\nBanner warning on main screen:\n${payload.localFeatureWarning}\n`;
  s += `\n--- Logged errors (last ${payload.failuresRecent?.length || 0}) ---\n`;
  (payload.failuresRecent || []).slice().reverse().forEach((f, i) => {
    s += `\n[${i + 1}] ${f.timestamp}\n  ${f.area} / ${f.action} | ${f.username}\n  ${f.error}\n`;
  });
  return s;
}

export async function copyDiagnosticsReport(localFeatureWarning) {
  const p = await gatherDiagnosticsPayload(localFeatureWarning);
  const text = diagnosticsPlainText(p);
  try {
    await navigator.clipboard.writeText(text);
    return { ok: true, text, payload: p };
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed'; ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      return { ok: true, text, payload: p };
    } catch (e) {
      return { ok: false, error: String(e.message || e), text, payload: p };
    }
  }
}

export function openSupportDiagnosticsEmail(localFeatureWarning) {
  copyDiagnosticsReport(localFeatureWarning).then(({ ok, text }) => {
    showToast(ok ? 'Diagnostics copied. Continue in your email app…' : 'Could not auto-copy; use 📋 Copy first, then send email.', ok ? 'success' : 'warning');
    const subj = encodeURIComponent('Catering Inventory Manager — diagnostics / error report');
    const intro = 'A full diagnostics report was copied to your clipboard.\n\nPlease paste it below this line and send.\n\n---------- PASTE REPORT HERE ----------\n\n';
    const clipHint = ok ? intro : 'Could not auto-copy — open Settings → copy diagnostics manually.\n\n';
    const body = encodeURIComponent(clipHint + text.slice(0, 2800) + (text.length > 2800 ? '\n\n[…report truncated in email — use Copy button for full text…]' : ''));
    window.location.href = `mailto:${SUPPORT_CONTACT_EMAIL}?subject=${subj}&body=${body}`;
  });
}

export function openDiagnosticsGitHubIssue(localFeatureWarning) {
  copyDiagnosticsReport(localFeatureWarning).then(({ ok }) => {
    showToast(ok ? 'Diagnostics copied. Paste into the GitHub issue if needed.' : 'Use 📋 Copy diagnostics, then paste on GitHub.', ok ? 'success' : 'warning');
    const title = encodeURIComponent('Diagnostics / issue report');
    const body = encodeURIComponent(
      (ok ? '**Full diagnostics were copied to your clipboard when you clicked this button.**\n\nPaste them below.\n\n---\n\n' : '**Copy diagnostics from Settings (📋 Copy diagnostics report) and paste below.**\n\n---\n\n') +
      '_Developer: fixes require publishing the site; users should reload (F5) after deploy._\n'
    );
    window.open(`${DIAGNOSTICS_ISSUES_NEW_URL}?title=${title}&body=${body}`, '_blank', 'noopener,noreferrer');
  });
}

export const BRANDING = {
  degrill:  { mark:'DG',  name:'DeGrill Inc',                        location:'Spring Valley, NY',     address:'Spring Valley, NY 10977',          phone:'(845) 555-0100', email:'info@degrill.com',   logo:'assets/logos/degrill.jpg' },
  parathas: { mark:'PP',  name:'Parathas and Platters Inc',          location:'Hackensack, NJ',        address:'Hackensack, NJ 07601',             phone:'(201) 555-0200', email:'info@parathas.com',  logo:'assets/logos/parathas.jpg' },
  dera:     { mark:'DMG', name:'Dera Masala Grill Inc',              location:'Clifton, NJ',           address:'Clifton, NJ 07011',                phone:'(973) 555-0300', email:'info@deramasala.com',logo:'assets/logos/dera.jpg' },
  transfer: { mark:'PP',  name:'Parathas & Platters Internal Transfer', location:'Hackensack -> Englewood', address:'Hackensack, NJ 07601',        phone:'(201) 555-0200', email:'info@parathas.com',  logo:'assets/logos/parathas.jpg' },
};

export function mergeBrandingWithOverrides(logoOverrides, contactOverrides) {
  const o = normalizeLogoOverrides(logoOverrides);
  const c = contactOverrides || {};
  const merge = (key) => ({
    ...BRANDING[key],
    logo: o[key] || BRANDING[key].logo,
    ...(c[key] ? {
      phone:   c[key].phone   !== undefined ? c[key].phone   : BRANDING[key].phone,
      address: c[key].address !== undefined ? c[key].address : BRANDING[key].address,
      email:   c[key].email   !== undefined ? c[key].email   : BRANDING[key].email,
    } : {}),
  });
  return { degrill: merge('degrill'), parathas: merge('parathas'), dera: merge('dera'), transfer: merge('transfer') };
}
