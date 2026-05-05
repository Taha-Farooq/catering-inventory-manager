import React, { useState, useEffect, useMemo, useRef, useCallback, useId, lazy, Suspense } from 'react';
import QRCode from 'qrcode';
import { getBootCapabilityWarnings } from './browserCaps.js';
import { useOnlineStatus } from './useOnlineStatus.js';
import { OfflineBanner, BrowserCapsBanner, BackendUnavailableBanner } from './ReliabilityBanners.jsx';
import { reportError } from './errors.js';
import { showToast, toastApiFailure } from './toastContext.jsx';
import {
  classifyFetchException,
  classifyHttpStatus,
  mergeApiFailure,
  userMessageForCode,
} from './apiErrors.js';
import {
  probeLocalStorage,
  estimateStorageUsage,
  findCorruptStorageKeys,
  removeStorageKeys,
  setSaveFailNotifier,
  notifySaveFailure,
} from './storageHealth.js';
import HelpCenter from './HelpCenter.jsx';
import Confirm from './ui/Confirm.jsx';
import Modal from './ui/Modal.jsx';
import {
  BUSINESSES,
  TABS_ADMIN,
  ALL_USER_TABS,
  DEFAULT_USER_PERMS,
  PROFILE_ICONS,
  CATEGORIES,
  CHART_COLORS,
  PAYMENT_TERMS,
  MENU_UNITS,
  INTERNAL_SELLER_NAME_KEYS,
  NAV_GROUPS_ADMIN,
  NAV_GROUPS_USER,
  ADMIN_RESET_QUERY_KEY,
  ADMIN_RESET_REQ_KEY,
  ADMIN_RESET_EMAIL,
  ADMIN_RESET_API_BASE,
  ADMIN_RESET_API_ENDPOINTS,
  ADMIN_RESET_API_BASE_KEY,
  CENTRAL_AUTH_CONFIG_PATH,
  ADMIN_RESET_CODE_KEY,
  FAILURE_LOG_KEY,
  LOGO_OVERRIDES_KEY,
  SCAN_DOC_TYPES,
  ATT_QR_QUERY_KEY,
} from './constants.js';
import {
  fmt$,
  fmtBytes,
  fmtDate,
  safeQty,
  sellerKey,
  normalizeApiBase,
  parseUrlSafe,
  isLoopbackHost,
  trimText,
  migrateShoppingList,
  uniqSuggestions,
  safePrice,
  resolveAssetUrl,
  normalizeLogoOverrides,
} from './formatters.js';
import * as XLSX from 'xlsx';

const LazyDailyFinanceCharts = lazy(() => import('./charts/DailyFinanceCharts.jsx'));
const LazyAnalyticsCharts = lazy(() => import('./charts/AnalyticsCharts.jsx'));
const LazyPriceHistoryChart = lazy(() => import('./charts/PriceHistoryChart.jsx'));

// username is used as a deterministic salt (see BL-19 / AGENTS.md password-hashing section).
// Legacy callers pass no username → unsalted SHA-256 for backward-compat transition.
async function hashPwd(pwd, username = '') {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Web Crypto is not available (DMG-E050/E051)');
  }
  const input = username ? `${pwd}:${username.toLowerCase()}` : pwd;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2,'0')).join('');
}

// ═══════════════════════════════════════════════════════════
// STORAGE
// ═══════════════════════════════════════════════════════════
function load(key, def) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : def; }
  catch { return def; }
}
function save(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
    return true;
  } catch (e) {
    const msg = e?.message || String(e);
    const code =
      e && (e.name === 'QuotaExceededError' || /quota|exceeded/i.test(msg))
        ? 'DMG-E011'
        : 'DMG-E010';
    reportError(code, { key, message: msg });
    notifySaveFailure({ code, key, message: msg });
    showToast(
      code === 'DMG-E011'
        ? `Storage is full (${code}). Export a backup from Settings, then free space or remove old data.`
        : `Cannot save data (${code}). Enable browser storage — avoid strict private mode if saves fail.`,
      'error'
    );
    return false;
  }
}

/*
 * Data compatibility (GitHub Pages / localStorage):
 * — Keys like `items`, `shoppingList`, `credentials` are stable API surface for users’ backups.
 * — Prefer additive fields (optional props on objects) over renames; use migrate* helpers when normalizing.
 * — `load()` returns the default if JSON is missing or corrupt — never throws to the UI.
 */

// ═══════════════════════════════════════════════════════════
// UTILS
// ═══════════════════════════════════════════════════════════
const today = () => new Date().toISOString().split('T')[0];
const uid = () => crypto.randomUUID();
/** Directory URL of the current page (no hash/query) — resolves relative assets for print + `<img>`. */
function documentBaseHref() {
  try {
    const u = new URL(window.location.href);
    u.hash = '';
    u.search = '';
    const path = u.pathname || '/';
    const i = path.lastIndexOf('/');
    u.pathname = i >= 0 ? path.slice(0, i + 1) : '/';
    return u.href;
  } catch {
    return window.location.href.split('#')[0].split('?')[0];
  }
}
function rewriteImgSrcsForPrint(html, baseHref) {
  const base = baseHref || documentBaseHref();
  try {
    const doc = new DOMParser().parseFromString(`<div id="root">${html}</div>`, 'text/html');
    const root = doc.getElementById('root');
    if (!root) return html;
    root.querySelectorAll('img[src]').forEach((img) => {
      const raw = img.getAttribute('src') || '';
      img.setAttribute('src', resolveAssetUrl(raw, base));
    });
    return root.innerHTML;
  } catch {
    return html;
  }
}
const parseAdminResetParams = () => {
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
const parseAttendanceParams = () => {
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
const loadAdminResetApiBase = () => {
  const saved = load(ADMIN_RESET_API_BASE_KEY, '');
  if (typeof saved === 'string' && saved.trim()) return saved.trim();
  return ADMIN_RESET_API_BASE;
};
const saveAdminResetApiBase = (url) => save(ADMIN_RESET_API_BASE_KEY, String(url || '').trim());
const shouldSkipApiCandidate = (base) => {
  if (!base) return true;
  const parsed = parseUrlSafe(base);
  if (!parsed) return true;
  // GitHub Pages runs on HTTPS. Avoid mixed-content blocked HTTP targets except localhost loopback.
  if (window.location.protocol === 'https:' && parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) return true;
  return false;
};
const readApiBaseFromUrl = () => {
  try {
    const q = new URLSearchParams(window.location.search);
    return normalizeApiBase(q.get('apiBase') || q.get('authApi') || '');
  } catch {
    return '';
  }
};
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
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout')), ms))]);
async function probeResetApi(baseUrl) {
  const base = normalizeApiBase(baseUrl);
  if (!base) return { ok:false, base, error:'Empty URL' };
  if (shouldSkipApiCandidate(base)) return { ok:false, base, error:'Blocked by browser security (HTTPS page cannot call this HTTP host)' };
  try {
    const r = await withTimeout(fetch(`${base}/health`, { method:'GET' }), 3500);
    if (!r.ok) return { ok:false, base, error:`HTTP ${r.status}` };
    const data = await r.json().catch(() => ({}));
    if (data && data.ok) return { ok:true, base };
    return { ok:false, base, error:'Invalid health response' };
  } catch (e) {
    return { ok:false, base, error:String(e.message || e) };
  }
}
async function resolveResetApiBase(preferredBase) {
  const sharedConfigBase = await readSharedApiBaseConfig();
  const candidates = [
    preferredBase,
    readApiBaseFromUrl(),
    loadAdminResetApiBase(),
    sharedConfigBase,
    ...ADMIN_RESET_API_ENDPOINTS
  ].map(normalizeApiBase).filter(Boolean);
  const uniq = [...new Set(candidates)];
  for (const c of uniq) {
    const chk = await probeResetApi(c);
    if (chk.ok) {
      saveAdminResetApiBase(c);
      return { ok:true, base:c };
    }
  }
  return { ok:false, base:normalizeApiBase(preferredBase || loadAdminResetApiBase() || ADMIN_RESET_API_BASE) };
}
async function getAuthStatus(preferredBase) {
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
async function loginViaBackend(username, passwordHash, preferredBase) {
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
async function syncCredentialsToBackend(credentials, preferredBase) {
  const resolved = await resolveResetApiBase(preferredBase);
  if (!resolved.ok) {
    reportError('DMG-E021', { phase: 'sync_credentials', detail: 'resolve_failed' });
    return { ok: false, code: 'DMG-E021', error: 'Auth backend unavailable' };
  }
  const path = '/api/auth/sync';
  let r;
  try {
    r = await fetch(`${resolved.base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
async function scanApiCall(pathName, { method='GET', body=null, currentUser, query=null, preferredBase=null } = {}) {
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
async function attendanceApiCall(pathName, { method='GET', body=null, currentUser, query=null, preferredBase=null } = {}) {
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
const requestAdminResetEmail = (requestSource = 'app') => { window.location.href = buildAdminResetRequestMailto(requestSource); };
const pushAuditEvent = (action, details) => {
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
const logFailure = ({ area='unknown', action='unknown', error=null, extra={} }) => {
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
const initGlobalFailureCapture = () => {
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
const downloadFailureLog = () => {
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
const DIAGNOSTICS_ISSUES_NEW_URL = 'https://github.com/Taha-Farooq/catering-inventory-manager/issues/new';
const SUPPORT_CONTACT_EMAIL = 'fatimfarooq@yahoo.com';

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

async function gatherDiagnosticsPayload(localFeatureWarning) {
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

async function copyDiagnosticsReport(localFeatureWarning) {
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

function openSupportDiagnosticsEmail(localFeatureWarning) {
  copyDiagnosticsReport(localFeatureWarning).then(({ ok, text }) => {
    showToast(ok ? 'Diagnostics copied. Continue in your email app…' : 'Could not auto-copy; use 📋 Copy first, then send email.', ok ? 'success' : 'warning');
    const subj = encodeURIComponent('Catering Inventory Manager — diagnostics / error report');
    const intro = 'A full diagnostics report was copied to your clipboard.\n\nPlease paste it below this line and send.\n\n---------- PASTE REPORT HERE ----------\n\n';
    const clipHint = ok ? intro : 'Could not auto-copy — open Settings → copy diagnostics manually.\n\n';
    const body = encodeURIComponent(clipHint + text.slice(0, 2800) + (text.length > 2800 ? '\n\n[…report truncated in email — use Copy button for full text…]' : ''));
    window.location.href = `mailto:${SUPPORT_CONTACT_EMAIL}?subject=${subj}&body=${body}`;
  });
}

function openDiagnosticsGitHubIssue(localFeatureWarning) {
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

const BRANDING = {
  degrill:  { mark:'DG', name:'DeGrill Inc', location:'Spring Valley, NY', logo:'assets/logos/degrill.jpg' },
  parathas: { mark:'PP', name:'Parathas and Platters Inc', location:'Hackensack, NJ', logo:'assets/logos/parathas.jpg' },
  dera:     { mark:'DMG', name:'Dera Masala Grill Inc', location:'Clifton, NJ', logo:'assets/logos/dera.jpg' },
  transfer: { mark:'PP', name:'Parathas & Platters Internal Transfer', location:'Hackensack -> Englewood', logo:'assets/logos/parathas.jpg' }
};
function mergeBrandingWithOverrides(overrides) {
  const o = normalizeLogoOverrides(overrides);
  return {
    degrill: { ...BRANDING.degrill, logo: o.degrill || BRANDING.degrill.logo },
    parathas: { ...BRANDING.parathas, logo: o.parathas || BRANDING.parathas.logo },
    dera: { ...BRANDING.dera, logo: o.dera || BRANDING.dera.logo },
    transfer: { ...BRANDING.transfer, logo: o.transfer || BRANDING.transfer.logo },
  };
}
function getInvoiceBranding(inv, brandingMap) {
  const b = brandingMap || mergeBrandingWithOverrides(load(LOGO_OVERRIDES_KEY, {}));
  if (inv?._type === 'transfer' || inv?.invoiceType === 'pp_transfer') return b.transfer;
  return b[inv?.business] || { mark:'INV', name:'Invoice', location:'' };
}
function printHtmlDocument(html, title='Invoice') {
  const w = window.open('', '_blank', 'width=1024,height=768');
  if (!w) { showToast('Pop-up blocked. Please allow pop-ups.', 'error'); return false; }
  const base = documentBaseHref();
  const safeHtml = rewriteImgSrcsForPrint(html, base);
  const escBase = base.replace(/"/g, '&quot;');
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"/><base href="${escBase}"/><title>${title}</title>
<style>
  body{font-family:Segoe UI,Arial,sans-serif;margin:20px;color:#222}
  .print-wrap{max-width:900px;margin:0 auto}
  .invoice-mark{display:inline-flex;align-items:center;justify-content:center;width:42px;height:42px;border-radius:50%;background:#8B4513;color:#fff;font-weight:800;font-size:13px;margin-right:10px;overflow:hidden}
  .invoice-mark img{width:42px;height:42px;object-fit:cover}
  table{width:100%;border-collapse:collapse;margin-top:10px}
  th,td{border:1px solid #ddd;padding:8px;text-align:left;font-size:12px}
  th{background:#f7f7f7}
  .text-right{text-align:right}
  .muted{color:#666;font-size:12px}
  @media print{body{margin:8mm} .no-print{display:none}}
</style></head><body><div class="print-wrap">${safeHtml}</div></body></html>`);
  w.document.close();
  w.focus();
  setTimeout(()=>w.print(), 300);
  return true;
}
function printInvoiceById(sectionId) {
  const el = document.getElementById(sectionId);
  if (!el) { showToast('Invoice content not found.', 'error'); return; }
  printHtmlDocument(el.outerHTML, 'Invoice');
}
function SetupQuickActions({ itemsCount, onOpenSettings, onGoTransfer, onGoArchive }) {
  const hasResetCode = !!load(ADMIN_RESET_CODE_KEY, '');
  const creds = load('credentials', {});
  const hasStarterData = !!creds?.admin && itemsCount > 0;
  const log = load('_activityLog', []);
  const hasBackup = log.some(e => e?.action === 'export_backup');
  const doneCount = [hasStarterData, hasResetCode, hasBackup].filter(Boolean).length;
  const allDone = doneCount === 3;
  if (allDone) return null;

  return (
    <div className="card" style={{border:'1.5px solid #EED9B0',background:'#fffdf8'}}>
      <div className="flex-between mb-2" style={{flexWrap:'wrap',gap:8}}>
        <div style={{fontWeight:800,color:'var(--brown)',fontSize:16}}>✅ First-Time Setup Checklist</div>
        <span className="badge badge-user">{doneCount}/3 complete</span>
      </div>
      <div style={{fontSize:13,color:'#6b4b20',marginBottom:10}}>Complete these once to reduce support issues.</div>
      <div style={{display:'grid',gridTemplateColumns:'1fr',gap:6,fontSize:13,marginBottom:12}}>
        <div>{hasStarterData ? '✅' : '⬜'} Starter data imported (admin + items available)</div>
        <div>{hasResetCode ? '✅' : '⬜'} Quick Reset Code configured (Settings → Admin Credentials)</div>
        <div>{hasBackup ? '✅' : '⬜'} At least one backup exported</div>
      </div>
      <div style={{fontWeight:700,color:'var(--brown)',fontSize:14,marginBottom:8}}>⚡ Quick Actions</div>
      <div className="flex gap-2 flex-wrap">
        <Btn className="btn-primary btn-sm" onClick={onOpenSettings}>⚙ Open Settings</Btn>
        <Btn className="btn-outline btn-sm" onClick={onGoTransfer}>🚚 Go to Transfer Invoices</Btn>
        <Btn className="btn-outline btn-sm" onClick={onGoArchive}>🗂 Open Archive</Btn>
        <Btn className="btn-outline btn-sm" onClick={downloadFailureLog}>⬇ Download Failure Log</Btn>
      </div>
    </div>
  );
}
function BrandMark({ brand }) {
  const [failed, setFailed] = useState(false);
  const logoSrc = useMemo(
    () => (brand.logo ? resolveAssetUrl(brand.logo, documentBaseHref()) : ''),
    [brand.logo]
  );
  return (
    <div className="invoice-mark">
      {!failed && logoSrc
        ? <img src={logoSrc} alt={`${brand.name} logo`} onError={()=>setFailed(true)} />
        : <span>{brand.mark}</span>}
    </div>
  );
}

function logActivity(action, details='') {
  try {
    const session = load('_session', null);
    if (!session) return;
    const entry = { id:uid(), username:session.username, action, details, timestamp:new Date().toISOString() };
    const log = load('_activityLog', []);
    log.push(entry);
    if (log.length > 2000) log.splice(0, log.length - 2000);
    save('_activityLog', log);
  } catch(e) {}
}
function getProfile(username) {
  const profiles = load('_profiles', {});
  return profiles[username] || { displayName: username==='admin'?'Administrator':'Staff User', icon: username==='admin'?'👤':'👨‍🍳' };
}
function saveProfileData(username, data) {
  const profiles = load('_profiles', {});
  profiles[username] = { ...(profiles[username]||{}), ...data };
  save('_profiles', profiles);
}

// _seq: monotonic counters for human-readable invoice IDs (P-0001, C-0001, PPH-ENG-date-0001).
let _seq = load('_seq',{purchase:0,catering:0});
function nextId(type) {
  _seq[type]=(_seq[type]||0)+1; save('_seq',_seq);
  return (type==='purchase'?'P-':'C-')+String(_seq[type]).padStart(4,'0');
}
function nextTransferId(dateStr) {
  const d = (dateStr || today()).replace(/-/g,'');
  _seq.transfer = (_seq.transfer || 0) + 1;
  save('_seq', _seq);
  return `PPH-ENG-${d}-${String(_seq.transfer).padStart(4,'0')}`;
}
function normalizeTransferInvoice(inv) {
  const date = inv?.date || today();
  const lineItems = Array.isArray(inv?.lineItems) ? inv.lineItems : [];
  const normalizedLines = lineItems.map(li => {
    const price = +((li?.price ?? li?.unitPrice ?? 0) || 0);
    const commission = +(li?.commission ?? (price * 0.15)).toFixed(2);
    const total = +(li?.total ?? (price + commission)).toFixed(2);
    return {
      quantity: li?.quantity ?? li?.qty ?? '',
      item: li?.item ?? li?.description ?? '',
      price: +price.toFixed(2),
      commission,
      total
    };
  });
  const subTotal = +(inv?.subTotal ?? normalizedLines.reduce((s, l) => s + (l.price || 0), 0)).toFixed(2);
  const commissionTotal = +(inv?.commissionTotal ?? normalizedLines.reduce((s, l) => s + (l.commission || 0), 0)).toFixed(2);
  const grandTotal = +(inv?.grandTotal ?? (subTotal + commissionTotal)).toFixed(2);
  return {
    ...inv,
    id: inv?.id || nextTransferId(date),
    invoiceType: inv?.invoiceType || 'pp_transfer',
    status: inv?.status || 'unpaid',
    date,
    from: inv?.from || 'Parathas & Platters - Hackensack',
    fromContact: inv?.fromContact || 'Hackensack Branch',
    to: inv?.to || 'Parathas & Platters - Englewood',
    toContact: inv?.toContact || 'Englewood Branch',
    notes: inv?.notes || '',
    lineItems: normalizedLines,
    commissionRate: inv?.commissionRate ?? 0.15,
    subTotal,
    commissionTotal,
    grandTotal,
    createdAt: inv?.createdAt || new Date().toISOString()
  };
}

function Toggle({ checked, onChange, label }) {
  return (
    <label style={{display:'flex',alignItems:'center',gap:8,cursor:'pointer',userSelect:'none',margin:0}}>
      <span className="toggle">
        <input type="checkbox" checked={checked} onChange={e=>onChange(e.target.checked)} />
        <span className="toggle-slider" />
      </span>
      <span style={{fontSize:13.5,color:'#5a3010'}}>{label}</span>
    </label>
  );
}

function FI({ label, suggestions, fieldStyle, ...props }) {
  const listId = useId();
  const hasSuggestions = Array.isArray(suggestions) && suggestions.length > 0;
  const baseFieldStyle = label ? {} : { marginBottom: 0 };
  return (
    <div className="field" style={{ ...baseFieldStyle, ...fieldStyle }}>
      {label&&<label>{label}</label>}
      <input className="input" {...props} list={hasSuggestions ? listId : undefined} />
      {hasSuggestions && (
        <datalist id={listId}>
          {suggestions.map(s => <option key={s} value={s} />)}
        </datalist>
      )}
    </div>
  );
}
function FS({ label, children, ...props }) {
  return <div className="field">{label&&<label>{label}</label>}<select className="input" {...props}>{children}</select></div>;
}
function Btn({ className='', children, ...p }) {
  return <button className={`btn ${className}`} {...p}>{children}</button>;
}

// ═══════════════════════════════════════════════════════════
// LOGIN SCREEN
// ═══════════════════════════════════════════════════════════
function FirstRunSetup({ onDone, apiBase }) {
  const [err, setErr] = useState('');
  const [importMsg, setImportMsg] = useState('');
  const importRef = useRef();

  async function importStarter(file) {
    if (!file) return;
    setErr('');
    setImportMsg('');
    try {
      const zip = await JSZip.loadAsync(file);
      const keys = ['items','shoppingList','purchaseInvoices','cateringInvoices','customers','priceHistory','settings','credentials','_profiles','_adminPasswordHash','_userPermissions'];
      let loadedCredentials = false;
      for (const k of keys) {
        const f = zip.file(k + '.json');
        if (!f) continue;
        const v = JSON.parse(await f.async('string'));
        if (k === 'settings' && v && v.selectedBusiness) save('_lastBiz', v.selectedBusiness);
        else save(k, v);
        if (k === 'credentials' && v && typeof v === 'object') loadedCredentials = true;
      }
      if (loadedCredentials) {
        const creds = load('credentials', {});
        const syncResult = await syncCredentialsToBackend(creds, apiBase);
        if (!syncResult.ok) {
          logFailure({ area:'setup', action:'sync_credentials_backend', error:syncResult.error });
        }
        setImportMsg('Starter file imported. You can sign in now.');
        onDone();
      } else {
        setErr('This starter file is missing login accounts. Ask your admin for a valid starter file.');
      }
    } catch (e) {
      setErr('Starter file import failed. Use a valid app backup ZIP.');
    }
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-logo">
          <div className="icon">🍽️</div>
          <h1>Welcome — Starter File Required</h1>
          <p>This app can only be initialized using a starter file from your manager/admin.</p>
        </div>
        <div style={{background:'#E8F4FC',border:'1px solid #B6DBF7',borderRadius:8,padding:'10px 12px',marginBottom:14,fontSize:13,color:'#1e4f72'}}>
          <strong>Quick start:</strong> Click <strong>Import Starter File</strong> and choose the ZIP provided by your admin.
        </div>
        <div style={{display:'flex',gap:8,marginBottom:14,flexWrap:'wrap'}}>
          <Btn className="btn-outline" onClick={()=>importRef.current?.click()}>⬆ Import Starter File</Btn>
          <input ref={importRef} type="file" accept=".zip" style={{display:'none'}} onChange={e=>{importStarter(e.target.files[0]);e.target.value='';}} />
        </div>
        {importMsg && <div style={{background:'#dcfce7',color:'#166534',padding:'8px 12px',borderRadius:6,marginBottom:12,fontSize:13}}>{importMsg}</div>}
        <div style={{background:'#FFF8DC',border:'1px solid #DEB887',borderRadius:8,padding:'10px 14px',marginBottom:8,fontSize:13,color:'#7a5c00'}}>
          🔒 Manual setup is disabled. Only approved starter files can unlock access.
        </div>
        {err && <div style={{background:'#fee2e2',color:'#991b1b',padding:'8px 12px',borderRadius:5,marginBottom:12,fontSize:13}}>{err}</div>}
      </div>
    </div>
  );
}

function LoginScreen({ onLogin, bootWarnings, online }) {
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
  const loginBranding = useMemo(() => mergeBrandingWithOverrides(load(LOGO_OVERRIDES_KEY, {})), []);

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

function AdminResetPortal() {
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

// ═══════════════════════════════════════════════════════════
// PROFILE MODAL
// ═══════════════════════════════════════════════════════════
function ProfileModal({ open, onClose, username, profile, onSave }) {
  const [icon, setIcon] = useState(profile ? profile.icon : '👤');
  const [displayName, setDisplayName] = useState(profile ? profile.displayName : '');

  useEffect(() => {
    if (open && profile) { setIcon(profile.icon); setDisplayName(profile.displayName); }
  }, [open]);

  function handleSave() {
    if (!displayName.trim()) { showToast('Please enter a display name.', 'error'); return; }
    onSave({ icon, displayName: displayName.trim() });
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title="✏️ Edit Your Profile" maxW={480}>
      <FI label="Display Name" value={displayName} onChange={e=>setDisplayName(e.target.value)} maxLength={40} placeholder="Enter your name" />
      <div className="field">
        <label>Choose Your Icon</label>
        <div style={{display:'grid',gridTemplateColumns:'repeat(6,1fr)',gap:8,marginTop:4}}>
          {PROFILE_ICONS.map(emoji=>(
            <button key={emoji} type="button" onClick={()=>setIcon(emoji)}
              style={{fontSize:26,padding:8,border:icon===emoji?'2.5px solid var(--brown)':'1.5px solid #ddd',
                background:icon===emoji?'var(--cream)':'white',borderRadius:8,cursor:'pointer',lineHeight:1,transition:'all .12s'}}>
              {emoji}
            </button>
          ))}
        </div>
      </div>
      <div style={{display:'flex',alignItems:'center',justifyContent:'center',gap:14,background:'var(--cream)',borderRadius:8,padding:'12px 16px',marginBottom:16,border:'1px solid var(--border)'}}>
        <span style={{fontSize:34}}>{icon}</span>
        <span style={{fontSize:16,color:'var(--brown)',fontWeight:700}}>{displayName||'Your Name'}</span>
      </div>
      <div className="flex gap-2" style={{justifyContent:'flex-end'}}>
        <Btn className="btn-outline" onClick={onClose}>Cancel</Btn>
        <Btn className="btn-primary" onClick={handleSave}>💾 Save Profile</Btn>
      </div>
    </Modal>
  );
}

function LogoField({ label, fieldKey, logoFields, setLogoFields, fileRef, onFile }) {
  const val = logoFields[fieldKey] || '';
  const isDataUrl = val.startsWith('data:');
  return (
    <div style={{display:'flex',alignItems:'flex-end',gap:8,marginBottom:10,flexWrap:'wrap'}}>
      <div style={{flex:'1 1 200px'}}>
        <FI label={label + ' URL'} value={isDataUrl ? '' : val}
          onChange={e=>{ const v=e.target.value; setLogoFields(prev=>Object.assign({},prev,{[fieldKey]:v})); }}
          placeholder="https://..." />
      </div>
      <div style={{paddingBottom:2}}>
        <input ref={fileRef} type="file" accept="image/*" style={{display:'none'}}
          onChange={e=>{onFile(fieldKey,e.target.files?.[0]);e.target.value='';}} />
        <Btn className="btn-outline btn-sm" onClick={()=>fileRef.current?.click()}>
          {isDataUrl ? '✓ File loaded' : '📁 Upload file'}
        </Btn>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// SETTINGS MODAL (admin only)
// ═══════════════════════════════════════════════════════════
function SettingsModal({ open, onClose, appState, currentUser, onPermsChange, localFeatureWarning, brandingMap }) {
  const { items, shopping, purchaseInv, cateringInv, transferInv, payrollInvoices,
          dailyFinanceEntries, customers, priceHist,
          setItems, setShopping, setPurchaseInv, setCateringInv, setTransferInv,
          setPayrollInvoices, setDailyFinanceEntries, setCustomers, setPriceHist, setBiz,
          logoOverrides, setLogoOverrides } = appState;
  const importRef = useRef();
  const [diagPayload, setDiagPayload] = useState(null);
  const [diagLoading, setDiagLoading] = useState(false);

  // Staff user management
  const loadStaff = () => {
    const creds = load('credentials', {});
    return Object.entries(creds).filter(([k]) => k !== 'admin').map(([k, v]) => ({
      username: k, displayName: v.displayName || k, permissions: v.permissions || DEFAULT_USER_PERMS
    }));
  };
  const [staff, setStaff] = useState(loadStaff);
  const [showAdd, setShowAdd] = useState(false);
  const [newUname, setNewUname] = useState('');
  const [newDisplay, setNewDisplay] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [newPwdC, setNewPwdC] = useState('');
  const [newPerms, setNewPerms] = useState([...DEFAULT_USER_PERMS]);
  const [addErr, setAddErr] = useState('');
  const [editPwdFor, setEditPwdFor] = useState(null);
  const [editPwd, setEditPwd] = useState('');
  const [editPwdC, setEditPwdC] = useState('');
  const [editPermsFor, setEditPermsFor] = useState(null);
  const [editPerms, setEditPerms] = useState([]);
  const [resetCode, setResetCode] = useState('');
  const [resetCodeC, setResetCodeC] = useState('');
  const [resetCodeMsg, setResetCodeMsg] = useState('');
  const [resetApiInput, setResetApiInput] = useState(() => loadAdminResetApiBase());
  const [resetApiState, setResetApiState] = useState({ kind:'idle', msg:'' });
  const [pendingDeleteUser, setPendingDeleteUser] = useState(null);
  const [pendingBackupFile, setPendingBackupFile] = useState(null);
  const [logoFields, setLogoFields] = useState({ degrill:'', parathas:'', dera:'', transfer:'' });
  const logoFileRefs = { degrill: useRef(), parathas: useRef(), dera: useRef(), transfer: useRef() };
  const MAX_LOGO_BYTES = 500 * 1024;

  async function handleLogoFile(key, file) {
    if (!file) return;
    if (file.size > MAX_LOGO_BYTES) {
      showToast(`Logo file too large (DMG-E040). Max 500 KB — got ${fmtBytes(file.size)}.`, 'error');
      reportError('DMG-E040', { phase: 'logo_upload', key, size: file.size });
      return;
    }
    const reader = new FileReader();
    reader.onload = e => {
      const dataUrl = e.target.result;
      setLogoFields(f => ({ ...f, [key]: dataUrl }));
    };
    reader.readAsDataURL(file);
  }

  useEffect(() => {
    if (!open) return;
    setStaff(loadStaff());
    setResetApiInput(loadAdminResetApiBase());
    setResetApiState({ kind:'idle', msg:'' });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setLogoFields({
      degrill: logoOverrides.degrill || '',
      parathas: logoOverrides.parathas || '',
      dera: logoOverrides.dera || '',
      transfer: logoOverrides.transfer || '',
    });
  }, [open, logoOverrides]);

  function commitLogoOverrides() {
    const next = normalizeLogoOverrides({
      degrill: logoFields.degrill,
      parathas: logoFields.parathas,
      dera: logoFields.dera,
      transfer: logoFields.transfer,
    });
    setLogoOverrides(next);
    save(LOGO_OVERRIDES_KEY, next);
    showToast('Logo URLs saved. Invoices and the header use them immediately.');
    logActivity('profile_update', 'Saved invoice logo URL overrides');
  }
  function clearLogoOverrides() {
    setLogoFields({ degrill:'', parathas:'', dera:'', transfer:'' });
    setLogoOverrides({});
    save(LOGO_OVERRIDES_KEY, {});
    showToast('Logo overrides cleared — default images from the site are used.');
    logActivity('profile_update', 'Cleared invoice logo URL overrides');
  }

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setDiagLoading(true);
    gatherDiagnosticsPayload(localFeatureWarning || '').then(p => {
      if (!cancelled) {
        setDiagPayload(p);
        setDiagLoading(false);
      }
    }).catch(() => { if (!cancelled) setDiagLoading(false); });
    return () => { cancelled = true; };
  }, [open, localFeatureWarning]);

  async function handleCopyDiagnostics() {
    const r = await copyDiagnosticsReport(localFeatureWarning || '');
    if (r.ok) showToast('Diagnostics copied. Paste into email or GitHub.', 'success');
    else showToast('Copy failed — use ⬇ Failure Log.', 'error');
  }

  const TAB_DESC = {
    checkio:  'Clock users in/out and run payroll summaries',
    shopping: 'Build and export shopping lists',
    items:    'Add new items to the database',
    pricer:   'Update supplier prices',
    catering: 'View and create catering invoices',
    dailyfin: 'Track daily income/expenses with tax summaries',
    archive:  'Browse and search past invoices',
    help:     'View role-based help and troubleshooting',
  };
  async function syncCredsBestEffort(action) {
    const creds = load('credentials', {});
    const result = await syncCredentialsToBackend(creds, resetApiInput);
    if (!result.ok) {
      logFailure({ area:'settings', action:`sync_credentials_${action}`, error:result.error });
      showToast('Saved locally. Central login sync is currently unavailable.', 'warning');
      return false;
    }
    return true;
  }

  async function addUser() {
    setAddErr('');
    const uname = newUname.trim().toLowerCase().replace(/\s+/g, '_');
    if (!uname) { setAddErr('Username is required.'); return; }
    if (!/^[a-z0-9_]+$/.test(uname)) { setAddErr('Use only letters, numbers, or underscores.'); return; }
    if (uname === 'admin') { setAddErr('"admin" is a reserved username.'); return; }
    const creds = load('credentials', {});
    if (creds[uname]) { setAddErr('That username is already taken.'); return; }
    if (newPwd.length < 6) { setAddErr('Password must be at least 6 characters.'); return; }
    if (newPwd !== newPwdC) { setAddErr('Passwords do not match.'); return; }
    if (newPerms.length === 0) { setAddErr('At least one tab must be enabled.'); return; }
    const hash = await hashPwd(newPwd, uname);
    const displayName = newDisplay.trim() || uname;
    creds[uname] = { password: hash, role: 'user', displayName, permissions: newPerms };
    save('credentials', creds);
    await syncCredsBestEffort('add_user');
    setStaff(s => [...s, { username: uname, displayName, permissions: newPerms }]);
    setNewUname(''); setNewDisplay(''); setNewPwd(''); setNewPwdC(''); setNewPerms([...DEFAULT_USER_PERMS]);
    setShowAdd(false);
    showToast(displayName + ' added!');
    logActivity('add_user', 'Created staff user: ' + uname);
  }

  function deleteUser(uname) {
    setPendingDeleteUser(uname);
  }
  function confirmDeleteUser() {
    const uname = pendingDeleteUser;
    if (!uname) return;
    const creds = load('credentials', {});
    delete creds[uname];
    save('credentials', creds);
    syncCredsBestEffort('delete_user');
    setStaff(s => s.filter(x => x.username !== uname));
    showToast('User removed.');
    logActivity('delete_user', 'Deleted staff user: ' + uname);
    setPendingDeleteUser(null);
  }

  async function saveUserPwd(uname) {
    if (editPwd.length < 6) { showToast('Password must be at least 6 characters.', 'error'); return; }
    if (editPwd !== editPwdC) { showToast('Passwords do not match.', 'error'); return; }
    const creds = load('credentials', {});
    if (!creds[uname]) return;
    creds[uname].password = await hashPwd(editPwd, uname);
    save('credentials', creds);
    await syncCredsBestEffort('reset_password');
    setEditPwdFor(null); setEditPwd(''); setEditPwdC('');
    showToast('Password updated for @' + uname);
    logActivity('reset_password', 'Reset password for: ' + uname);
  }

  function saveUserPerms(uname) {
    if (editPerms.length === 0) { showToast('At least one tab must be enabled.', 'error'); return; }
    const creds = load('credentials', {});
    if (!creds[uname]) return;
    creds[uname].permissions = editPerms;
    save('credentials', creds);
    syncCredsBestEffort('update_permissions');
    setStaff(s => s.map(x => x.username === uname ? { ...x, permissions: editPerms } : x));
    onPermsChange(editPerms, uname);
    setEditPermsFor(null);
    showToast('Permissions saved for @' + uname);
    logActivity('update_permissions', 'Updated permissions for: ' + uname);
  }

  async function testResetApi(urlToTest) {
    const chk = await probeResetApi(urlToTest);
    if (chk.ok) {
      setResetApiState({ kind:'ok', msg:`Connected: ${chk.base}` });
      return true;
    }
    logFailure({ area:'settings', action:'test_reset_api', error:chk.error || 'health check failed', extra:{ apiBase: urlToTest } });
    setResetApiState({ kind:'error', msg:chk.error || 'Health check failed' });
    return false;
  }
  async function saveResetApi() {
    const normalized = normalizeApiBase(resetApiInput);
    if (!normalized) {
      setResetApiState({ kind:'error', msg:'Enter a reset API URL first.' });
      return;
    }
    setResetApiState({ kind:'checking', msg:'Checking connection...' });
    const ok = await testResetApi(normalized);
    if (!ok) return;
    saveAdminResetApiBase(normalized);
    showToast('Reset API endpoint saved.');
  }
  async function autoDetectResetApi() {
    setResetApiState({ kind:'checking', msg:'Auto-detecting reset API...' });
    const resolved = await resolveResetApiBase(resetApiInput);
    if (!resolved.ok) {
      setResetApiState({ kind:'error', msg:'No healthy reset API found.' });
      return;
    }
    setResetApiInput(resolved.base);
    setResetApiState({ kind:'ok', msg:`Using: ${resolved.base}` });
    showToast('Reset API detected automatically.');
  }
  function resetResetApiDefault() {
    saveAdminResetApiBase(ADMIN_RESET_API_BASE);
    setResetApiInput(ADMIN_RESET_API_BASE);
    setResetApiState({ kind:'idle', msg:'Reverted to default local URL.' });
  }
  async function saveResetCode() {
    setResetCodeMsg('');
    if (!resetCode || resetCode.length < 6) { setResetCodeMsg('Reset Code must be at least 6 characters.'); return; }
    if (resetCode !== resetCodeC) { setResetCodeMsg('Reset Code values do not match.'); return; }
    const h = await hashPwd(resetCode);
    save(ADMIN_RESET_CODE_KEY, h);
    setResetCode('');
    setResetCodeC('');
    setResetCodeMsg('Reset Code saved.');
    showToast('Quick reset code updated.');
  }

  async function doExport() {
    try {
      const zip = new JSZip();
      const payload = {
        items, shoppingList:shopping, purchaseInvoices:purchaseInv,
        cateringInvoices:cateringInv, transferInvoices:transferInv,
        payrollInvoices:(payrollInvoices||[]),
        dailyFinanceEntries:(dailyFinanceEntries||[]),
        customers, priceHistory:priceHist,
        settings:{ selectedBusiness: load('_lastBiz','degrill'), logoOverrides },
        exportDate: new Date().toISOString(), version:'2.1'
      };
      Object.entries(payload).forEach(([k,v]) => zip.file(k+'.json', JSON.stringify(v,null,2)));
      zip.file('README.txt',
        'Catering Inventory Manager — Backup\nExported: ' + new Date().toLocaleString() + '\n\n' +
        'To restore: Open the app → Settings (⚙) → Import Backup → select this ZIP file.'
      );
      const blob = await zip.generateAsync({ type:'blob', compression:'DEFLATE', compressionOptions:{level:6} });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'catering-backup-' + today() + '.zip';
      document.body.appendChild(a); a.click();
      document.body.removeChild(a); URL.revokeObjectURL(url);
      logActivity('export_backup', 'Exported data backup');
      showToast('Backup exported! Save the ZIP file somewhere safe.');
    } catch (e) {
      reportError('DMG-E041', { phase: 'export_zip', message: String(e?.message || e) });
      logFailure({ area: 'settings', action: 'export_backup', error: e });
      showToast(`Export failed (DMG-E041): ${e.message}`, 'error');
    }
  }

  function doImport(file) {
    if (!file) return;
    setPendingBackupFile(file);
  }
  function runBackupImport() {
    const file = pendingBackupFile;
    if (!file) return;
    setPendingBackupFile(null);
    JSZip.loadAsync(file).then(async zip => {
      // Read backup format version (absent in v1.x ZIPs)
      const verFile = zip.file('version.json');
      const backupVersion = verFile ? JSON.parse(await verFile.async('string')) : '1.0';
      const isLegacy = !backupVersion.startsWith('2.1');

      const keys = ['items','shoppingList','purchaseInvoices','cateringInvoices',
                    'transferInvoices','payrollInvoices','dailyFinanceEntries',
                    'customers','priceHistory','settings'];
      const entries = await Promise.all(keys.map(async k => {
        const f = zip.file(k+'.json');
        if (!f) return [k, null];
        return [k, JSON.parse(await f.async('string'))];
      }));

      entries.forEach(([k,v]) => {
        if (!v) return;
        if (k==='items')                { setItems(v);               save('items',v); }
        if (k==='shoppingList')         { setShopping(v);            save('shoppingList',v); }
        if (k==='purchaseInvoices')     { setPurchaseInv(v);         save('purchaseInvoices',v); }
        if (k==='cateringInvoices')     { setCateringInv(v);         save('cateringInvoices',v); }
        if (k==='transferInvoices')     { setTransferInv(v);         save('transferInvoices',v); }
        if (k==='payrollInvoices')      { setPayrollInvoices(v);     save('payrollInvoices',v); }
        if (k==='dailyFinanceEntries')  { setDailyFinanceEntries(v); save('_dailyFinanceEntries',v); }
        if (k==='customers')            { setCustomers(v);           save('customers',v); }
        if (k==='priceHistory')         { setPriceHist(v);           save('priceHistory',v); }
        if (k==='settings'&&v.selectedBusiness) { setBiz(v.selectedBusiness); save('_lastBiz',v.selectedBusiness); }
        if (k==='settings'&&v.logoOverrides!=null) {
          const next = normalizeLogoOverrides(v.logoOverrides);
          setLogoOverrides(next);
          save(LOGO_OVERRIDES_KEY, next);
        }
      });
      logActivity('restore_backup', `Restored data from backup (format v${backupVersion})`);
      showToast('Backup restored! All data has been loaded.');
      if (isLegacy) {
        const missing = [];
        if (!zip.file('transferInvoices.json'))    missing.push('Transfer Invoices');
        if (!zip.file('payrollInvoices.json'))     missing.push('Payroll Invoices');
        if (!zip.file('dailyFinanceEntries.json')) missing.push('Daily Finance Entries');
        if (missing.length) {
          showToast(
            `Older backup (v${backupVersion}): ${missing.join(', ')} were not in this ZIP and remain unchanged on your device.`,
            'warn'
          );
        }
      }
      onClose();
    }).catch(e => {
      reportError('DMG-E041', { phase: 'import_zip', message: String(e?.message || e) });
      logFailure({ area: 'settings', action: 'import_backup', error: e });
      showToast(`Import failed (DMG-E041): ${e.message}`, 'error');
    });
  }

  const totalInvoices = purchaseInv.length + cateringInv.length + (transferInv||[]).length + (payrollInvoices||[]).length;
  const unpaidBal = cateringInv.reduce((s,i)=>s+(i.balanceDue||0),0);

  return (
    <>
    <Modal open={open} onClose={onClose} title="⚙️ Settings & Backup" wide maxW={680}>
      {/* Data Summary */}
      <div style={{background:'var(--cream)',padding:14,borderRadius:8,marginBottom:20}}>
        <div style={{fontWeight:700,color:'var(--brown)',marginBottom:10,fontSize:14}}>📊 Data Summary</div>
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(110px,1fr))',gap:8}}>
          {[['Items',items.length],['Customers',customers.length],['Invoices',totalInvoices],['Outstanding',fmt$(unpaidBal)]].map(([l,v])=>(
            <div key={l} style={{background:'white',padding:'10px 8px',borderRadius:6,textAlign:'center',border:'1px solid #EED9B0'}}>
              <div style={{fontWeight:700,color:'var(--brown)',fontSize:18}}>{v}</div>
              <div style={{fontSize:11,color:'#999',marginTop:3}}>{l}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Invoice logos — optional HTTPS URLs or uploaded files override bundled JPGs */}
      <div style={{border:'1px solid #EED9B0',borderRadius:8,padding:14,marginBottom:20,background:'#fffdf8'}}>
        <div style={{fontWeight:700,color:'var(--brown)',marginBottom:6,fontSize:14}}>🖼 Invoice logos (optional)</div>
        <p style={{fontSize:12,color:'#6b4b20',marginBottom:12,lineHeight:1.55}}>
          Leave blank to use the images shipped with the app (<code style={{fontSize:11}}>public/assets/logos/</code>).
          Paste a full <strong>https://…</strong> URL <em>or</em> upload an image file (max 500 KB).
          Saved on this device and included in backup ZIP.
        </p>
        <LogoField label="DeGrill logo" fieldKey="degrill" logoFields={logoFields} setLogoFields={setLogoFields} fileRef={logoFileRefs.degrill} onFile={handleLogoFile} />
        <LogoField label="Parathas &amp; Platters logo" fieldKey="parathas" logoFields={logoFields} setLogoFields={setLogoFields} fileRef={logoFileRefs.parathas} onFile={handleLogoFile} />
        <LogoField label="Dera Masala Grill logo" fieldKey="dera" logoFields={logoFields} setLogoFields={setLogoFields} fileRef={logoFileRefs.dera} onFile={handleLogoFile} />
        <LogoField label="Internal transfer logo" fieldKey="transfer" logoFields={logoFields} setLogoFields={setLogoFields} fileRef={logoFileRefs.transfer} onFile={handleLogoFile} />
        <div className="flex gap-2 flex-wrap" style={{marginTop:4,alignItems:'center'}}>
          <Btn className="btn-primary btn-sm" onClick={commitLogoOverrides}>Save logos</Btn>
          <Btn className="btn-outline btn-sm" onClick={clearLogoOverrides}>Clear overrides</Btn>
        </div>
        <div style={{display:'flex',gap:12,marginTop:14,flexWrap:'wrap',alignItems:'center'}}>
          <span style={{fontSize:12,color:'#888'}}>Preview:</span>
          {(['degrill','parathas','dera','transfer']).map((key)=>(
            <img key={key} alt={`${key} logo preview`} src={resolveAssetUrl(brandingMap[key]?.logo || '', documentBaseHref())}
              style={{width:40,height:40,objectFit:'cover',borderRadius:'50%',border:'1px solid #EED9B0',background:'#fff'}} />
          ))}
        </div>
      </div>

      {/* System health & warnings */}
      <div style={{border:'1.5px solid #f59e0b',borderRadius:8,padding:16,marginBottom:20,background:'linear-gradient(180deg,#fffbeb 0%,#fff7ed 100%)'}}>
        <div style={{fontWeight:700,color:'var(--brown)',marginBottom:8,fontSize:15}}>⚠️ System health &amp; warnings</div>
        <p style={{fontSize:13,color:'#78350f',lineHeight:1.65,marginBottom:10}}>
          The app records errors automatically (failed logins, backend checks, and unexpected crashes). Use the buttons below to share a <strong>full report</strong> with support so they can suggest a fix.
          This website cannot push code changes by itself — updates are published on GitHub; after that, users only need to <strong>reload the page</strong> (F5).
        </p>
        {diagLoading && <div style={{fontSize:13,color:'#92400e',marginBottom:8}}>Checking backend and storage…</div>}
        {!diagLoading && diagPayload && (
          <div style={{marginBottom:12}}>
            <div style={{display:'flex',flexWrap:'wrap',gap:8,marginBottom:8}}>
              {localFeatureWarning && (
                <span style={{background:'#fef3c7',border:'1px solid #fcd34d',color:'#92400e',padding:'6px 10px',borderRadius:20,fontSize:12.5}}>
                  Scanner / local tools: {localFeatureWarning}
                </span>
              )}
              {!diagPayload.healthResetApi?.ok && (
                <span style={{background:'#fee2e2',border:'1px solid #fca5a5',color:'#991b1b',padding:'6px 10px',borderRadius:20,fontSize:12.5}}>
                  Reset / login server not reachable ({diagPayload.healthResetApi?.error || 'unknown'})
                </span>
              )}
              {diagPayload.healthResetApi?.ok && (
                <span style={{background:'#dcfce7',border:'1px solid #86efac',color:'#166534',padding:'6px 10px',borderRadius:20,fontSize:12.5}}>
                  Reset API OK ({diagPayload.healthResetApi.base})
                </span>
              )}
              {!diagPayload.storageHint?.ok && (
                <span style={{background:diagPayload.storageHint?.level==='error'?'#fee2e2':'#fef3c7',border:'1px solid #fcd34d',color:'#92400e',padding:'6px 10px',borderRadius:20,fontSize:12.5}}>
                  {diagPayload.storageHint?.msg}
                </span>
              )}
              {diagPayload.storageHint?.ok && diagPayload.storageHint?.pct != null && (
                <span style={{background:'#e0f2fe',border:'1px solid #7dd3fc',color:'#0369a1',padding:'6px 10px',borderRadius:20,fontSize:12.5}}>
                  {diagPayload.storageHint.msg}
                </span>
              )}
            </div>
            {(diagPayload.failuresRecent || []).length > 0 && (
              <div style={{background:'white',border:'1px solid #EED9B0',borderRadius:6,padding:'10px 12px',maxHeight:140,overflowY:'auto',fontSize:12,color:'#444'}}>
                <div style={{fontWeight:600,color:'var(--brown)',marginBottom:6,fontSize:12.5}}>Recent logged issues (newest first)</div>
                {[...(diagPayload.failuresRecent || [])].reverse().slice(0, 6).map((f, fi) => (
                  <div key={f.id || `f-${fi}-${f.timestamp}`} style={{marginBottom:8,paddingBottom:8,borderBottom:'1px solid #f5ead5',lineHeight:1.45}}>
                    <span style={{color:'#888',fontSize:11}}>{f.timestamp?.slice(0, 19).replace('T', ' ')}</span>
                    {' · '}{f.area}/{f.action}
                    <div style={{color:'#991b1b',marginTop:2}}>{f.error}</div>
                  </div>
                ))}
              </div>
            )}
            {(diagPayload.failuresRecent || []).length === 0 && !localFeatureWarning && diagPayload.healthResetApi?.ok && diagPayload.storageHint?.ok && (
              <div style={{fontSize:13,color:'#166534'}}>No recent errors logged. If something still feels wrong, copy a report anyway.</div>
            )}
          </div>
        )}
        <div className="flex gap-2 flex-wrap" style={{marginBottom:10}}>
          <Btn className="btn-primary btn-sm" onClick={handleCopyDiagnostics}>📋 Copy diagnostics report</Btn>
          <Btn className="btn-outline btn-sm" onClick={()=>openSupportDiagnosticsEmail(localFeatureWarning || '')}>✉️ Email support ({SUPPORT_CONTACT_EMAIL})</Btn>
          <Btn className="btn-outline btn-sm" onClick={()=>openDiagnosticsGitHubIssue(localFeatureWarning || '')}>🐙 Open GitHub issue</Btn>
          <Btn className="btn-outline btn-sm" onClick={downloadFailureLog}>⬇ Raw failure log (.json)</Btn>
        </div>
        <div style={{fontSize:12,color:'#57534e',background:'#fff',border:'1px dashed #d6d3d1',borderRadius:6,padding:'10px 12px',lineHeight:1.55}}>
          <strong>After a fix is released:</strong> Close nothing permanently — just press <strong>F5</strong> (Refresh) or tap your browser&apos;s reload button.
          If the page looks unchanged, wait a minute and refresh again (school networks sometimes cache the old file).
          Major risky fixes are developed and merged carefully on GitHub; this menu cannot auto-install them.
        </div>
      </div>

      {/* Backup / Restore */}
      <div style={{border:'1.5px solid #EED9B0',borderRadius:8,padding:16,marginBottom:20}}>
        <div style={{fontWeight:700,color:'var(--brown)',marginBottom:6,fontSize:15}}>💾 Backup &amp; Restore</div>
        <p style={{fontSize:13,color:'#666',marginBottom:14,lineHeight:1.6}}>
          Export a ZIP file of ALL your data — items, invoices, customers, price history.
          Import it any time to restore if browser data is cleared.
        </p>
        <div className="flex gap-2 flex-wrap">
          <Btn className="btn-primary" onClick={doExport}>⬇ Export Backup (.zip)</Btn>
          <Btn className="btn-outline" onClick={()=>importRef.current.click()}>⬆ Import Backup</Btn>
          <input ref={importRef} type="file" accept=".zip" style={{display:'none'}} onChange={e=>{doImport(e.target.files[0]);e.target.value='';}} />
        </div>
        <p style={{fontSize:11.5,color:'#aaa',marginTop:10}}>
          💡 Tip: Save backups to Google Drive, OneDrive, or email them to yourself for safekeeping.
        </p>
      </div>

      {/* Staff Users */}
      <div style={{border:'1.5px solid #EED9B0',borderRadius:8,padding:16,marginBottom:20}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
          <div style={{fontWeight:700,color:'var(--brown)',fontSize:15}}>👥 Staff Users</div>
          {!showAdd && <Btn className="btn-primary btn-sm" onClick={()=>{setShowAdd(true);setAddErr('');}}>＋ Add User</Btn>}
        </div>

        {showAdd && (
          <div style={{background:'#f9f6ef',border:'1.5px solid #DEB887',borderRadius:8,padding:14,marginBottom:14}}>
            <div style={{fontWeight:700,marginBottom:10,color:'var(--brown)'}}>✨ New Staff User</div>
            <div className="grid-2">
              <FI label="Username (used to log in)" value={newUname} onChange={e=>setNewUname(e.target.value)} placeholder="e.g. john" autoComplete="off" />
              <FI label="Display Name (shown in app)" value={newDisplay} onChange={e=>setNewDisplay(e.target.value)} placeholder="e.g. John Smith" />
              <FI label="Password" type="password" value={newPwd} onChange={e=>setNewPwd(e.target.value)} placeholder="Min 6 characters" autoComplete="new-password" />
              <FI label="Confirm Password" type="password" value={newPwdC} onChange={e=>setNewPwdC(e.target.value)} placeholder="Re-enter password" autoComplete="new-password" />
            </div>
            <div style={{marginBottom:6,fontWeight:600,fontSize:13,color:'var(--brown)'}}>Tab Access:</div>
            <div style={{display:'flex',flexWrap:'wrap',gap:8,marginBottom:12}}>
              {ALL_USER_TABS.map(t=>(
                <label key={t.id} title={TAB_DESC[t.id]} style={{display:'flex',alignItems:'center',gap:6,background:newPerms.includes(t.id)?'var(--cream)':'#f0f0f0',padding:'5px 10px',borderRadius:20,border:newPerms.includes(t.id)?'1.5px solid #DEB887':'1px solid #ddd',cursor:'pointer',fontSize:13,userSelect:'none'}}>
                  <input type="checkbox" checked={newPerms.includes(t.id)} onChange={e=>setNewPerms(p=>e.target.checked?[...p,t.id]:p.filter(id=>id!==t.id))} />
                  {t.label}
                </label>
              ))}
            </div>
            {addErr && <div style={{background:'#fee2e2',color:'#991b1b',padding:'7px 10px',borderRadius:5,marginBottom:10,fontSize:13}}>{addErr}</div>}
            <div className="flex gap-2">
              <Btn className="btn-primary btn-sm" onClick={addUser}>✓ Create User</Btn>
              <Btn className="btn-outline btn-sm" onClick={()=>{setShowAdd(false);setAddErr('');}}>Cancel</Btn>
            </div>
          </div>
        )}

        {staff.length === 0 && !showAdd && (
          <div style={{textAlign:'center',padding:'24px 16px',color:'#bbb',fontSize:13,border:'1px dashed #ddd',borderRadius:8}}>
            No staff users yet. Click <strong>＋ Add User</strong> to create the first one.
          </div>
        )}

        {staff.map(u => (
          <div key={u.username} style={{border:'1px solid #EED9B0',borderRadius:8,padding:'12px 14px',marginBottom:10,background:'white'}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',flexWrap:'wrap',gap:8}}>
              <div>
                <div style={{fontWeight:700,fontSize:14}}>{u.displayName} <span style={{fontWeight:400,color:'#999',fontSize:12}}>@{u.username}</span></div>
                <div style={{fontSize:12,color:'#888',marginTop:3}}>
                  Access: {u.permissions.map(p=>ALL_USER_TABS.find(t=>t.id===p)?.label||p).join(' · ') || '(none)'}
                </div>
              </div>
              <div className="flex gap-2" style={{flexWrap:'wrap'}}>
                <Btn className="btn-outline btn-sm" onClick={()=>{setEditPermsFor(editPermsFor===u.username?null:u.username);setEditPerms([...u.permissions]);setEditPwdFor(null);}}>🔒 Permissions</Btn>
                <Btn className="btn-outline btn-sm" onClick={()=>{setEditPwdFor(editPwdFor===u.username?null:u.username);setEditPwd('');setEditPwdC('');setEditPermsFor(null);}}>🔑 Password</Btn>
                <Btn className="btn-sm" style={{background:'#fee2e2',color:'#991b1b',border:'1px solid #fca5a5'}} onClick={()=>deleteUser(u.username)}>🗑</Btn>
              </div>
            </div>

            {editPermsFor === u.username && (
              <div style={{marginTop:12,paddingTop:12,borderTop:'1px solid #EED9B0'}}>
                <div style={{fontWeight:600,fontSize:13,marginBottom:8,color:'var(--brown)'}}>Tab access for @{u.username}:</div>
                <div style={{display:'flex',flexWrap:'wrap',gap:8,marginBottom:10}}>
                  {ALL_USER_TABS.map(t=>(
                    <label key={t.id} title={TAB_DESC[t.id]} style={{display:'flex',alignItems:'center',gap:6,background:editPerms.includes(t.id)?'var(--cream)':'#f0f0f0',padding:'5px 10px',borderRadius:20,border:editPerms.includes(t.id)?'1.5px solid #DEB887':'1px solid #ddd',cursor:'pointer',fontSize:13,userSelect:'none'}}>
                      <input type="checkbox" checked={editPerms.includes(t.id)} onChange={e=>setEditPerms(p=>e.target.checked?[...p,t.id]:p.filter(id=>id!==t.id))} />
                      {t.label}
                    </label>
                  ))}
                </div>
                <div className="flex gap-2">
                  <Btn className="btn-primary btn-sm" onClick={()=>saveUserPerms(u.username)}>💾 Save Access</Btn>
                  <Btn className="btn-outline btn-sm" onClick={()=>setEditPermsFor(null)}>Cancel</Btn>
                </div>
              </div>
            )}

            {editPwdFor === u.username && (
              <div style={{marginTop:12,paddingTop:12,borderTop:'1px solid #EED9B0'}}>
                <div style={{fontWeight:600,fontSize:13,marginBottom:8,color:'var(--brown)'}}>Set new password for @{u.username}:</div>
                <div className="grid-2">
                  <FI label="New Password" type="password" value={editPwd} onChange={e=>setEditPwd(e.target.value)} placeholder="Min 6 characters" autoComplete="new-password" />
                  <FI label="Confirm Password" type="password" value={editPwdC} onChange={e=>setEditPwdC(e.target.value)} placeholder="Re-enter" autoComplete="new-password" />
                </div>
                <div className="flex gap-2">
                  <Btn className="btn-primary btn-sm" onClick={()=>saveUserPwd(u.username)}>💾 Save Password</Btn>
                  <Btn className="btn-outline btn-sm" onClick={()=>setEditPwdFor(null)}>Cancel</Btn>
                </div>
              </div>
            )}
          </div>
        ))}
        <div style={{fontSize:12,color:'#888',marginTop:4}}>💡 To view a user's activity, go to the <strong>Activity Log</strong> tab and filter by their username.</div>
      </div>

      {/* Admin Password */}
      <div style={{border:'1.5px solid #EED9B0',borderRadius:8,padding:16,marginBottom:20}}>
        <div style={{fontWeight:700,color:'var(--brown)',marginBottom:8,fontSize:15}}>🔑 Admin Credentials</div>
        <p style={{fontSize:13,color:'#555',lineHeight:1.7,marginBottom:8}}>
          Admin credentials are managed centrally and cannot be changed from inside the app.
        </p>
        <Btn className="btn-outline btn-sm" style={{marginBottom:10}} onClick={()=>requestAdminResetEmail('settings_admin_credentials')}>
          ✉️ Send Admin Password Reset Request
        </Btn>
        <div style={{fontSize:12.5,color:'#7a5c00',background:'#FFF8DC',border:'1px solid #DEB887',borderRadius:6,padding:'10px 12px'}}>
          To request admin credential changes, email <a href="mailto:fatimfarooq@yahoo.com" style={{color:'var(--brown)',fontWeight:700}}>fatimfarooq@yahoo.com</a>.
        </div>
        <div style={{marginTop:12,paddingTop:10,borderTop:'1px solid #EED9B0'}}>
          <div style={{fontWeight:600,fontSize:13,color:'#5a3010',marginBottom:6}}>Quick Reset Code (for login-screen reset)</div>
          <div className="grid-2">
            <FI label="New Reset Code" type="password" value={resetCode} onChange={e=>{setResetCode(e.target.value);setResetCodeMsg('');}} placeholder="Min 6 characters" />
            <FI label="Confirm Reset Code" type="password" value={resetCodeC} onChange={e=>{setResetCodeC(e.target.value);setResetCodeMsg('');}} placeholder="Re-enter reset code" />
          </div>
          {resetCodeMsg && <div style={{fontSize:12.5,color:resetCodeMsg==='Reset Code saved.'?'#166534':'#991b1b',marginBottom:8}}>{resetCodeMsg}</div>}
          <Btn className="btn-primary btn-sm" onClick={saveResetCode}>💾 Save Reset Code</Btn>
        </div>
      </div>

      <div style={{border:'1.5px solid #EED9B0',borderRadius:8,padding:16,marginBottom:20}}>
        <div style={{fontWeight:700,color:'var(--brown)',marginBottom:8,fontSize:15}}>🛡️ Reset Service Endpoint</div>
        <p style={{fontSize:13,color:'#666',lineHeight:1.6,marginBottom:10}}>
          Keep this working for low-tech users. The app auto-checks health and falls back to known local endpoints.
        </p>
        <FI label="Reset API Base URL" value={resetApiInput} onChange={e=>{setResetApiInput(e.target.value); setResetApiState({kind:'idle',msg:''});}} placeholder="http://localhost:8787" />
        <div className="flex gap-2 flex-wrap" style={{marginBottom:8}}>
          <Btn className="btn-primary btn-sm" onClick={saveResetApi}>💾 Save Endpoint</Btn>
          <Btn className="btn-outline btn-sm" onClick={autoDetectResetApi}>🧪 Auto Detect</Btn>
          <Btn className="btn-outline btn-sm" onClick={()=>testResetApi(resetApiInput)}>🔍 Test Only</Btn>
          <Btn className="btn-outline btn-sm" onClick={resetResetApiDefault}>↺ Default</Btn>
        </div>
        {resetApiState.msg && (
          <div style={{
            fontSize:12.5,
            borderRadius:6,
            padding:'8px 10px',
            background: resetApiState.kind==='ok' ? '#dcfce7' : resetApiState.kind==='error' ? '#fee2e2' : '#E8F4FC',
            color: resetApiState.kind==='ok' ? '#166534' : resetApiState.kind==='error' ? '#991b1b' : '#1e4f72'
          }}>
            {resetApiState.msg}
          </div>
        )}
      </div>

      <div style={{marginTop:4,textAlign:'right'}}>
        <Btn className="btn-outline" onClick={onClose}>Close</Btn>
      </div>
    </Modal>
    <Confirm
      open={!!pendingDeleteUser}
      title="Remove staff user"
      message={`Remove "${pendingDeleteUser}" from this device? Their login will stop working here.`}
      detail="This cannot be undone on this device. Central sync will update other devices when the network is available."
      dangerCode="DMG-E012 (destructive local change)"
      confirmLabel="Remove user"
      confirmClass="btn-danger"
      onConfirm={confirmDeleteUser}
      onCancel={() => setPendingDeleteUser(null)}
    />
    <Confirm
      open={!!pendingBackupFile}
      title="Replace all data from backup?"
      message="This will overwrite items, shopping list, invoices, customers, and price history on this device with the contents of the ZIP file."
      detail={`File: ${pendingBackupFile?.name || 'backup.zip'}\n\nExport a fresh backup first if you are unsure. This cannot be undone.`}
      dangerCode="DMG-E040 / DMG-E012 — full local restore"
      confirmLabel="Replace all data"
      confirmClass="btn-danger"
      wide
      onConfirm={runBackupImport}
      onCancel={() => setPendingBackupFile(null)}
    />
    </>
  );
}

// ═══════════════════════════════════════════════════════════
// TAB 1 — ITEM DATABASE
// ═══════════════════════════════════════════════════════════
function ItemDatabase({ items, setItems, priceHistory, setPriceHistory, userRole }) {
  const isAdmin = userRole === 'admin';
  const BLANK = {name:'',category:'Produce',upc:'',unit:'lb',notes:'',sellers:[{name:'',price:''}]};
  const blank = () => ({...BLANK, sellers:[{name:'',price:''}]});
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(blank());
  const [confirmId, setConfirmId] = useState(null);

  const sellerSuggestions = useMemo(()=>uniqSuggestions(...items.flatMap(i=>(i.sellers||[]).map(s=>s.name))),[items]);
  const unitSuggestions = useMemo(()=>uniqSuggestions(...items.map(i=>i.unit)),[items]);
  const itemNameSuggestions = useMemo(()=>uniqSuggestions(...items.map(i=>i.name)),[items]);

  const filtered = useMemo(()=>{
    const q=search.toLowerCase();
    return items.filter(i=>i.name.toLowerCase().includes(q)||i.category.toLowerCase().includes(q)||(i.upc||'').includes(q));
  },[items,search]);

  const pendingDeleteItem = useMemo(
    () => (confirmId ? items.find((i) => i.id === confirmId) : null),
    [confirmId, items]
  );

  function openEdit(item) {
    const sellers = Array.isArray(item.sellers) ? item.sellers : [];
    setForm({...item,sellers:sellers.length ? sellers.map(s=>({...s})) : [{name:'',price:''}]});
    setEditId(item.id);
    setShowForm(true);
  }
  function setSeller(i,f2,v) { setForm(f=>{const s=[...f.sellers];s[i]={...s[i],[f2]:v};return{...f,sellers:s};}); }

  function saveItem() {
    if (!form.name.trim()) { showToast('Item name is required.', 'error'); return; }
    const sellers = [];
    const seenSellerKeys = new Set();
    for (const s of form.sellers) {
      const sellerName = (s.name || '').trim();
      if (!sellerName) continue;
      const sk = sellerKey(sellerName);
      if (INTERNAL_SELLER_NAME_KEYS.has(sk)) {
        showToast(`"${sellerName}" looks like one of your own companies, not an external supplier. Please use the actual vendor name.`, 'warning');
        return;
      }
      if (seenSellerKeys.has(sk)) { showToast(`Duplicate seller "${sellerName}" for this item. Use unique seller names.`, 'error'); return; }
      seenSellerKeys.add(sk);
      const p = safePrice(s.price);
      if (s.price!==''&&p===null) { showToast(`Invalid price for "${sellerName}". Must be a positive number or left blank.`, 'error'); return; }
      sellers.push({name:sellerName,price:p});
    }
    if (editId) {
      const old = items.find(x=>x.id===editId);
      const newHist = [];
      sellers.forEach(s => {
        const prev=(old.sellers||[]).find(os=>sellerKey(os.name)===sellerKey(s.name));
        if (prev&&prev.price!==null&&s.price!==null&&prev.price!==s.price)
          newHist.push({id:uid(),itemId:editId,itemName:form.name,seller:s.name,oldPrice:prev.price,newPrice:s.price,date:today()});
      });
      if (newHist.length) { const u=[...priceHistory,...newHist]; setPriceHistory(u); save('priceHistory',u); }
      const u=items.map(x=>x.id===editId?{...x,...form,sellers}:x);
      setItems(u); save('items',u);
    } else {
      const u=[...items,{id:uid(),...form,sellers,createdAt:today()}];
      setItems(u); save('items',u);
    }
    setShowForm(false);
    logActivity(editId ? 'edit_item' : 'add_item', form.name);
    showToast(editId ? 'Item updated!' : 'Item added to database!');
  }

  function deleteItem(id) { const u=items.filter(x=>x.id!==id); setItems(u); save('items',u); setConfirmId(null); showToast('Item deleted.'); logActivity('delete_item','Deleted item'); }
  function cleanupInternalSellers() {
    let removed = 0;
    const next = items.map(it => {
      const sellers = Array.isArray(it.sellers) ? it.sellers : [];
      const filteredSellers = sellers.filter(s => {
        const keep = !INTERNAL_SELLER_NAME_KEYS.has(sellerKey(s?.name || ''));
        if (!keep) removed += 1;
        return keep;
      });
      return filteredSellers.length === sellers.length ? it : { ...it, sellers: filteredSellers };
    });
    if (!removed) { showToast('No internal company names found in sellers list.'); return; }
    setItems(next);
    save('items', next);
    logActivity('edit_item', `Cleaned ${removed} internal-name sellers from catalog`);
    showToast(`Removed ${removed} internal-name sellers from items.`);
  }

  return (
    <div>
      <div className="flex-between mb-4 flex-wrap gap-2">
        <div className="section-title" style={{margin:0}}>Item Database ({items.length})</div>
        <div className="flex gap-2">
          {isAdmin && <Btn className="btn-outline" onClick={cleanupInternalSellers}>🧹 Clean Seller List</Btn>}
          <Btn className="btn-primary" onClick={()=>{setForm(blank());setEditId(null);setShowForm(true);}}>＋ Add New Item</Btn>
        </div>
      </div>
      <input className="input mb-4" placeholder="Search by name, category, or UPC…" value={search} onChange={e=>setSearch(e.target.value)} />
      {!isAdmin && <div style={{background:'#dbeafe',color:'#1d4ed8',padding:'8px 14px',borderRadius:5,marginBottom:14,fontSize:13}}>💡 Tip: You can add new items using the button above. To edit or delete items, contact your admin.</div>}

      {filtered.length===0
        ? <div className="card empty-state">{items.length===0?'No items yet. Click "Add Item" to get started.':'No items match your search.'}</div>
        : (
          <div className="card" style={{padding:0}}>
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>Name</th><th>Category</th><th>Unit</th><th>UPC</th><th>Sellers / Prices</th>{isAdmin&&<th>Actions</th>}</tr></thead>
                <tbody>
                  {filtered.map(item=>(
                    <tr key={item.id}>
                      <td style={{fontWeight:600}}>{item.name}</td>
                      <td><span style={{fontSize:11.5,background:'#FFF0D4',color:'var(--brown)',padding:'2px 7px',borderRadius:10}}>{item.category}</span></td>
                      <td>{item.unit}</td>
                      <td style={{fontFamily:'monospace',fontSize:12,color:'#888'}}>{item.upc||'—'}</td>
                      <td>
                        {(item.sellers||[]).map((s,i)=>(
                          <div key={i} style={{fontSize:13,lineHeight:1.8}}>
                            <strong style={{color:'var(--brown)'}}>{s.name}</strong>
                            {s.price!==null&&s.price!==undefined
                              ?<span style={{color:'#555'}}> — {fmt$(s.price)}/{item.unit}</span>
                              :<span style={{color:'#bbb'}}> — no price</span>}
                          </div>
                        ))}
                      </td>
                      {isAdmin&&(
                        <td style={{whiteSpace:'nowrap'}}>
                          <Btn className="btn-secondary btn-sm" style={{marginRight:5}} onClick={()=>openEdit(item)}>Edit</Btn>
                          <Btn className="btn-danger btn-sm" onClick={()=>setConfirmId(item.id)}>Delete</Btn>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      }

      <Modal open={showForm} onClose={()=>setShowForm(false)} title={editId?'Edit Item':'Add New Item'}>
        <div className="grid-2">
          <FI label="Item Name *" value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} placeholder="e.g. Chicken Breast" suggestions={itemNameSuggestions} />
          <FS label="Category" value={form.category} onChange={e=>setForm(f=>({...f,category:e.target.value}))}>
            {CATEGORIES.map(c=><option key={c}>{c}</option>)}
          </FS>
        </div>
        <div className="grid-2">
          <FI label="Unit of Measure" value={form.unit} onChange={e=>setForm(f=>({...f,unit:e.target.value}))} placeholder="lb, kg, each, case…" suggestions={unitSuggestions} />
          <FI label="UPC Code (optional)" value={form.upc} onChange={e=>setForm(f=>({...f,upc:e.target.value}))} placeholder="Barcode" />
        </div>
        <div style={{marginBottom:14}}>
          <div className="flex-between mb-2">
            <label style={{margin:0}}>Sellers &amp; Prices</label>
            <Btn className="btn-outline btn-sm" onClick={()=>setForm(f=>({...f,sellers:[...f.sellers,{name:'',price:''}]}))}>+ Seller</Btn>
          </div>
          {form.sellers.map((s,i)=>(
            <div key={i} className="flex gap-2 mb-2" style={{alignItems:'center'}}>
              <FI fieldStyle={{ flex: 2 }} suggestions={sellerSuggestions} placeholder="Seller name" value={s.name} onChange={e=>setSeller(i,'name',e.target.value)} />
              <input className="input" placeholder="Price (blank = unknown)" type="number" min="0" step="0.01" value={s.price} onChange={e=>setSeller(i,'price',e.target.value)} style={{flex:1}} />
              {form.sellers.length>1&&<Btn className="btn-danger btn-sm" onClick={()=>setForm(f=>({...f,sellers:f.sellers.filter((_,x)=>x!==i)}))}>✕</Btn>}
            </div>
          ))}
        </div>
        <div className="field">
          <label>Notes</label>
          <textarea className="input" rows={2} value={form.notes} onChange={e=>setForm(f=>({...f,notes:e.target.value}))} />
        </div>
        <div className="flex gap-2" style={{justifyContent:'flex-end',marginTop:8}}>
          <Btn className="btn-outline" onClick={()=>setShowForm(false)}>Cancel</Btn>
          <Btn className="btn-primary" onClick={saveItem}>Save Item</Btn>
        </div>
      </Modal>

      <Confirm
        open={!!confirmId}
        title="Delete item?"
        message={
          pendingDeleteItem
            ? `Remove "${pendingDeleteItem.name}" from the item database on this device?`
            : 'Remove this item from the item database on this device?'
        }
        detail="Lines on the shopping list that reference this item may need cleanup. Export a backup from Settings if unsure."
        dangerCode="DMG-E012 (local data change)"
        confirmLabel="Delete item"
        onConfirm={() => deleteItem(confirmId)}
        onCancel={() => setConfirmId(null)}
      />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// TAB 2 — SHOPPING LIST
// ═══════════════════════════════════════════════════════════
function ShoppingList({ items, shoppingList, setShoppingList }) {
  const [search, setSearch] = useState('');
  const [showDrop, setShowDrop] = useState(false);
  const [dragFromIdx, setDragFromIdx] = useState(null);
  const [dragOverIdx, setDragOverIdx] = useState(null);
  const [showClearListConfirm, setShowClearListConfirm] = useState(false);

  function reorderRows(from, to) {
    if (from === to) return;
    if (from < 0 || to < 0 || from >= shoppingList.length || to >= shoppingList.length) return;
    const next = [...shoppingList];
    const [row] = next.splice(from, 1);
    next.splice(to, 0, row);
    setShoppingList(next);
    save('shoppingList', next);
  }

  function upcForEntry(e) {
    const inv = items.find(i => i.id === e.itemId);
    const raw = String((inv && inv.upc != null ? inv.upc : e.upc) ?? '').trim();
    return raw || 'NOT-LISTED';
  }

  const results = useMemo(()=>{
    if (!search.trim()) return [];
    const q=search.toLowerCase();
    return items.filter(i=>i.name.toLowerCase().includes(q)||i.category.toLowerCase().includes(q)).slice(0,10);
  },[search,items]);

  function addItem(item) {
    const sellerList = Array.isArray(item.sellers) ? item.sellers : [];
    const sel=sellerList[0]||{name:'',price:null};
    const dup=shoppingList.find(s=>s.itemId===item.id&&s.selectedSeller===sel.name);
    if (dup) { updateQty(dup.id, dup.quantity+1); }
    else {
      const u=[...shoppingList,{id:uid(),itemId:item.id,itemName:item.name,unit:item.unit,upc:item.upc||'',
        selectedSeller:sel.name,price:sel.price,quantity:1,sellers:sellerList}];
      setShoppingList(u); save('shoppingList',u);
    }
    setSearch(''); setShowDrop(false);
  }

  function updateQty(id, raw) {
    const n=parseFloat(raw);
    if (isNaN(n)||n<0) return;
    const u=shoppingList.map(s=>s.id===id?{...s,quantity:n}:s);
    setShoppingList(u); save('shoppingList',u);
  }

  function changeSeller(id, name) {
    const e=shoppingList.find(s=>s.id===id);
    const sel=(e.sellers||[]).find(s=>s.name===name);
    const u=shoppingList.map(s=>s.id===id?{...s,selectedSeller:name,price:sel?.price??null}:s);
    setShoppingList(u); save('shoppingList',u);
  }

  function removeItem(id) { const u=shoppingList.filter(s=>s.id!==id); setShoppingList(u); save('shoppingList',u); }

  function clearAll() {
    setShowClearListConfirm(true);
  }
  function confirmClearAll() {
    setShowClearListConfirm(false);
    setShoppingList([]); save('shoppingList',[]);
  }

  const grandTotal = useMemo(()=>shoppingList.reduce((s,e)=>s+safeQty(e.quantity)*(e.price??0),0),[shoppingList]);

  function exportXlsx() {
    if (!shoppingList.length) { showToast('Shopping list is empty.', 'error'); return; }
    try {
      const header = ['Item', 'UPC', 'Seller', 'Quantity', 'Unit', 'Unit Price', 'Total'];
      const dataRows = shoppingList.map((s) => {
        const upc = upcForEntry(s);
        const qty = safeQty(s.quantity);
        const unitPrice = s.price != null && Number.isFinite(Number(s.price)) ? +Number(s.price).toFixed(2) : '';
        const lineTotal =
          s.price != null && Number.isFinite(Number(s.price)) ? +(qty * Number(s.price)).toFixed(2) : '';
        return [s.itemName, upc, s.selectedSeller || '', qty, s.unit || '', unitPrice, lineTotal];
      });
      const grand = +grandTotal.toFixed(2);
      const aoa = [header, ...dataRows, ['', '', '', '', '', 'GRAND TOTAL', grand]];
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Shopping List');
      XLSX.writeFile(wb, 'shopping-list-' + today() + '.xlsx');
      showToast('Shopping list exported as Excel.');
      logActivity('export_xlsx', 'Exported shopping list Excel');
    } catch (e) {
      reportError('DMG-E041', { phase: 'shopping_xlsx', message: String(e?.message || e) });
      showToast('Excel export failed (DMG-E041). Try CSV export or retry.', 'error');
    }
  }

  function exportCsv() {
    if (!shoppingList.length) { showToast('Shopping list is empty.', 'error'); return; }
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = shoppingList.map(s => [
      s.itemName,
      upcForEntry(s),
      s.selectedSeller || '',
      safeQty(s.quantity),
      s.unit || '',
      (s.price ?? 0).toFixed(2),
      (safeQty(s.quantity) * (s.price ?? 0)).toFixed(2),
      s.notes || ''
    ]);
    const csv = [
      ['Item Name','UPC','Seller','Quantity','Unit','Unit Price','Total','Notes'].map(esc).join(','),
      ...rows.map(r => r.map(esc).join(','))
    ].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'shopping-list-' + today() + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('Shopping list exported as CSV.');
    logActivity('export_csv', 'Exported shopping list CSV');
  }

  return (
    <div>
      <div className="flex-between mb-4 flex-wrap gap-2">
        <div className="section-title" style={{margin:0}}>Shopping List ({shoppingList.length})</div>
        <div className="flex gap-2 flex-wrap">
          <Btn className="btn-outline" onClick={exportCsv}>⬇ Export CSV</Btn>
          <Btn className="btn-success" onClick={exportXlsx}>⬇ Export Excel</Btn>
          <Btn className="btn-danger" onClick={clearAll}>🗑 Clear All</Btn>
        </div>
      </div>
      {shoppingList.length > 0 && (
        <p className="text-muted" style={{marginTop:-8,marginBottom:12}}>Tip: Drag the ⋮⋮ handle on the left to reorder rows. Order is saved automatically.</p>
      )}

      <div className="card mb-4" style={{position:'relative',overflow:'visible'}}>
        <label>Search &amp; Add Items</label>
        <input className="input" placeholder="Type item name to search…" value={search}
          onChange={e=>{setSearch(e.target.value);setShowDrop(true);}}
          onFocus={()=>setShowDrop(true)} onBlur={()=>setTimeout(()=>setShowDrop(false),180)} />
        {showDrop && results.length>0 && (
          <div style={{position:'absolute',top:'100%',left:0,right:0,background:'white',border:'1.5px solid var(--border)',
            borderRadius:'0 0 6px 6px',boxShadow:'0 8px 24px rgba(0,0,0,.15)',zIndex:300}}>
            {results.map(item=>(
              <div key={item.id} onMouseDown={()=>addItem(item)}
                style={{padding:'10px 16px',cursor:'pointer',borderBottom:'1px solid #f5ead5',fontSize:14}}>
                <strong>{item.name}</strong>
                <span style={{color:'#999',fontSize:12,marginLeft:8}}>({item.category} · {item.unit})</span>
                {item.sellers[0]?.price!=null&&<span style={{color:'var(--brown)',float:'right',fontSize:12,fontWeight:600}}>{fmt$(item.sellers[0].price)}/{item.unit}</span>}
              </div>
            ))}
          </div>
        )}
        {showDrop&&search.trim()&&results.length===0&&(
          <div style={{position:'absolute',top:'100%',left:0,right:0,background:'white',border:'1.5px solid var(--border)',
            borderRadius:'0 0 6px 6px',padding:'12px 16px',color:'#aaa',fontSize:14}}>
            No items found. Add it in the Item Database tab first.
          </div>
        )}
      </div>

      {shoppingList.length===0
        ? <div className="card empty-state">Search for an item above and click to add it to your shopping list.</div>
        : (
          <>
            <div className="card" style={{padding:0}}>
              <div className="tbl-wrap">
                <table>
                  <thead><tr><th title="Drag to reorder" aria-label="Reorder" style={{width:36}}>⋮⋮</th><th>Item</th><th>UPC</th><th>Seller</th><th>Qty</th><th>Unit</th><th>Unit Price</th><th>Total</th><th></th></tr></thead>
                  <tbody>
                    {shoppingList.map((e, idx)=>{
                      const lt=safeQty(e.quantity)*(e.price??0);
                      const upcDisp = upcForEntry(e);
                      return (
                        <tr
                          key={e.id}
                          style={{
                            opacity: dragFromIdx === idx ? 0.55 : 1,
                            boxShadow: dragOverIdx === idx && dragFromIdx !== idx ? 'inset 0 0 0 2px var(--brown)' : undefined,
                            transition: 'opacity .12s ease'
                          }}
                          onDragOver={(ev) => {
                            ev.preventDefault();
                            ev.dataTransfer.dropEffect = 'move';
                            setDragOverIdx(idx);
                          }}
                          onDragLeave={(ev) => {
                            if (!ev.currentTarget.contains(ev.relatedTarget)) setDragOverIdx(null);
                          }}
                          onDrop={(ev) => {
                            ev.preventDefault();
                            const from = Number(ev.dataTransfer.getData('text/plain'));
                            if (Number.isNaN(from)) return;
                            reorderRows(from, idx);
                            setDragFromIdx(null);
                            setDragOverIdx(null);
                          }}
                        >
                          <td
                            className="shopping-drag-handle"
                            title="Drag to reorder"
                            draggable
                            onDragStart={(ev) => {
                              ev.dataTransfer.setData('text/plain', String(idx));
                              ev.dataTransfer.effectAllowed = 'move';
                              setDragFromIdx(idx);
                            }}
                            onDragEnd={() => { setDragFromIdx(null); setDragOverIdx(null); }}
                          >⋮⋮</td>
                          <td style={{fontWeight:600}}>{e.itemName}</td>
                          <td style={{fontFamily:'monospace',fontSize:12,color:upcDisp==='NOT-LISTED'?'#999':'#333'}}>{upcDisp}</td>
                          <td>
                            {(e.sellers||[]).length>1
                              ?<select className="input" style={{padding:'3px 6px',width:'auto',fontSize:13}} value={e.selectedSeller} onChange={ev=>changeSeller(e.id,ev.target.value)}>
                                {(e.sellers||[]).map(s=><option key={s.name} value={s.name}>{s.name}{s.price!=null?' ('+fmt$(s.price)+')':''}</option>)}
                              </select>
                              :<span>{e.selectedSeller||'—'}</span>}
                          </td>
                          <td>
                            <input type="number" className="input" style={{width:80,padding:'4px 8px'}} min="0" step="0.5"
                              value={e.quantity} onChange={ev=>updateQty(e.id,ev.target.value)} />
                          </td>
                          <td>{e.unit}</td>
                          <td>{e.price!=null?fmt$(e.price):<span style={{color:'#bbb'}}>—</span>}</td>
                          <td style={{fontWeight:600,color:'var(--brown)'}}>{e.price!=null?fmt$(lt):'—'}</td>
                          <td><Btn className="btn-danger btn-sm" onClick={()=>removeItem(e.id)}>✕</Btn></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="card" style={{textAlign:'right'}}>
              <span style={{fontSize:13,color:'#888',marginRight:16}}>{shoppingList.length} item{shoppingList.length!==1?'s':''}</span>
              <span style={{fontSize:20,fontWeight:700,color:'var(--brown)'}}>Total: {fmt$(grandTotal)}</span>
            </div>
          </>
        )
      }
      <Confirm
        open={showClearListConfirm}
        title="Clear shopping list?"
        message="Remove every line from the shopping list on this device."
        detail="You can rebuild the list from the Item Database. This only affects the shopping list, not invoices or inventory."
        dangerCode="DMG-E012 (local data change)"
        confirmLabel="Clear list"
        confirmClass="btn-danger"
        onConfirm={confirmClearAll}
        onCancel={() => setShowClearListConfirm(false)}
      />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// TAB 3 — PURCHASE INVOICES
// ═══════════════════════════════════════════════════════════
function PurchaseInvoices({ purchaseInvoices, setPurchaseInvoices, selectedBusiness, items = [], brandingMap }) {
  const biz = BUSINESSES[selectedBusiness];
  const blankF = () => ({supplier:'',date:today(),taxEnabled:false,notes:'',
    payment:{account:'',date:'',transactionId:''},
    lineItems:[{description:'',quantity:'',unit:'each',unitPrice:''}]});

  const descListId = useId();
  const unitLineListId = useId();

  const supplierSuggestions = useMemo(()=>uniqSuggestions(...purchaseInvoices.map(i=>i.supplier)),[purchaseInvoices]);
  const lineDescSuggestions = useMemo(()=>{
    const fromInv = purchaseInvoices.flatMap(i=>(i.lineItems||[]).map(l=>(l.description||'').trim()).filter(Boolean));
    const names = items.map(i=>i.name);
    return uniqSuggestions(...fromInv, ...names);
  },[purchaseInvoices, items]);
  const lineUnitSuggestions = useMemo(()=>uniqSuggestions(
    ...purchaseInvoices.flatMap(i=>(i.lineItems||[]).map(l=>l.unit).filter(Boolean)),
    ...items.map(i=>i.unit)
  ),[purchaseInvoices, items]);

  const [showForm, setShowForm] = useState(false);
  const [editingPurchaseId, setEditingPurchaseId] = useState(null);
  const [form, setForm] = useState(blankF());
  const [viewInv, setViewInv] = useState(null);
  const [confirmId, setConfirmId] = useState(null);

  function setLine(i,f2,v){setForm(f=>{const l=[...f.lineItems];l[i]={...l[i],[f2]:v};return{...f,lineItems:l};});}

  function calcT(f,taxRate){
    const lines=f.lineItems.map(l=>{const q=safeQty(l.quantity),p=parseFloat(l.unitPrice)||0;return{...l,qty:q,price:p,total:q*p};});
    const sub=lines.reduce((s,l)=>s+l.total,0);
    const tax=f.taxEnabled?sub*taxRate:0;
    return{lines,sub,tax,total:sub+tax};
  }

  const T=calcT(form,biz.taxRate);

  const pendingDeletePurchase = useMemo(
    () => (confirmId ? purchaseInvoices.find((i) => i.id === confirmId) : null),
    [confirmId, purchaseInvoices]
  );

  function openPurchaseEdit(inv) {
    const lines = (inv.lineItems && inv.lineItems.length ? inv.lineItems : [{ description:'', quantity:'', unit:'each', unitPrice:'' }]).map((l) => ({
      description: l.description || '',
      quantity: String(l.qty ?? l.quantity ?? ''),
      unit: l.unit || 'each',
      unitPrice: String(l.price ?? l.unitPrice ?? ''),
    }));
    setForm({
      supplier: inv.supplier || '',
      date: inv.date || today(),
      taxEnabled: !!inv.taxEnabled,
      notes: inv.notes || '',
      payment: {
        account: inv.payment?.account || '',
        date: inv.payment?.date || '',
        transactionId: inv.payment?.transactionId || '',
      },
      lineItems: lines,
    });
    setEditingPurchaseId(inv.id);
    setShowForm(true);
  }

  function saveInvoice(){
    if (!form.supplier.trim()){showToast('Supplier name is required.','error');return;}
    const valid=T.lines.filter(l=>l.description.trim());
    if (!valid.length){showToast('Add at least one line item with a description.','error');return;}
    if (editingPurchaseId) {
      const prev = purchaseInvoices.find((i) => i.id === editingPurchaseId);
      if (!prev) { showToast('Invoice not found.', 'error'); return; }
      const inv = {
        ...prev,
        supplier: form.supplier,
        date: form.date,
        notes: form.notes,
        lineItems: valid,
        subtotal: T.sub,
        taxEnabled: form.taxEnabled,
        taxRate: biz.taxRate,
        taxAmount: T.tax,
        total: T.total,
        payment: { ...form.payment },
      };
      const u = purchaseInvoices.map((x) => (x.id === editingPurchaseId ? inv : x));
      setPurchaseInvoices(u);
      save('purchaseInvoices', u);
      setShowForm(false);
      setForm(blankF());
      setEditingPurchaseId(null);
      showToast('Purchase invoice updated.');
      logActivity('edit_item', 'Updated purchase invoice ' + inv.id);
      return;
    }
    const inv={id:nextId('purchase'),type:'purchase',business:selectedBusiness,
      supplier:form.supplier,date:form.date,notes:form.notes,
      lineItems:valid,subtotal:T.sub,taxEnabled:form.taxEnabled,taxRate:biz.taxRate,taxAmount:T.tax,
      total:T.total,status:'unpaid',payment:{...form.payment},createdAt:today()};
    const u=[...purchaseInvoices,inv]; setPurchaseInvoices(u); save('purchaseInvoices',u);
    setShowForm(false); setForm(blankF());
    showToast('Purchase invoice created.');
    logActivity('create_invoice', 'Created purchase invoice ' + inv.id);
  }

  function deleteInv(id){const u=purchaseInvoices.filter(x=>x.id!==id);setPurchaseInvoices(u);save('purchaseInvoices',u);setConfirmId(null);showToast('Purchase invoice deleted.');logActivity('delete_invoice','Deleted purchase invoice '+id);}
  function markPaid(id){const u=purchaseInvoices.map(x=>x.id===id?{...x,status:'paid'}:x);setPurchaseInvoices(u);save('purchaseInvoices',u);showToast('Purchase invoice marked paid.');logActivity('mark_paid','Marked purchase invoice paid '+id);}

  return (
    <div>
      <div className="flex-between mb-4 flex-wrap gap-2">
        <div className="section-title" style={{margin:0}}>Purchase Invoices</div>
        <Btn className="btn-primary" onClick={()=>{setEditingPurchaseId(null);setForm(blankF());setShowForm(true);}}>+ New Invoice</Btn>
      </div>

      {purchaseInvoices.length===0
        ? <div className="card empty-state">No purchase invoices yet. Click "+ New Invoice" to create one.</div>
        : (
          <div className="card" style={{padding:0}}>
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>Invoice #</th><th>Supplier</th><th>Date</th><th>Business</th><th>Total</th><th>Status</th><th>Actions</th></tr></thead>
                <tbody>
                  {[...purchaseInvoices].reverse().map(inv=>(
                    <tr key={inv.id}>
                      <td style={{fontFamily:'monospace',fontWeight:700}}>{inv.id}</td>
                      <td style={{fontWeight:600}}>{inv.supplier}</td>
                      <td>{fmtDate(inv.date)}</td>
                      <td style={{fontSize:12,color:'#777'}}>{inv._type==='transfer'?'P&P Internal Transfer':BUSINESSES[inv.business]?.name}</td>
                      <td style={{fontWeight:600}}>{fmt$(inv.total)}</td>
                      <td><span className={`badge badge-${inv.status}`}>{inv.status}</span></td>
                      <td style={{whiteSpace:'nowrap'}}>
                        <Btn className="btn-secondary btn-sm" style={{marginRight:4}} onClick={()=>setViewInv(inv)}>View</Btn>
                        <Btn className="btn-outline btn-sm" style={{marginRight:4}} onClick={()=>openPurchaseEdit(inv)}>Edit</Btn>
                        {inv.status!=='paid'&&<Btn className="btn-success btn-sm" style={{marginRight:4}} onClick={()=>markPaid(inv.id)}>Mark Paid</Btn>}
                        <Btn className="btn-danger btn-sm" onClick={()=>setConfirmId(inv.id)}>Delete</Btn>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      }

      <Modal open={showForm} onClose={()=>{setShowForm(false);setEditingPurchaseId(null);}} title={editingPurchaseId ? `Edit Purchase Invoice ${editingPurchaseId}` : 'New Purchase Invoice'} wide>
        <div className="grid-2">
          <FI label="Supplier Name *" value={form.supplier} onChange={e=>setForm(f=>({...f,supplier:e.target.value}))} placeholder="Sysco, US Foods…" suggestions={supplierSuggestions} />
          <FI label="Invoice Date" type="date" value={form.date} onChange={e=>setForm(f=>({...f,date:e.target.value}))} />
        </div>
        <datalist id={descListId}>
          {lineDescSuggestions.map(s => <option key={s} value={s} />)}
        </datalist>
        <datalist id={unitLineListId}>
          {lineUnitSuggestions.map(s => <option key={s} value={s} />)}
        </datalist>
        <div style={{marginBottom:14}}>
          <div className="flex-between mb-2">
            <label style={{margin:0}}>Line Items</label>
            <Btn className="btn-outline btn-sm" onClick={()=>setForm(f=>({...f,lineItems:[...f.lineItems,{description:'',quantity:'',unit:'each',unitPrice:''}]}))}>+ Add Line</Btn>
          </div>
          {form.lineItems.map((l,i)=>(
            <div key={i} className="flex gap-2 mb-2" style={{alignItems:'center',flexWrap:'wrap'}}>
              <input className="input" placeholder="Description *" value={l.description} onChange={e=>setLine(i,'description',e.target.value)} style={{flex:'3 1 160px'}} list={descListId} />
              <input className="input" placeholder="Qty" type="number" min="0" step="0.01" value={l.quantity} onChange={e=>setLine(i,'quantity',e.target.value)} style={{flex:'1 1 60px'}} />
              <input className="input" placeholder="Unit" value={l.unit} onChange={e=>setLine(i,'unit',e.target.value)} style={{flex:'1 1 60px'}} list={unitLineListId} />
              <input className="input" placeholder="Unit $" type="number" min="0" step="0.01" value={l.unitPrice} onChange={e=>setLine(i,'unitPrice',e.target.value)} style={{flex:'1 1 70px'}} />
              <span style={{minWidth:64,textAlign:'right',fontSize:13,color:'var(--brown)',fontWeight:600}}>{fmt$(T.lines[i]?.total||0)}</span>
              <Btn className="btn-danger btn-sm" onClick={()=>setForm(f=>({...f,lineItems:f.lineItems.filter((_,x)=>x!==i)}))}>✕</Btn>
            </div>
          ))}
        </div>
        <div style={{background:'var(--cream)',padding:14,borderRadius:8,marginBottom:14}}>
          <div className="flex-between mb-2"><span>Subtotal</span><strong>{fmt$(T.sub)}</strong></div>
          <div className="flex-between mb-2">
            <Toggle checked={form.taxEnabled} onChange={v=>setForm(f=>({...f,taxEnabled:v}))} label={`Tax (${(biz.taxRate*100).toFixed(3)}%)`} />
            <span style={{color:form.taxEnabled?'var(--brown)':'#bbb'}}>{fmt$(T.tax)}</span>
          </div>
          <hr className="divider" />
          <div className="flex-between"><strong style={{fontSize:16}}>Total</strong><strong style={{fontSize:19,color:'var(--brown)'}}>{fmt$(T.total)}</strong></div>
        </div>
        <div style={{padding:14,border:'1px solid #EED9B0',borderRadius:8,marginBottom:14}}>
          <div style={{fontWeight:700,color:'var(--brown)',marginBottom:10,fontSize:14}}>Payment Information</div>
          <div className="grid-3">
            <FI label="Account #" value={form.payment.account} onChange={e=>setForm(f=>({...f,payment:{...f.payment,account:e.target.value}}))} placeholder="Optional" />
            <FI label="Payment Date" type="date" value={form.payment.date} onChange={e=>setForm(f=>({...f,payment:{...f.payment,date:e.target.value}}))} />
            <FI label="Transaction ID" value={form.payment.transactionId} onChange={e=>setForm(f=>({...f,payment:{...f.payment,transactionId:e.target.value}}))} placeholder="Optional" />
          </div>
        </div>
        <div className="field"><label>Notes</label><textarea className="input" rows={2} value={form.notes} onChange={e=>setForm(f=>({...f,notes:e.target.value}))} /></div>
        <div className="flex gap-2" style={{justifyContent:'flex-end',marginTop:8}}>
          <Btn className="btn-outline" onClick={()=>{setShowForm(false);setEditingPurchaseId(null);}}>Cancel</Btn>
          <Btn className="btn-primary" onClick={saveInvoice}>{editingPurchaseId ? 'Save Changes' : 'Create Invoice'}</Btn>
        </div>
      </Modal>

      <Modal open={!!viewInv} onClose={()=>setViewInv(null)} title={`Invoice ${viewInv?.id||''}`} wide closeOnBackdrop>
        {viewInv&&(
          <div id={`purchase-view-${viewInv.id}`}>
            <div className="flex-between mb-4" style={{flexWrap:'wrap',gap:8}}>
              <div style={{display:'flex',alignItems:'center',gap:10}}>
                <BrandMark brand={getInvoiceBranding(viewInv, brandingMap)} />
                <div><div style={{fontWeight:700,fontSize:17,color:'var(--brown)'}}>{getInvoiceBranding(viewInv, brandingMap).name}</div><div style={{fontSize:13,color:'#888'}}>{getInvoiceBranding(viewInv, brandingMap).location}</div></div>
              </div>
              <div style={{textAlign:'right',fontSize:13}}><div><strong>Invoice #:</strong> {viewInv.id}</div><div><strong>Date:</strong> {fmtDate(viewInv.date)}</div><div><strong>Supplier:</strong> {viewInv.supplier}</div></div>
            </div>
            <div className="tbl-wrap" style={{marginBottom:14}}>
              <table><thead><tr><th>Description</th><th>Qty</th><th>Unit</th><th>Unit Price</th><th>Total</th></tr></thead>
                <tbody>{viewInv.lineItems.map((l,i)=><tr key={i}><td>{l.description}</td><td>{l.qty??l.quantity}</td><td>{l.unit}</td><td>{fmt$(l.price??l.unitPrice)}</td><td style={{fontWeight:600}}>{fmt$(l.total)}</td></tr>)}</tbody>
              </table>
            </div>
            <div style={{textAlign:'right'}}>
              <div>Subtotal: {fmt$(viewInv.subtotal)}</div>
              {viewInv.taxEnabled&&<div>Tax ({(viewInv.taxRate*100).toFixed(3)}%): {fmt$(viewInv.taxAmount)}</div>}
              <div style={{fontWeight:700,fontSize:18,color:'var(--brown)',marginTop:6}}>Total: {fmt$(viewInv.total)}</div>
            </div>
            {(viewInv.payment?.account||viewInv.payment?.transactionId||viewInv.payment?.date)&&(
              <div style={{marginTop:14,padding:12,background:'var(--cream)',borderRadius:6,fontSize:13}}>
                <strong>Payment: </strong>{viewInv.payment.account&&`Account: ${viewInv.payment.account}  `}{viewInv.payment.date&&`Date: ${fmtDate(viewInv.payment.date)}  `}{viewInv.payment.transactionId&&`Txn: ${viewInv.payment.transactionId}`}
              </div>
            )}
            <div className="flex gap-2" style={{justifyContent:'flex-end',marginTop:16}}>
              <Btn className="btn-outline" onClick={()=>printInvoiceById(`purchase-view-${viewInv.id}`)}>🖨 Print / Save PDF</Btn>
              <Btn className="btn-secondary" onClick={()=>{const v=viewInv; setViewInv(null); openPurchaseEdit(v);}}>Edit</Btn>
              <Btn className="btn-primary" onClick={()=>setViewInv(null)}>Close</Btn>
            </div>
          </div>
        )}
      </Modal>

      <Confirm
        open={!!confirmId}
        title="Delete purchase invoice?"
        message={
          pendingDeletePurchase
            ? `Permanently remove invoice ${pendingDeletePurchase.id} (${pendingDeletePurchase.supplier || 'supplier'}) on this device?`
            : 'Permanently remove this purchase invoice on this device?'
        }
        detail="This cannot be undone here. Export a backup from Settings if you might need to recover this record."
        dangerCode="DMG-E012 (local data change)"
        confirmLabel="Delete invoice"
        onConfirm={() => deleteInv(confirmId)}
        onCancel={() => setConfirmId(null)}
      />
    </div>
  );
}
// ═══════════════════════════════════════════════════════════
function CateringInvoices({ cateringInvoices, setCateringInvoices, customers, setCustomers, selectedBusiness, userRole, items = [], brandingMap }) {
  const isAdmin = userRole==='admin';
  const blankF = () => ({
    customerId:'',customerName:'',customerPhone:'',customerEmail:'',
    useRange:false,date:today(),dateStart:today(),dateEnd:today(),
    eventType:'Catering',business:selectedBusiness,
    lineItems:[{description:'',quantity:'1',unitPrice:''}],
    ccFeeEnabled:false,taxEnabled:true,deposit:'',notes:''
  });
  const caterDescListId = useId();
  const eventTypeSuggestions = useMemo(()=>uniqSuggestions(
    ...cateringInvoices.map(i=>(i.eventType||'').trim()).filter(Boolean)
  ),[cateringInvoices]);
  const caterLineDescSuggestions = useMemo(()=>{
    const fromInv = cateringInvoices.flatMap(i=>(i.lineItems||[]).map(l=>(l.description||'').trim()).filter(Boolean));
    const names = items.map(i=>i.name);
    return uniqSuggestions(...fromInv, ...names);
  },[cateringInvoices, items]);
  const [showForm, setShowForm] = useState(false);
  const [editingCateringId, setEditingCateringId] = useState(null);
  const [form, setForm] = useState(blankF());
  const [viewInv, setViewInv] = useState(null);
  const [confirmId, setConfirmId] = useState(null);

  function setLine(i,f2,v){setForm(f=>{const l=[...f.lineItems];l[i]={...l[i],[f2]:v};return{...f,lineItems:l};});}
  function selCust(id){const c=customers.find(x=>x.id===id);if(c)setForm(f=>({...f,customerId:c.id,customerName:c.name,customerPhone:c.phone,customerEmail:c.email}));else setForm(f=>({...f,customerId:'',customerName:'',customerPhone:'',customerEmail:''}));}

  function calcT(){
    const fb=BUSINESSES[form.business]||BUSINESSES[selectedBusiness];
    const lines=form.lineItems.map(l=>{const q=safeQty(l.quantity),p=parseFloat(l.unitPrice)||0;return{...l,qty:q,price:p,total:q*p};});
    const sub=lines.reduce((s,l)=>s+l.total,0);
    const cc=form.ccFeeEnabled?sub*0.035:0;
    const taxBase=sub+cc;
    const taxAmt=form.taxEnabled?taxBase*fb.taxRate:0;
    const grand=taxBase+taxAmt;
    const dep=Math.max(0,parseFloat(form.deposit)||0);
    return{lines,sub,cc,taxAmt,grand,dep,balance:grand-dep,fb};
  }
  const T=calcT();

  const pendingDeleteCatering = useMemo(
    () => (confirmId ? cateringInvoices.find((i) => i.id === confirmId) : null),
    [confirmId, cateringInvoices]
  );

  function openCateringEdit(inv) {
    const lines = (inv.lineItems && inv.lineItems.length ? inv.lineItems : [{ description:'', quantity:'1', unitPrice:'' }]).map((l) => ({
      description: l.description || '',
      quantity: String(l.qty ?? l.quantity ?? '1'),
      unitPrice: String(l.price ?? l.unitPrice ?? ''),
    }));
    setForm({
      customerId: inv.customerId || '',
      customerName: inv.customerName || '',
      customerPhone: inv.customerPhone || '',
      customerEmail: inv.customerEmail || '',
      useRange: !!inv.useRange,
      date: inv.date || today(),
      dateStart: inv.dateStart || today(),
      dateEnd: inv.dateEnd || today(),
      eventType: inv.eventType || 'Catering',
      business: inv.business || selectedBusiness,
      lineItems: lines,
      ccFeeEnabled: !!inv.ccFeeEnabled,
      taxEnabled: inv.taxEnabled !== false,
      deposit: inv.deposit != null && inv.deposit !== '' ? String(inv.deposit) : '',
      notes: inv.notes || '',
    });
    setEditingCateringId(inv.id);
    setShowForm(true);
  }

  function saveInvoice(){
    if (!form.customerName.trim()){showToast('Customer name is required.','error');return;}
    const valid=T.lines.filter(l=>l.description.trim());
    if (!valid.length){showToast('Add at least one line item with a description.','error');return;}
    if (T.dep<0){showToast('Deposit cannot be negative.','error');return;}
    let custId=form.customerId;
    if (!custId&&form.customerName.trim()){
      const nc={id:uid(),name:form.customerName,phone:form.customerPhone,email:form.customerEmail,address:'',notes:'',createdAt:today()};
      const uc=[...customers,nc];setCustomers(uc);save('customers',uc);custId=nc.id;
    }
    const status=T.dep>=T.grand?'paid':T.dep>0?'partial':'unpaid';
    if (editingCateringId) {
      const prev = cateringInvoices.find((i) => i.id === editingCateringId);
      if (!prev) { showToast('Invoice not found.', 'error'); return; }
      const inv={
        ...prev,
        customerId:custId,customerName:form.customerName,customerPhone:form.customerPhone,customerEmail:form.customerEmail,
        useRange:form.useRange,date:form.useRange?null:form.date,dateStart:form.useRange?form.dateStart:null,dateEnd:form.useRange?form.dateEnd:null,
        eventType:form.eventType,lineItems:valid,subtotal:T.sub,
        ccFeeEnabled:form.ccFeeEnabled,ccFee:T.cc,taxEnabled:form.taxEnabled,taxRate:T.fb.taxRate,taxAmount:T.taxAmt,
        grandTotal:T.grand,deposit:T.dep,balanceDue:T.balance,status,notes:form.notes,business:form.business||selectedBusiness
      };
      const u=cateringInvoices.map(x=>x.id===editingCateringId?inv:x);
      setCateringInvoices(u);save('cateringInvoices',u);
      setShowForm(false);setForm(blankF());setEditingCateringId(null);
      showToast('Catering invoice updated.');
      logActivity('edit_item', 'Updated catering invoice ' + inv.id);
      return;
    }
    const inv={
      id:nextId('catering'),type:'catering',business:form.business||selectedBusiness,
      customerId:custId,customerName:form.customerName,customerPhone:form.customerPhone,customerEmail:form.customerEmail,
      useRange:form.useRange,date:form.useRange?null:form.date,dateStart:form.useRange?form.dateStart:null,dateEnd:form.useRange?form.dateEnd:null,
      eventType:form.eventType,lineItems:valid,subtotal:T.sub,
      ccFeeEnabled:form.ccFeeEnabled,ccFee:T.cc,taxEnabled:form.taxEnabled,taxRate:T.fb.taxRate,taxAmount:T.taxAmt,
      grandTotal:T.grand,deposit:T.dep,balanceDue:T.balance,status,notes:form.notes,createdAt:today()
    };
    const u=[...cateringInvoices,inv];setCateringInvoices(u);save('cateringInvoices',u);
    setShowForm(false);setForm(blankF());
    showToast('Catering invoice created.');
    logActivity('create_invoice', 'Created catering invoice ' + inv.id);
  }

  function deleteInv(id){const u=cateringInvoices.filter(x=>x.id!==id);setCateringInvoices(u);save('cateringInvoices',u);setConfirmId(null);showToast('Catering invoice deleted.');logActivity('delete_invoice','Deleted catering invoice '+id);}
  function markPaid(id){const u=cateringInvoices.map(x=>x.id===id?{...x,status:'paid',deposit:x.grandTotal,balanceDue:0}:x);setCateringInvoices(u);save('cateringInvoices',u);showToast('Catering invoice marked paid.');logActivity('mark_paid','Marked catering invoice paid '+id);}

  return (
    <div>
      <div className="flex-between mb-4 flex-wrap gap-2">
        <div className="section-title" style={{margin:0}}>Catering Invoices</div>
        <Btn className="btn-primary" onClick={()=>{setEditingCateringId(null);setForm(blankF());setShowForm(true);}}>+ New Invoice</Btn>
      </div>

      {cateringInvoices.length===0
        ? <div className="card empty-state">No catering invoices yet. Click "+ New Invoice" to create one.</div>
        : (
          <div className="card" style={{padding:0}}>
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>Invoice #</th><th>Customer</th><th>Event Date</th><th>Event</th><th>Total</th><th>Balance Due</th><th>Status</th><th>Actions</th></tr></thead>
                <tbody>
                  {[...cateringInvoices].reverse().map(inv=>(
                    <tr key={inv.id}>
                      <td style={{fontFamily:'monospace',fontWeight:700}}>{inv.id}</td>
                      <td style={{fontWeight:600}}>{inv.customerName}</td>
                      <td style={{fontSize:12}}>{inv.useRange?`${fmtDate(inv.dateStart)} – ${fmtDate(inv.dateEnd)}`:fmtDate(inv.date)}</td>
                      <td>{inv.eventType}</td>
                      <td style={{fontWeight:600}}>{fmt$(inv.grandTotal)}</td>
                      <td style={{fontWeight:600,color:inv.balanceDue>0?'var(--danger)':'var(--success)'}}>{fmt$(inv.balanceDue)}</td>
                      <td><span className={`badge badge-${inv.status}`}>{inv.status}</span></td>
                      <td style={{whiteSpace:'nowrap'}}>
                        <Btn className="btn-secondary btn-sm" style={{marginRight:4}} onClick={()=>setViewInv(inv)}>View</Btn>
                        <Btn className="btn-outline btn-sm" style={{marginRight:4}} onClick={()=>openCateringEdit(inv)}>Edit</Btn>
                        {inv.status!=='paid'&&<Btn className="btn-success btn-sm" style={{marginRight:4}} onClick={()=>markPaid(inv.id)}>Paid</Btn>}
                        {isAdmin&&<Btn className="btn-danger btn-sm" onClick={()=>setConfirmId(inv.id)}>Delete</Btn>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      }

      {/* Create Form */}
      <Modal open={showForm} onClose={()=>{setShowForm(false);setEditingCateringId(null);}} title={editingCateringId ? `Edit Catering Invoice ${editingCateringId}` : 'New Catering Invoice'} wide>
        <div style={{fontWeight:700,color:'var(--brown)',marginBottom:8,fontSize:14}}>Customer</div>
        <div className="grid-2 mb-2">
          <FS label="Existing Customer" value={form.customerId} onChange={e=>selCust(e.target.value)}>
            <option value="">— New Customer —</option>
            {customers.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
          </FS>
          <FI label="Customer Name *" value={form.customerName} onChange={e=>setForm(f=>({...f,customerName:e.target.value,customerId:''}))} placeholder="Full name" />
        </div>
        <div className="grid-2 mb-4">
          <FI label="Phone" value={form.customerPhone} onChange={e=>setForm(f=>({...f,customerPhone:e.target.value}))} />
          <FI label="Email" type="email" value={form.customerEmail} onChange={e=>setForm(f=>({...f,customerEmail:e.target.value}))} />
        </div>

        <div style={{fontWeight:700,color:'var(--brown)',marginBottom:8,fontSize:14}}>Event Details</div>
        <div className="grid-2 mb-3">
          <FI label="Event Type" value={form.eventType} onChange={e=>setForm(f=>({...f,eventType:e.target.value}))} placeholder="Wedding, Corporate, Birthday…" suggestions={eventTypeSuggestions} />
          <FS label="Business Entity" value={form.business} onChange={e=>setForm(f=>({...f,business:e.target.value}))}>
            {Object.entries(BUSINESSES).map(([k,v])=><option key={k} value={k}>{v.name}</option>)}
          </FS>
        </div>
        <div className="mb-4">
          <div className="mb-2"><Toggle checked={form.useRange} onChange={v=>setForm(f=>({...f,useRange:v}))} label="Date range (multi-day event)" /></div>
          <div className="grid-2">
            {form.useRange
              ?<><FI label="Start Date" type="date" value={form.dateStart} onChange={e=>setForm(f=>({...f,dateStart:e.target.value}))} /><FI label="End Date" type="date" value={form.dateEnd} onChange={e=>setForm(f=>({...f,dateEnd:e.target.value}))} /></>
              :<FI label="Event Date" type="date" value={form.date} onChange={e=>setForm(f=>({...f,date:e.target.value}))} />}
          </div>
        </div>

        <datalist id={caterDescListId}>
          {caterLineDescSuggestions.map(s => <option key={s} value={s} />)}
        </datalist>
        <div style={{fontWeight:700,color:'var(--brown)',marginBottom:8,fontSize:14}}>Line Items</div>
        <div className="mb-3">
          {form.lineItems.map((l,i)=>(
            <div key={i} className="flex gap-2 mb-2" style={{alignItems:'center',flexWrap:'wrap'}}>
              <input className="input" placeholder="Description" value={l.description} onChange={e=>setLine(i,'description',e.target.value)} style={{flex:'4 1 180px'}} list={caterDescListId} />
              <input className="input" placeholder="Qty" type="number" min="0" step="0.01" value={l.quantity} onChange={e=>setLine(i,'quantity',e.target.value)} style={{flex:'1 1 60px'}} />
              <input className="input" placeholder="Unit Price" type="number" min="0" step="0.01" value={l.unitPrice} onChange={e=>setLine(i,'unitPrice',e.target.value)} style={{flex:'1 1 80px'}} />
              <span style={{minWidth:64,textAlign:'right',fontSize:13,color:'var(--brown)',fontWeight:600}}>{fmt$(T.lines[i]?.total||0)}</span>
              {form.lineItems.length>1&&<Btn className="btn-danger btn-sm" onClick={()=>setForm(f=>({...f,lineItems:f.lineItems.filter((_,x)=>x!==i)}))}>✕</Btn>}
            </div>
          ))}
          <Btn className="btn-outline btn-sm" onClick={()=>setForm(f=>({...f,lineItems:[...f.lineItems,{description:'',quantity:'1',unitPrice:''}]}))}>+ Add Line</Btn>
        </div>

        <div style={{background:'var(--cream)',padding:16,borderRadius:8,marginBottom:14}}>
          <div className="flex-between mb-2"><span>Subtotal</span><strong>{fmt$(T.sub)}</strong></div>
          <div className="flex-between mb-2">
            <Toggle checked={form.ccFeeEnabled} onChange={v=>setForm(f=>({...f,ccFeeEnabled:v}))} label="Credit Card Fee (3.5%)" />
            <span style={{color:form.ccFeeEnabled?'var(--brown)':'#bbb'}}>{fmt$(T.cc)}</span>
          </div>
          <div className="flex-between mb-2">
            <Toggle checked={form.taxEnabled} onChange={v=>setForm(f=>({...f,taxEnabled:v}))} label={`Sales Tax (${(T.fb.taxRate*100).toFixed(3)}%)`} />
            <span style={{color:form.taxEnabled?'var(--brown)':'#bbb'}}>{fmt$(T.taxAmt)}</span>
          </div>
          <hr className="divider" />
          <div className="flex-between mb-3" style={{fontWeight:700,fontSize:17,color:'var(--brown)'}}>
            <span>Grand Total</span><span>{fmt$(T.grand)}</span>
          </div>
          <div className="flex-between" style={{alignItems:'center',marginBottom:8}}>
            <label style={{margin:0}}>Deposit / Amount Paid</label>
            <input className="input" type="number" min="0" step="0.01" value={form.deposit} onChange={e=>setForm(f=>({...f,deposit:e.target.value}))} style={{width:130}} placeholder="0.00" />
          </div>
          <div className="flex-between" style={{fontWeight:700,fontSize:15,color:T.balance>0?'var(--danger)':'var(--success)'}}>
            <span>Balance Due</span><span>{fmt$(T.balance)}</span>
          </div>
        </div>

        <div style={{background:'#FFF3CD',padding:10,borderRadius:6,marginBottom:14,fontSize:13,color:'#856404'}}>
          <strong>Payment Terms: </strong>{PAYMENT_TERMS.join('  ·  ')}
        </div>
        <div className="field"><label>Notes</label><textarea className="input" rows={2} value={form.notes} onChange={e=>setForm(f=>({...f,notes:e.target.value}))} /></div>
        <div className="flex gap-2" style={{justifyContent:'flex-end',marginTop:8}}>
          <Btn className="btn-outline" onClick={()=>{setShowForm(false);setEditingCateringId(null);}}>Cancel</Btn>
          <Btn className="btn-primary" onClick={saveInvoice}>{editingCateringId ? 'Save Changes' : 'Create Invoice'}</Btn>
        </div>
      </Modal>

      {/* View Modal */}
      <Modal open={!!viewInv} onClose={()=>setViewInv(null)} title={`Catering Invoice ${viewInv?.id||''}`} wide closeOnBackdrop>
        {viewInv&&(
          <div id={`catering-view-${viewInv.id}`} style={{fontFamily:'Georgia,serif'}}>
            <div className="flex-between mb-4" style={{flexWrap:'wrap',gap:8}}>
              <div style={{display:'flex',alignItems:'center',gap:10}}>
                <BrandMark brand={getInvoiceBranding(viewInv, brandingMap)} />
                <div><div style={{fontWeight:700,fontSize:19,color:'var(--brown)'}}>{getInvoiceBranding(viewInv, brandingMap).name}</div><div style={{fontSize:13,color:'#888'}}>{getInvoiceBranding(viewInv, brandingMap).location}</div></div>
              </div>
              <div style={{textAlign:'right',fontSize:13}}><div style={{fontSize:18,fontWeight:700,color:'var(--brown)'}}>{viewInv.id}</div><div>{viewInv.useRange?`${fmtDate(viewInv.dateStart)} – ${fmtDate(viewInv.dateEnd)}`:fmtDate(viewInv.date)}</div><div><strong>Event:</strong> {viewInv.eventType}</div></div>
            </div>
            <div style={{padding:'10px 14px',background:'var(--cream)',borderRadius:6,marginBottom:16,fontSize:14}}>
              <strong style={{fontSize:15}}>{viewInv.customerName}</strong>
              {viewInv.customerPhone&&<div>📞 {viewInv.customerPhone}</div>}
              {viewInv.customerEmail&&<div>✉️ {viewInv.customerEmail}</div>}
            </div>
            <div className="tbl-wrap" style={{marginBottom:16}}>
              <table><thead><tr><th>Description</th><th>Qty</th><th>Unit Price</th><th>Total</th></tr></thead>
                <tbody>{viewInv.lineItems.map((l,i)=><tr key={i}><td>{l.description}</td><td>{l.qty??l.quantity}</td><td>{fmt$(l.price??l.unitPrice)}</td><td style={{fontWeight:600}}>{fmt$(l.total)}</td></tr>)}</tbody>
              </table>
            </div>
            <div style={{textAlign:'right'}}>
              <div>Subtotal: {fmt$(viewInv.subtotal)}</div>
              {viewInv.ccFeeEnabled&&<div>CC Fee (3.5%): {fmt$(viewInv.ccFee)}</div>}
              {viewInv.taxEnabled&&<div>Tax ({(viewInv.taxRate*100).toFixed(3)}%): {fmt$(viewInv.taxAmount)}</div>}
              <hr className="divider" />
              <div style={{fontWeight:700,fontSize:18,color:'var(--brown)'}}>Total: {fmt$(viewInv.grandTotal)}</div>
              {viewInv.deposit>0&&<div style={{color:'var(--success)'}}>Deposit Received: {fmt$(viewInv.deposit)}</div>}
              <div style={{fontWeight:700,color:viewInv.balanceDue>0?'var(--danger)':'var(--success)',fontSize:15}}>Balance Due: {fmt$(viewInv.balanceDue)}</div>
            </div>
            <div style={{marginTop:14,padding:10,background:'#FFF3CD',borderRadius:6,fontSize:12,color:'#856404'}}>
              <strong>Payment Terms: </strong>{PAYMENT_TERMS.join('  ·  ')}
            </div>
            {viewInv.notes&&<div style={{marginTop:8,fontSize:13,color:'#666',fontStyle:'italic'}}>Notes: {viewInv.notes}</div>}
            <div className="flex gap-2" style={{justifyContent:'flex-end',marginTop:16}}>
              <Btn className="btn-outline" onClick={()=>printInvoiceById(`catering-view-${viewInv.id}`)}>🖨 Print / Save PDF</Btn>
              <Btn className="btn-secondary" onClick={()=>{const v=viewInv; setViewInv(null); openCateringEdit(v);}}>Edit</Btn>
              <Btn className="btn-primary" onClick={()=>setViewInv(null)}>Close</Btn>
            </div>
          </div>
        )}
      </Modal>

      <Confirm
        open={!!confirmId}
        title="Delete catering invoice?"
        message={
          pendingDeleteCatering
            ? `Permanently remove invoice ${pendingDeleteCatering.id} (${pendingDeleteCatering.customerName || 'customer'}) on this device?`
            : 'Permanently remove this catering invoice on this device?'
        }
        detail="This cannot be undone here. Export a backup from Settings if you might need to recover this record."
        dangerCode="DMG-E012 (local data change)"
        confirmLabel="Delete invoice"
        onConfirm={() => deleteInv(confirmId)}
        onCancel={() => setConfirmId(null)}
      />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// TAB 5 — CUSTOMER MANAGEMENT
// ═══════════════════════════════════════════════════════════
function CustomerManagement({ customers, setCustomers, cateringInvoices }) {
  const blank=()=>({name:'',phone:'',email:'',address:'',notes:''});
  const [showForm,setShowForm]=useState(false);
  const [editId,setEditId]=useState(null);
  const [form,setForm]=useState(blank());
  const [viewId,setViewId]=useState(null);
  const [confirmId,setConfirmId]=useState(null);
  const [search,setSearch]=useState('');

  const nameSuggestions = useMemo(()=>uniqSuggestions(...customers.map(c=>c.name)),[customers]);
  const phoneSuggestions = useMemo(()=>uniqSuggestions(...customers.map(c=>c.phone)),[customers]);
  const emailSuggestions = useMemo(()=>uniqSuggestions(...customers.map(c=>c.email)),[customers]);

  const filtered=useMemo(()=>{
    const q=search.toLowerCase();
    return customers.filter(c=>c.name.toLowerCase().includes(q)||(c.phone||'').includes(q)||(c.email||'').toLowerCase().includes(q));
  },[customers,search]);

  const pendingDeleteCustomer = useMemo(
    () => (confirmId ? customers.find((c) => c.id === confirmId) : null),
    [confirmId, customers]
  );

  function openEdit(c){setForm({name:c.name,phone:c.phone,email:c.email,address:c.address,notes:c.notes});setEditId(c.id);setShowForm(true);}
  function saveCust(){
    if (!form.name.trim()){showToast('Customer name is required.','error');return;}
    let u;
    if (editId) {
      u=customers.map(c=>c.id===editId?{...c,...form}:c);
      showToast('Customer updated.');
      logActivity('edit_customer', 'Updated customer ' + form.name);
    } else {
      u=[...customers,{id:uid(),...form,createdAt:today()}];
      showToast('Customer added.');
      logActivity('add_customer', 'Added customer ' + form.name);
    }
    setCustomers(u);save('customers',u);setShowForm(false);setEditId(null);
  }
  function delCust(id){const removed=customers.find(c=>c.id===id);const u=customers.filter(c=>c.id!==id);setCustomers(u);save('customers',u);setConfirmId(null);showToast('Customer deleted.');logActivity('delete_customer','Deleted customer '+(removed?.name||id));}

  const viewCust=customers.find(c=>c.id===viewId);
  const custInvs=useMemo(()=>cateringInvoices.filter(i=>i.customerId===viewId),[viewId,cateringInvoices]);

  return (
    <div>
      <div className="flex-between mb-4 flex-wrap gap-2">
        <div className="section-title" style={{margin:0}}>Customers ({customers.length})</div>
        <Btn className="btn-primary" onClick={()=>{setForm(blank());setEditId(null);setShowForm(true);}}>+ Add Customer</Btn>
      </div>
      <input className="input mb-4" placeholder="Search customers…" value={search} onChange={e=>setSearch(e.target.value)} />

      {filtered.length===0
        ? <div className="card empty-state">No customers yet.</div>
        : (
          <div className="card" style={{padding:0}}>
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>Name</th><th>Phone</th><th>Email</th><th>Invoices</th><th>Total Revenue</th><th>Actions</th></tr></thead>
                <tbody>
                  {filtered.map(c=>{
                    const invs=cateringInvoices.filter(i=>i.customerId===c.id);
                    const rev=invs.reduce((s,i)=>s+(i.grandTotal||0),0);
                    return (
                      <tr key={c.id}>
                        <td style={{fontWeight:600}}>{c.name}</td>
                        <td>{c.phone||'—'}</td>
                        <td>{c.email||'—'}</td>
                        <td>{invs.length}</td>
                        <td style={{fontWeight:600,color:'var(--brown)'}}>{fmt$(rev)}</td>
                        <td style={{whiteSpace:'nowrap'}}>
                          <Btn className="btn-outline btn-sm" style={{marginRight:4}} onClick={()=>setViewId(c.id)}>History</Btn>
                          <Btn className="btn-secondary btn-sm" style={{marginRight:4}} onClick={()=>openEdit(c)}>Edit</Btn>
                          <Btn className="btn-danger btn-sm" onClick={()=>setConfirmId(c.id)}>Delete</Btn>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )
      }

      <Modal open={showForm} onClose={()=>setShowForm(false)} title={editId?'Edit Customer':'Add Customer'}>
        <FI label="Full Name *" value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} suggestions={nameSuggestions} />
        <div className="grid-2">
          <FI label="Phone" value={form.phone} onChange={e=>setForm(f=>({...f,phone:e.target.value}))} suggestions={phoneSuggestions} />
          <FI label="Email" type="email" value={form.email} onChange={e=>setForm(f=>({...f,email:e.target.value}))} suggestions={emailSuggestions} />
        </div>
        <FI label="Address" value={form.address} onChange={e=>setForm(f=>({...f,address:e.target.value}))} />
        <div className="field"><label>Notes</label><textarea className="input" rows={2} value={form.notes} onChange={e=>setForm(f=>({...f,notes:e.target.value}))} /></div>
        <div className="flex gap-2" style={{justifyContent:'flex-end',marginTop:8}}>
          <Btn className="btn-outline" onClick={()=>setShowForm(false)}>Cancel</Btn>
          <Btn className="btn-primary" onClick={saveCust}>Save</Btn>
        </div>
      </Modal>

      <Modal open={!!viewCust} onClose={()=>setViewId(null)} title={`${viewCust?.name||''} — Invoice History`} wide closeOnBackdrop>
        {viewCust&&(
          <div>
            <div style={{padding:'10px 14px',background:'var(--cream)',borderRadius:6,marginBottom:16,fontSize:14}}>
              {viewCust.phone&&<div>📞 {viewCust.phone}</div>}
              {viewCust.email&&<div>✉️ {viewCust.email}</div>}
              {viewCust.address&&<div>📍 {viewCust.address}</div>}
              {viewCust.notes&&<div style={{color:'#888',marginTop:4}}>📝 {viewCust.notes}</div>}
            </div>
            {custInvs.length===0
              ? <p style={{color:'#aaa',textAlign:'center',padding:24}}>No invoices for this customer yet.</p>
              : (
                <>
                  <div style={{marginBottom:10,fontSize:14}}>
                    <strong>Total Revenue: </strong><span style={{color:'var(--brown)',fontWeight:700}}>{fmt$(custInvs.reduce((s,i)=>s+(i.grandTotal||0),0))}</span>
                    <span style={{marginLeft:16,color:'#888'}}>{custInvs.length} invoice{custInvs.length!==1?'s':''}</span>
                  </div>
                  <div className="tbl-wrap">
                    <table><thead><tr><th>Invoice #</th><th>Date</th><th>Event</th><th>Total</th><th>Balance</th><th>Status</th></tr></thead>
                      <tbody>{[...custInvs].reverse().map(inv=>(
                        <tr key={inv.id}>
                          <td style={{fontFamily:'monospace',fontWeight:600}}>{inv.id}</td>
                          <td>{inv.useRange?`${fmtDate(inv.dateStart)} – ${fmtDate(inv.dateEnd)}`:fmtDate(inv.date)}</td>
                          <td>{inv.eventType}</td>
                          <td style={{fontWeight:600}}>{fmt$(inv.grandTotal)}</td>
                          <td style={{color:inv.balanceDue>0?'var(--danger)':'var(--success)',fontWeight:600}}>{fmt$(inv.balanceDue)}</td>
                          <td><span className={`badge badge-${inv.status}`}>{inv.status}</span></td>
                        </tr>
                      ))}</tbody>
                    </table>
                  </div>
                </>
              )
            }
          </div>
        )}
      </Modal>
      <Confirm
        open={!!confirmId}
        title="Delete customer?"
        message={
          pendingDeleteCustomer
            ? `Remove "${pendingDeleteCustomer.name}" from the customer list on this device?`
            : 'Remove this customer from the customer list on this device?'
        }
        detail="Existing catering invoices in the archive still reference this customer by ID; only the saved customer card is removed."
        dangerCode="DMG-E012 (local data change)"
        confirmLabel="Delete customer"
        onConfirm={() => delCust(confirmId)}
        onCancel={() => setConfirmId(null)}
      />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// TAB 6 — DAILY INCOME / EXPENSE
// ═══════════════════════════════════════════════════════════
function DailyIncomeExpense({ entries, setEntries, selectedBusiness }) {
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
    if (monthF && (r.date || '').slice(5,7) !== monthF) return false;
    if (yearF && (r.date || '').slice(0,4) !== yearF) return false;
    return true;
  }), [sorted, monthF, yearF]);

  const totals = useMemo(() => filtered.reduce((acc, r) => {
    acc.income += +(r.income || 0);
    acc.expense += +(r.expense || 0);
    acc.salesTaxCollected += +(r.salesTaxCollected || 0);
    acc.taxPaid += +(r.taxPaid || 0);
    return acc;
  }, { income:0, expense:0, salesTaxCollected:0, taxPaid:0 }), [filtered]);

  const net = +(totals.income - totals.expense).toFixed(2);
  const estimatedIncomeTax = +(Math.max(net, 0) * 0.22).toFixed(2);
  const salesTaxDue = +(totals.salesTaxCollected - totals.taxPaid).toFixed(2);

  const monthly = useMemo(() => {
    const m = {};
    entries.forEach(r => {
      const d = (r.date || '').slice(0,7);
      if (!d) return;
      if (!m[d]) m[d] = { month: d, income:0, expense:0, tax:0 };
      m[d].income += +(r.income || 0);
      m[d].expense += +(r.expense || 0);
      m[d].tax += +((r.salesTaxCollected || 0) - (r.taxPaid || 0));
    });
    return Object.values(m).sort((a,b)=>a.month.localeCompare(b.month)).slice(-18).map(x => ({
      ...x,
      net: +(x.income - x.expense).toFixed(2),
      label: `${x.month.slice(5)}/${x.month.slice(2,4)}`
    }));
  }, [entries]);

  function parseNum(v) {
    if (v === '' || v == null) return 0;
    const n = parseFloat(String(v).replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? +n.toFixed(2) : 0;
  }

  function saveRow() {
    if (!form.date) { showToast('Date is required.', 'error'); return; }
    const row = {
      id: uid(),
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
    setForm(f => ({ ...f, income:'', expense:'', salesTaxCollected:'', taxPaid:'', notes:'' }));
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
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(dataRows.length ? dataRows : [{ Date:'', Business:'', Income:'', Expense:'', 'Net Profit':'', 'Sales Tax Collected':'', 'Tax Paid':'', 'Sales Tax Due':'', Notes:'' }]), 'Daily Ledger');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), 'Tax Summary');
    XLSX.writeFile(wb, `daily-income-expense-${today()}.xlsx`);
    logActivity('export_xlsx', 'Exported daily income/expense Excel');
    showToast('Daily finance + tax summary exported.');
  }

  function normalizeDate(v) {
    if (typeof v === 'number' && Number.isFinite(v) && XLSX?.SSF?.parse_date_code) {
      const p = XLSX.SSF.parse_date_code(v);
      if (p && p.y && p.m && p.d) return `${String(p.y).padStart(4,'0')}-${String(p.m).padStart(2,'0')}-${String(p.d).padStart(2,'0')}`;
    }
    const s = String(v || '').trim();
    if (!s) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0,10);
    return '';
  }

  function pick(row, keys) {
    const norm = {};
    Object.keys(row || {}).forEach(k => { norm[String(k).toLowerCase().replace(/[^a-z0-9]/g,'')] = row[k]; });
    for (const key of keys) {
      const n = key.toLowerCase().replace(/[^a-z0-9]/g,'');
      if (Object.prototype.hasOwnProperty.call(norm, n)) return norm[n];
    }
    return '';
  }

  async function importExcel(file) {
    try {
      if (!file) return;
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type:'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { defval:'' });
      if (!rows.length) { showToast('No rows found in uploaded file.', 'error'); return; }
      const mapped = rows.map(r => {
        const date = normalizeDate(pick(r, ['date','day','transaction date','entry date']));
        const bizRaw = String(pick(r, ['business','store','location']) || '').toLowerCase();
        const business = Object.keys(BUSINESSES).find(k => bizRaw.includes(k) || bizRaw.includes(BUSINESSES[k].name.toLowerCase())) || selectedBusiness || 'degrill';
        return {
          id: uid(),
          date: date || today(),
          business,
          income: parseNum(pick(r, ['income','revenue','sales','cashin'])),
          expense: parseNum(pick(r, ['expense','expenses','cost','spend','cashout'])),
          salesTaxCollected: parseNum(pick(r, ['salestaxcollected','taxcollected','sales tax'])),
          taxPaid: parseNum(pick(r, ['taxpaid','tax payment','tax remitted'])),
          notes: String(pick(r, ['notes','memo','description']) || '').trim(),
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
      logFailure({ area:'daily_finance', action:'import_excel', error:e });
      showToast('Excel import failed. Check column names and try again.', 'error');
    }
  }

  return (
    <div>
      <div className="flex-between mb-3 flex-wrap gap-2">
        <div className="section-title" style={{margin:0}}>Daily Income & Expense</div>
        <div className="flex gap-2">
          <Btn className="btn-outline btn-sm" onClick={()=>importRef.current?.click()}>⬆ Upload Excel (2025/2026)</Btn>
          <input ref={importRef} type="file" accept=".xlsx,.xls" style={{display:'none'}} onChange={e=>{importExcel(e.target.files?.[0]); e.target.value='';}} />
          <Btn className="btn-success btn-sm" onClick={exportExcel}>⬇ Export Excel</Btn>
        </div>
      </div>
      <div className="hint-card">Use this for daily accounting, backfill old records via Excel, and auto-generate tax-ready summaries.</div>

      <div className="card mb-3">
        <div className="grid-3">
          <FI label="Date" type="date" value={form.date} onChange={e=>setForm(f=>({...f,date:e.target.value}))} />
          <div className="field"><label>Business</label><select className="input" value={form.business} onChange={e=>setForm(f=>({...f,business:e.target.value}))}>{Object.entries(BUSINESSES).map(([k,v])=><option key={k} value={k}>{v.name}</option>)}</select></div>
          <FI label="Daily Income" type="number" step="0.01" value={form.income} onChange={e=>setForm(f=>({...f,income:e.target.value}))} />
          <FI label="Daily Expense" type="number" step="0.01" value={form.expense} onChange={e=>setForm(f=>({...f,expense:e.target.value}))} />
          <FI label="Sales Tax Collected" type="number" step="0.01" value={form.salesTaxCollected} onChange={e=>setForm(f=>({...f,salesTaxCollected:e.target.value}))} />
          <FI label="Tax Paid" type="number" step="0.01" value={form.taxPaid} onChange={e=>setForm(f=>({...f,taxPaid:e.target.value}))} />
        </div>
        <FI label="Notes" value={form.notes} onChange={e=>setForm(f=>({...f,notes:e.target.value}))} />
        <div className="flex" style={{justifyContent:'flex-end'}}><Btn className="btn-primary" onClick={saveRow}>Save Daily Entry</Btn></div>
      </div>

      <div className="card mb-3" style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(160px,1fr))',gap:10}}>
        <div className="field" style={{margin:0}}><label>Year</label><input className="input" placeholder="e.g. 2026" value={yearF} onChange={e=>setYearF(e.target.value.replace(/[^0-9]/g,'').slice(0,4))} /></div>
        <div className="field" style={{margin:0}}><label>Month</label><select className="input" value={monthF} onChange={e=>setMonthF(e.target.value)}><option value="">All</option>{Array.from({length:12},(_,i)=>String(i+1).padStart(2,'0')).map(m=><option key={m} value={m}>{m}</option>)}</select></div>
      </div>

      <div className="stat-grid">
        {[{v:fmt$(totals.income),l:'Income'},{v:fmt$(totals.expense),l:'Expense'},{v:fmt$(net),l:'Net Profit'},{v:fmt$(estimatedIncomeTax),l:'Estimated Income Tax'},{v:fmt$(salesTaxDue),l:'Sales Tax Due'},{v:filtered.length,l:'Daily Entries'}].map((s,i)=><div key={i} className="stat-card"><div className="stat-val">{s.v}</div><div className="stat-lbl">{s.l}</div></div>)}
      </div>

      {monthly.length > 1 && (
        <Suspense fallback={<div className="card mb-3 text-muted" style={{ padding: 24, textAlign: 'center' }}>Loading chart…</div>}>
          <LazyDailyFinanceCharts monthly={monthly} fmt$={fmt$} />
        </Suspense>
      )}

      <div className="card" style={{padding:0}}>
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Date</th><th>Business</th><th>Income</th><th>Expense</th><th>Net</th><th>Tax Collected</th><th>Tax Paid</th><th>Tax Due</th><th>Notes</th><th></th></tr></thead>
            <tbody>
              {filtered.map(r=>(
                <tr key={r.id}>
                  <td>{fmtDate(r.date)}</td>
                  <td>{BUSINESSES[r.business]?.name || r.business}</td>
                  <td>{fmt$(r.income||0)}</td>
                  <td>{fmt$(r.expense||0)}</td>
                  <td style={{fontWeight:700,color:(r.income-r.expense)>=0?'var(--success)':'var(--danger)'}}>{fmt$((r.income||0)-(r.expense||0))}</td>
                  <td>{fmt$(r.salesTaxCollected||0)}</td>
                  <td>{fmt$(r.taxPaid||0)}</td>
                  <td>{fmt$((r.salesTaxCollected||0)-(r.taxPaid||0))}</td>
                  <td>{r.notes || '—'}</td>
                  <td><Btn className="btn-danger btn-sm" onClick={()=>deleteRow(r.id)}>Delete</Btn></td>
                </tr>
              ))}
              {filtered.length===0 && <tr><td colSpan={10} style={{textAlign:'center',padding:20,color:'#999'}}>No daily finance records yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// TAB 7 — ANALYTICS
// ═══════════════════════════════════════════════════════════
function Analytics({ cateringInvoices, purchaseInvoices, dailyFinanceEntries }) {
  const totalRevenue=useMemo(()=>cateringInvoices.reduce((s,i)=>s+(i.grandTotal||0),0),[cateringInvoices]);
  const totalSpending=useMemo(()=>purchaseInvoices.reduce((s,i)=>s+(i.total||0),0),[purchaseInvoices]);
  const outstanding=useMemo(()=>cateringInvoices.reduce((s,i)=>s+(i.balanceDue||0),0),[cateringInvoices]);
  const manualIncome=useMemo(()=>dailyFinanceEntries.reduce((s,i)=>s+(i.income||0),0),[dailyFinanceEntries]);
  const manualExpense=useMemo(()=>dailyFinanceEntries.reduce((s,i)=>s+(i.expense||0),0),[dailyFinanceEntries]);
  const taxDue=useMemo(()=>dailyFinanceEntries.reduce((s,i)=>s+((i.salesTaxCollected||0)-(i.taxPaid||0)),0),[dailyFinanceEntries]);

  const monthRevenue=useMemo(()=>{
    const m={};
    cateringInvoices.forEach(inv=>{const d=inv.date||inv.dateStart||inv.createdAt;if(!d)return;const k=d.substring(0,7);m[k]=(m[k]||0)+(inv.grandTotal||0);});
    return Object.entries(m).sort((a,b)=>a[0].localeCompare(b[0])).slice(-12).map(([k,v])=>({month:k.slice(5)+'/'+k.slice(2,4),total:+v.toFixed(2)}));
  },[cateringInvoices]);

  const statusData=useMemo(()=>[
    {name:'Paid',value:cateringInvoices.filter(i=>i.status==='paid').length},
    {name:'Unpaid',value:cateringInvoices.filter(i=>i.status==='unpaid').length},
    {name:'Partial',value:cateringInvoices.filter(i=>i.status==='partial').length},
  ].filter(d=>d.value>0),[cateringInvoices]);

  const supplierData=useMemo(()=>{
    const m={};
    purchaseInvoices.forEach(i=>{m[i.supplier]=(m[i.supplier]||0)+(i.total||0);});
    return Object.entries(m).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([name,v])=>({name,total:+v.toFixed(2)}));
  },[purchaseInvoices]);

  const hasData=cateringInvoices.length>0||purchaseInvoices.length>0;

  return (
    <div>
      <div className="section-title">Analytics Dashboard</div>
      <div className="stat-grid">
        {[
          {v:fmt$(totalRevenue + manualIncome),l:'Total Revenue (Invoices + Daily)'},
          {v:fmt$(outstanding),l:'Outstanding Balance'},
          {v:fmt$(totalSpending + manualExpense),l:'Total Expenses (Purchases + Daily)'},
          {v:fmt$(taxDue),l:'Sales Tax Due (Daily Ledger)'},
          {v:cateringInvoices.length,l:'Catering Invoices'},
          {v:purchaseInvoices.length,l:'Purchase Orders'},
          {v:cateringInvoices.length>0?fmt$(totalRevenue/cateringInvoices.length):'—',l:'Avg Invoice Value'},
        ].map((s,i)=>(
          <div key={i} className="stat-card"><div className="stat-val">{s.v}</div><div className="stat-lbl">{s.l}</div></div>
        ))}
      </div>

      {!hasData&&<div className="card empty-state">Create invoices to see analytics charts here.</div>}

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

// ═══════════════════════════════════════════════════════════
// TAB 7 — INVOICE ARCHIVE
// ═══════════════════════════════════════════════════════════
function InvoiceArchive({ purchaseInvoices, setPurchaseInvoices, cateringInvoices, setCateringInvoices, transferInvoices, setTransferInvoices, payrollInvoices, setPayrollInvoices, userRole, brandingMap }) {
  const isAdmin=userRole==='admin';
  const [typeF,setTypeF]=useState('all');
  const [statusF,setStatusF]=useState('all');
  const [search,setSearch]=useState('');
  const [dateFrom,setDateFrom]=useState('');
  const [dateTo,setDateTo]=useState('');
  const [confirmObj,setConfirmObj]=useState(null);
  const [viewInv,setViewInv]=useState(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(() => {
    const saved = parseInt(load('_archivePageSize', 25));
    return [10,25,50].includes(saved) ? saved : 25;
  });

  const all=useMemo(()=>{
    const p=purchaseInvoices.map(i=>({...i,_type:'purchase',_date:i.date}));
    const c=cateringInvoices.map(i=>({...i,_type:'catering',_date:i.date||i.dateStart}));
    const t=transferInvoices.map(i=>({...i,_type:'transfer',_date:i.date, supplier:`${i.from}${i.fromContact?` (${i.fromContact})`:''} -> ${i.to}${i.toContact?` (${i.toContact})`:''}`}));
    const y=(payrollInvoices||[]).map(i=>({...i,_type:'payroll',_date:i.date, customerName:i.employeeName || i.employeeUsername || ''}));
    return [...p,...c,...t,...y].sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||''));
  },[purchaseInvoices,cateringInvoices,transferInvoices,payrollInvoices]);

  const filtered=useMemo(()=>all.filter(inv=>{
    if(typeF!=='all'&&inv._type!==typeF) return false;
    if(statusF!=='all'&&inv.status!==statusF) return false;
    const q=search.toLowerCase();
    if(q&&![(inv.customerName||''),(inv.supplier||''),inv.id].some(s=>s.toLowerCase().includes(q))) return false;
    if(dateFrom&&inv._date&&inv._date<dateFrom) return false;
    if(dateTo&&inv._date&&inv._date>dateTo) return false;
    return true;
  }),[all,typeF,statusF,search,dateFrom,dateTo]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const paginated = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  // Reset to page 1 whenever filters change
  useEffect(() => { setPage(1); }, [typeF, statusF, search, dateFrom, dateTo, pageSize]);

  const archiveDeleteSummary = useMemo(() => {
    if (!confirmObj) return '';
    const party = confirmObj.customerName || confirmObj.supplier || confirmObj.employeeName || '';
    return `${confirmObj._type || 'record'} · ${confirmObj.id}${party ? ` · ${party}` : ''}`;
  }, [confirmObj]);

  function markPaid(inv){
    if(inv._type==='purchase'){const u=purchaseInvoices.map(x=>x.id===inv.id?{...x,status:'paid'}:x);setPurchaseInvoices(u);save('purchaseInvoices',u);}
    else if(inv._type==='catering'){const u=cateringInvoices.map(x=>x.id===inv.id?{...x,status:'paid',deposit:x.grandTotal,balanceDue:0}:x);setCateringInvoices(u);save('cateringInvoices',u);}
    else if(inv._type==='transfer'){const u=transferInvoices.map(x=>x.id===inv.id?{...x,status:'paid'}:x);setTransferInvoices(u);save('transferInvoices',u);}
    else {const u=(payrollInvoices||[]).map(x=>x.id===inv.id?{...x,status:'paid'}:x);setPayrollInvoices(u);save('payrollInvoices',u);}
    showToast('Invoice marked paid.');
    logActivity('mark_paid', 'Marked '+inv._type+' invoice paid '+inv.id);
  }
  function deleteInv({id,_type}){
    if(_type==='purchase'){const u=purchaseInvoices.filter(x=>x.id!==id);setPurchaseInvoices(u);save('purchaseInvoices',u);}
    else if(_type==='catering'){const u=cateringInvoices.filter(x=>x.id!==id);setCateringInvoices(u);save('cateringInvoices',u);}
    else if(_type==='transfer'){const u=transferInvoices.filter(x=>x.id!==id);setTransferInvoices(u);save('transferInvoices',u);}
    else{const u=(payrollInvoices||[]).filter(x=>x.id!==id);setPayrollInvoices(u);save('payrollInvoices',u);}
    setConfirmObj(null);
    showToast('Invoice deleted.');
    logActivity('delete_invoice', 'Deleted '+_type+' invoice '+id);
  }

  const filtTotal=filtered.reduce((s,i)=>s+(i.total||i.grandTotal||0),0);
  const statusCounts = useMemo(() => ({
    paid: filtered.filter(i=>i.status==='paid').length,
    unpaid: filtered.filter(i=>i.status==='unpaid').length,
    partial: filtered.filter(i=>i.status==='partial').length
  }), [filtered]);

  function toArchiveRow(inv) {
    return {
      'Invoice #': inv.id,
      Type: inv._type,
      Party: inv.customerName || inv.supplier || '',
      Date: inv._date || '',
      Status: inv.status || '',
      Total: +(inv.total || inv.grandTotal || 0).toFixed(2)
    };
  }
  function exportArchiveExcel() {
    const rows = filtered.map(toArchiveRow);
    const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [toArchiveRow({id:'',_type:'',customerName:'',supplier:'',_date:'',status:'',total:0,grandTotal:0})]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Archive');
    XLSX.writeFile(wb, `invoice-archive-${today()}.xlsx`);
    logActivity('export_xlsx', 'Exported invoice archive Excel');
    showToast('Archive exported as Excel.');
  }
  function exportArchiveCsv() {
    const rows = filtered.map(toArchiveRow);
    const header = ['Invoice #','Type','Party','Date','Status','Total'];
    const esc = v => `"${String(v ?? '').replace(/"/g,'""')}"`;
    const csv = [header.map(esc).join(',')]
      .concat(rows.map(r => header.map(h => esc(r[h])).join(',')))
      .join('\n');
    const blob = new Blob([csv], { type:'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `invoice-archive-${today()}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    logActivity('export_csv', 'Exported invoice archive CSV');
    showToast('Archive exported as CSV.');
  }

  return (
    <div>
      <div className="flex-between mb-3 flex-wrap gap-2">
        <div className="section-title" style={{margin:0}}>Invoice Archive</div>
        <div className="flex gap-2">
          <Btn className="btn-outline btn-sm" onClick={exportArchiveCsv}>⬇ Export CSV</Btn>
          <Btn className="btn-success btn-sm" onClick={exportArchiveExcel}>⬇ Export Excel</Btn>
        </div>
      </div>
      <div className="card mb-4">
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(145px,1fr))',gap:12}}>
          <div className="field" style={{margin:0}}><label>Type</label>
            <select className="input" value={typeF} onChange={e=>setTypeF(e.target.value)}>
              <option value="all">All Types</option><option value="catering">Catering</option><option value="purchase">Purchase</option><option value="transfer">Transfer</option><option value="payroll">Payroll</option>
            </select>
          </div>
          <div className="field" style={{margin:0}}><label>Status</label>
            <select className="input" value={statusF} onChange={e=>setStatusF(e.target.value)}>
              <option value="all">All Status</option><option value="paid">Paid</option><option value="unpaid">Unpaid</option><option value="partial">Partial</option>
            </select>
          </div>
          <div className="field" style={{margin:0}}><label>Search</label><input className="input" placeholder="Customer, supplier, #…" value={search} onChange={e=>setSearch(e.target.value)} /></div>
          <div className="field" style={{margin:0}}><label>From</label><input className="input" type="date" value={dateFrom} onChange={e=>setDateFrom(e.target.value)} /></div>
          <div className="field" style={{margin:0}}><label>To</label><input className="input" type="date" value={dateTo} onChange={e=>setDateTo(e.target.value)} /></div>
        </div>
        <div style={{marginTop:10,fontSize:13,color:'#666',display:'flex',alignItems:'center',gap:10,flexWrap:'wrap'}}>
          <span>Showing <strong>{filtered.length}</strong> of {all.length} · Total: <strong style={{color:'var(--brown)'}}>{fmt$(filtTotal)}</strong></span>
          <span>Paid: <strong>{statusCounts.paid}</strong></span>
          <span>Unpaid: <strong>{statusCounts.unpaid}</strong></span>
          <span>Partial: <strong>{statusCounts.partial}</strong></span>
          <span style={{marginLeft:'auto',display:'flex',alignItems:'center',gap:6}}>
            Per page:
            <select className="input" style={{padding:'2px 6px',fontSize:12,width:'auto'}} value={pageSize}
              onChange={e=>{const n=parseInt(e.target.value);setPageSize(n);save('_archivePageSize',n);}}>
              <option value={10}>10</option><option value={25}>25</option><option value={50}>50</option>
            </select>
          </span>
          {(typeF!=='all'||statusF!=='all'||search||dateFrom||dateTo)&&
            <Btn className="btn-sm" style={{background:'#eee',color:'#666'}} onClick={()=>{setTypeF('all');setStatusF('all');setSearch('');setDateFrom('');setDateTo('');}}>✕ Clear Filters</Btn>}
        </div>
      </div>

      {filtered.length===0
        ? <div className="card empty-state">No invoices match the current filters.</div>
        : (
          <div className="card" style={{padding:0}}>
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>Invoice #</th><th>Type</th><th>Customer / Supplier</th><th>Date</th><th>Business</th><th>Total</th><th>Status</th><th>Actions</th></tr></thead>
                <tbody>
                  {paginated.map(inv=>(
                    <tr key={inv.id}>
                      <td style={{fontFamily:'monospace',fontWeight:700}}>{inv.id}</td>
                      <td><span style={{fontSize:11,padding:'2px 7px',borderRadius:10,fontWeight:600,background:inv._type==='catering'?'#E8F4FC':inv._type==='transfer'?'#EEF9F1':'#FFF0E0',color:inv._type==='catering'?'#2980b9':inv._type==='transfer'?'#1e7a3b':'var(--choc)'}}>{inv._type}</span></td>
                      <td style={{fontWeight:600}}>{inv.customerName||inv.supplier}</td>
                      <td style={{fontSize:12}}>{inv._type==='catering'&&inv.useRange?`${fmtDate(inv.dateStart)} – ${fmtDate(inv.dateEnd)}`:fmtDate(inv._date)}</td>
                      <td style={{fontSize:12,color:'#777'}}>{inv._type==='payroll' ? ((inv.invoiceStandard || 'PAYROLL_WEEKLY_V1') + ` · @${inv.employeeUsername || ''}`) : BUSINESSES[inv.business]?.name}</td>
                      <td style={{fontWeight:600}}>{fmt$(inv.total||inv.grandTotal)}</td>
                      <td><span className={`badge badge-${inv.status}`}>{inv.status}</span></td>
                      <td style={{whiteSpace:'nowrap'}}>
                        <Btn className="btn-secondary btn-sm" style={{marginRight:4}} onClick={()=>setViewInv(inv)}>View</Btn>
                        {inv.status!=='paid'&&<Btn className="btn-success btn-sm" style={{marginRight:4}} onClick={()=>markPaid(inv)}>Paid</Btn>}
                        {isAdmin&&<Btn className="btn-danger btn-sm" onClick={()=>setConfirmObj(inv)}>Delete</Btn>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      }
      {totalPages > 1 && (
        <div style={{display:'flex',alignItems:'center',justifyContent:'center',gap:8,marginTop:12,fontSize:13}}>
          <Btn className="btn-outline btn-sm" disabled={safePage<=1} onClick={()=>setPage(p=>Math.max(1,p-1))}>← Prev</Btn>
          <span style={{color:'#666'}}>Page <strong>{safePage}</strong> of <strong>{totalPages}</strong></span>
          <Btn className="btn-outline btn-sm" disabled={safePage>=totalPages} onClick={()=>setPage(p=>Math.min(totalPages,p+1))}>Next →</Btn>
        </div>
      )}

      <Modal open={!!viewInv} onClose={()=>setViewInv(null)} title={`Invoice ${viewInv?.id||''}`} wide closeOnBackdrop>
        {viewInv&&(
          <div id={`archive-view-${viewInv.id}`}>
            <div className="flex-between mb-4" style={{flexWrap:'wrap',gap:8}}>
              <div style={{display:'flex',alignItems:'center',gap:10}}>
                <BrandMark brand={getInvoiceBranding(viewInv, brandingMap)} />
                <div><div style={{fontWeight:700,fontSize:16,color:'var(--brown)'}}>{getInvoiceBranding(viewInv, brandingMap).name}</div><div style={{fontSize:13,color:'#888'}}>{viewInv._type==='transfer'?(viewInv.supplier||'Hackensack -> Englewood'):getInvoiceBranding(viewInv, brandingMap).location}</div></div>
              </div>
              <div style={{textAlign:'right',fontSize:13}}><div style={{fontWeight:700,fontSize:18,color:'var(--brown)'}}>{viewInv.id}</div><div>{viewInv.customerName||viewInv.supplier}</div><span className={`badge badge-${viewInv.status}`} style={{marginTop:4,display:'inline-block'}}>{viewInv.status}</span></div>
            </div>
            {viewInv.lineItems&&(
              <div className="tbl-wrap" style={{marginBottom:14}}>
                <table><thead><tr><th>Description</th><th>Qty</th><th>Unit Price</th>{viewInv._type==='transfer'&&<th>15% Commission</th>}<th>Total</th></tr></thead>
                  <tbody>{viewInv.lineItems.map((l,i)=><tr key={i}><td>{l.description||l.item}</td><td>{l.qty??l.quantity}</td><td>{fmt$(l.price??l.unitPrice)}</td>{viewInv._type==='transfer'&&<td>{fmt$(l.commission||0)}</td>}<td style={{fontWeight:600}}>{fmt$(l.total)}</td></tr>)}</tbody>
                </table>
              </div>
            )}
            <div style={{textAlign:'right'}}>
              <div>Subtotal: {fmt$(viewInv.subtotal??viewInv.subTotal??0)}</div>
              {viewInv.ccFeeEnabled&&<div>CC Fee: {fmt$(viewInv.ccFee)}</div>}
              {viewInv._type==='transfer'&&<div>Commission: {fmt$(viewInv.commissionTotal||0)}</div>}
              {viewInv.taxEnabled&&<div>Tax: {fmt$(viewInv.taxAmount)}</div>}
              <div style={{fontWeight:700,fontSize:17,color:'var(--brown)',marginTop:6}}>Total: {fmt$(viewInv.total||viewInv.grandTotal)}</div>
              {viewInv.balanceDue!==undefined&&<div style={{color:viewInv.balanceDue>0?'var(--danger)':'var(--success)',fontWeight:600}}>Balance Due: {fmt$(viewInv.balanceDue)}</div>}
            </div>
            {viewInv._type==='catering'&&<div style={{marginTop:12,padding:10,background:'#FFF3CD',borderRadius:6,fontSize:12,color:'#856404'}}><strong>Payment Terms: </strong>{PAYMENT_TERMS.join('  ·  ')}</div>}
            {viewInv._type==='payroll'&&(
              <div style={{marginTop:12,padding:10,background:'#E8F4FC',borderRadius:6,fontSize:12,color:'#1e4f72'}}>
                <strong>Payroll Standard:</strong> {viewInv.invoiceStandard || 'PAYROLL_WEEKLY_V1'}
                <br /><strong>Employee:</strong> {viewInv.employeeName || viewInv.customerName} (@{viewInv.employeeUsername || 'user'})
                <br /><strong>Hours:</strong> {viewInv.hours || 0} (Regular {viewInv.regularHours || 0}, OT {viewInv.overtimeHours || 0})
                <br /><strong>Rate:</strong> {fmt$(viewInv.hourlyRate || 0)} / hour
              </div>
            )}
            <div className="flex gap-2" style={{justifyContent:'flex-end',marginTop:16}}>
              <Btn className="btn-outline" onClick={()=>printInvoiceById(`archive-view-${viewInv.id}`)}>🖨 Print / Save PDF</Btn>
              <Btn className="btn-primary" onClick={()=>setViewInv(null)}>Close</Btn>
            </div>
          </div>
        )}
      </Modal>
      <Confirm
        open={!!confirmObj}
        title="Delete from archive?"
        message={
          confirmObj
            ? `Permanently remove this record from this device?\n\n${archiveDeleteSummary}`
            : 'Permanently remove this record from this device?'
        }
        detail="This cannot be undone here. Export a backup from Settings if you might need to recover this invoice or payroll record."
        dangerCode="DMG-E012 (local data change)"
        confirmLabel="Delete permanently"
        wide
        onConfirm={() => deleteInv(confirmObj)}
        onCancel={() => setConfirmObj(null)}
      />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// INTERNAL TRANSFER INVOICES (P&P Hackensack -> Englewood)
// ═══════════════════════════════════════════════════════════
function TransferInvoices({ transferInvoices, setTransferInvoices, items = [], brandingMap }) {
  const COMMISSION_RATE = 0.15;
  const transferItemListId = useId();
  const itemSuggestions = useMemo(()=>{
    const fromInv = transferInvoices.flatMap(i=>(i.lineItems||[]).map(l=>(l.item||'').trim()).filter(Boolean));
    const names = items.map(i=>i.name);
    return uniqSuggestions(...fromInv, ...names);
  },[transferInvoices, items]);
  const blankForm = () => ({
    date: today(),
    from: 'Parathas & Platters - Hackensack',
    fromContact: 'Hackensack Branch',
    to: 'Parathas & Platters - Englewood',
    toContact: 'Englewood Branch',
    notes: '',
    lineItems: [{ quantity:'', item:'', price:'' }]
  });

  const [form, setForm] = useState(blankForm);
  const [showForm, setShowForm] = useState(false);
  const [editingTransferId, setEditingTransferId] = useState(null);
  const [viewId, setViewId] = useState(null);
  const [confirmId, setConfirmId] = useState(null);

  const pendingDeleteTransfer = useMemo(
    () => (confirmId ? transferInvoices.find((i) => i.id === confirmId) : null),
    [confirmId, transferInvoices]
  );

  function setLine(i, field, value) {
    setForm(f => {
      const lines = [...f.lineItems];
      lines[i] = { ...lines[i], [field]: value };
      return { ...f, lineItems: lines };
    });
  }
  function addLine() {
    setForm(f => ({ ...f, lineItems: [...f.lineItems, { quantity:'', item:'', price:'' }] }));
  }
  function removeLine(i) {
    setForm(f => ({ ...f, lineItems: f.lineItems.filter((_, idx) => idx !== i) }));
  }

  function openTransferEdit(inv) {
    const raw = transferInvoices.find((x) => x.id === inv.id) || inv;
    const linesSrc = Array.isArray(raw.lineItems) && raw.lineItems.length ? raw.lineItems : [{ quantity:'', item:'', price:'' }];
    const lines = linesSrc.map((li) => ({
      quantity: String(li.quantity ?? li.qty ?? ''),
      item: String(li.item ?? li.description ?? ''),
      price: li.price != null && li.price !== '' ? String(li.price) : li.unitPrice != null && li.unitPrice !== '' ? String(li.unitPrice) : '',
    }));
    setForm({
      date: raw.date || today(),
      from: raw.from || blankForm().from,
      fromContact: raw.fromContact || '',
      to: raw.to || blankForm().to,
      toContact: raw.toContact || '',
      notes: raw.notes || '',
      lineItems: lines.length ? lines : [{ quantity:'', item:'', price:'' }],
    });
    setEditingTransferId(raw.id);
    setShowForm(true);
  }

  function closeTransferForm() {
    setShowForm(false);
    setEditingTransferId(null);
    setForm(blankForm());
  }
  function openNewTransferForm() {
    setEditingTransferId(null);
    setForm(blankForm());
    setShowForm(true);
  }

  function saveTransferInvoice() {
    const lines = form.lineItems
      .map(l => {
        const price = parseFloat(l.price) || 0;
        const commission = +(price * COMMISSION_RATE).toFixed(2);
        const total = +(price + commission).toFixed(2);
        return {
          quantity: (l.quantity || '').trim(),
          item: (l.item || '').trim(),
          price: +price.toFixed(2),
          commission,
          total
        };
      })
      .filter(l => l.item && (l.quantity || l.price > 0));
    if (!lines.length) { showToast('Add at least one line item.', 'error'); return; }
    if (!form.date) { showToast('Date is required.', 'error'); return; }

    const subTotal = +lines.reduce((s, l) => s + l.price, 0).toFixed(2);
    const commissionTotal = +lines.reduce((s, l) => s + l.commission, 0).toFixed(2);
    const grandTotal = +(subTotal + commissionTotal).toFixed(2);
    if (editingTransferId) {
      const prev = transferInvoices.find((x) => x.id === editingTransferId);
      if (!prev) { showToast('Invoice not found.', 'error'); return; }
      const invoice = {
        ...prev,
        date: form.date,
        from: form.from,
        fromContact: form.fromContact.trim(),
        to: form.to,
        toContact: form.toContact.trim(),
        notes: form.notes.trim(),
        lineItems: lines,
        commissionRate: COMMISSION_RATE,
        subTotal,
        commissionTotal,
        grandTotal,
      };
      const updated = transferInvoices.map((x) => (x.id === editingTransferId ? invoice : x));
      setTransferInvoices(updated);
      save('transferInvoices', updated);
      logActivity('edit_item', 'Updated transfer invoice ' + invoice.id);
      showToast('Transfer invoice updated.');
      setForm(blankForm());
      setShowForm(false);
      setEditingTransferId(null);
      return;
    }
    const invoice = {
      id: nextTransferId(form.date),
      invoiceType: 'pp_transfer',
      status: 'unpaid',
      date: form.date,
      from: form.from,
      fromContact: form.fromContact.trim(),
      to: form.to,
      toContact: form.toContact.trim(),
      notes: form.notes.trim(),
      lineItems: lines,
      commissionRate: COMMISSION_RATE,
      subTotal,
      commissionTotal,
      grandTotal,
      createdAt: new Date().toISOString()
    };
    const updated = [...transferInvoices, invoice];
    setTransferInvoices(updated);
    save('transferInvoices', updated);
    logActivity('create_invoice', 'Created transfer invoice ' + invoice.id);
    showToast('Transfer invoice created.');
    setForm(blankForm());
    setShowForm(false);
  }

  function deleteTransferInvoice(id) {
    const updated = transferInvoices.filter(x => x.id !== id);
    setTransferInvoices(updated);
    save('transferInvoices', updated);
    setConfirmId(null);
    logActivity('delete_invoice', 'Deleted transfer invoice ' + id);
    showToast('Transfer invoice deleted.');
  }
  function exportTransferExcel() {
    const byMonth = {};
    sorted.forEach(inv => {
      const d = inv.date || today();
      const k = d.slice(0,7);
      if (!byMonth[k]) byMonth[k] = [];
      inv.lineItems.forEach(li => {
        byMonth[k].push({
          Date: d,
          Quantity: li.quantity || '',
          Item: li.item || '',
          Price: li.price ?? 0,
          '15% commission': li.commission ?? 0,
          Total: li.total ?? 0,
          'Invoice #': inv.id
        });
      });
    });
    const wb = XLSX.utils.book_new();
    const monthKeys = Object.keys(byMonth).sort();
    if (!monthKeys.length) {
      const ws = XLSX.utils.json_to_sheet([{ Date:'', Quantity:'', Item:'', Price:'', '15% commission':'', Total:'', 'Invoice #':'' }]);
      XLSX.utils.book_append_sheet(wb, ws, 'Transfers');
    } else {
      monthKeys.forEach(k => {
        const ws = XLSX.utils.json_to_sheet(byMonth[k]);
        const sheetName = (() => {
          try { return new Date(k + '-01').toLocaleString('en-US',{month:'long',year:'numeric'}).replace(',',''); }
          catch { return k; }
        })();
        XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0,31));
      });
    }
    XLSX.writeFile(wb, `pp-hackensack-to-englewood-${today()}.xlsx`);
    logActivity('export_xlsx', 'Exported transfer invoices Excel');
    showToast('Transfer invoices exported to Excel.');
  }

  const sorted = useMemo(() => [...transferInvoices].map(normalizeTransferInvoice).sort((a, b) => (b.date || '').localeCompare(a.date || '')), [transferInvoices]);
  const viewInv = sorted.find(x => x.id === viewId);

  return (
    <div>
      <div className="flex-between mb-3 flex-wrap gap-2">
        <div className="section-title" style={{margin:0}}>🚚 P&P Transfer Invoice Generator</div>
        <div className="flex gap-2">
          <Btn className="btn-outline" onClick={exportTransferExcel}>⬇ Export Excel</Btn>
          <Btn className="btn-primary" onClick={() => (showForm ? closeTransferForm() : openNewTransferForm())}>{showForm ? 'Cancel' : '+ New Transfer Invoice'}</Btn>
        </div>
      </div>
      <p style={{fontSize:13,color:'#666',marginBottom:12}}>
        Generates internal invoices from <strong>Parathas &amp; Platters - Hackensack</strong> to <strong>Parathas &amp; Platters - Englewood</strong> using a fixed 15% commission structure.
      </p>

      {showForm && (
        <div className="card mb-3">
          {editingTransferId && (
            <div style={{fontWeight:700,color:'var(--brown)',marginBottom:12,fontSize:15}}>Editing {editingTransferId}</div>
          )}
          <div className="grid-3">
            <FI label="Date" type="date" value={form.date} onChange={e=>setForm(f=>({...f,date:e.target.value}))} />
            <FI label="From" value={form.from} onChange={e=>setForm(f=>({...f,from:e.target.value}))} />
            <FI label="To" value={form.to} onChange={e=>setForm(f=>({...f,to:e.target.value}))} />
          </div>
          <div className="grid-2">
            <FI label="From Contact (phone/email/name)" value={form.fromContact} onChange={e=>setForm(f=>({...f,fromContact:e.target.value}))} placeholder="Optional contact details" />
            <FI label="To Contact (phone/email/name)" value={form.toContact} onChange={e=>setForm(f=>({...f,toContact:e.target.value}))} placeholder="Optional contact details" />
          </div>
          <FI label="Notes (optional)" value={form.notes} onChange={e=>setForm(f=>({...f,notes:e.target.value}))} />

          <div className="flex-between mb-2">
            <label style={{margin:0}}>Line Items</label>
            <Btn className="btn-outline btn-sm" onClick={addLine}>+ Add Line</Btn>
          </div>
          <datalist id={transferItemListId}>
            {itemSuggestions.map(s => <option key={s} value={s} />)}
          </datalist>
          {form.lineItems.map((l, i)=>(
            <div key={i} style={{display:'flex',gap:8,marginBottom:8,alignItems:'center'}}>
              <input className="input" placeholder="Quantity (e.g. 10 lbs)" value={l.quantity} onChange={e=>setLine(i,'quantity',e.target.value)} style={{flex:1.2}} />
              <input className="input" placeholder="Item" value={l.item} onChange={e=>setLine(i,'item',e.target.value)} style={{flex:2.2}} list={transferItemListId} />
              <input className="input" placeholder="Price" type="number" min="0" step="0.01" value={l.price} onChange={e=>setLine(i,'price',e.target.value)} style={{flex:1}} />
              <span style={{fontSize:12,color:'#777',minWidth:80}}>+15%</span>
              <Btn className="btn-sm" style={{background:'#fee2e2',color:'#991b1b',border:'1px solid #fca5a5'}} onClick={()=>removeLine(i)}>🗑</Btn>
            </div>
          ))}
          <div className="flex gap-2" style={{justifyContent:'flex-end',marginTop:10}}>
            <Btn className="btn-outline" onClick={closeTransferForm}>Cancel</Btn>
            <Btn className="btn-primary" onClick={saveTransferInvoice}>{editingTransferId ? '💾 Save Changes' : '💾 Save Transfer Invoice'}</Btn>
          </div>
        </div>
      )}

      {sorted.length===0 && <div className="card empty-state">No transfer invoices yet.</div>}
      {sorted.length>0 && (
        <div className="card">
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>ID</th><th>Date</th><th>From</th><th>To</th><th>Total</th><th></th></tr></thead>
              <tbody>
                {sorted.map(inv=>(
                  <tr key={inv.id}>
                    <td>{inv.id}</td>
                    <td>{fmtDate(inv.date)}</td>
                    <td>{inv.from}</td>
                    <td>{inv.to}</td>
                    <td style={{fontWeight:700}}>{fmt$(inv.grandTotal)}</td>
                    <td>
                      <div className="flex gap-2">
                        <Btn className="btn-outline btn-sm" onClick={()=>setViewId(inv.id)}>View</Btn>
                        <Btn className="btn-secondary btn-sm" onClick={()=>openTransferEdit(inv)}>Edit</Btn>
                        {inv.status!=='paid'&&<Btn className="btn-success btn-sm" onClick={()=>{
                          const updated=transferInvoices.map(x=>x.id===inv.id?{...x,status:'paid'}:x);
                          setTransferInvoices(updated); save('transferInvoices',updated); showToast('Transfer invoice marked paid.');
                        }}>Paid</Btn>}
                        <Btn className="btn-sm" style={{background:'#fee2e2',color:'#991b1b',border:'1px solid #fca5a5'}} onClick={()=>setConfirmId(inv.id)}>Delete</Btn>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Modal open={!!viewInv} onClose={()=>setViewId(null)} title={`Transfer Invoice ${viewInv?.id || ''}`} wide maxW={900} closeOnBackdrop>
        {viewInv && (
          <div id={`transfer-view-${viewInv.id}`}>
            <div className="flex-between mb-4" style={{flexWrap:'wrap',gap:10}}>
              <div style={{display:'flex',alignItems:'center',gap:10}}>
                <BrandMark brand={getInvoiceBranding(viewInv, brandingMap)} />
                <div>
                  <div style={{fontWeight:800,fontSize:18,color:'var(--brown)'}}>{getInvoiceBranding(viewInv, brandingMap).name}</div>
                  <div style={{fontSize:13,color:'#666'}}>{getInvoiceBranding(viewInv, brandingMap).location}</div>
                </div>
              </div>
              <div style={{textAlign:'right',fontSize:13}}>
                <div style={{fontWeight:800,fontSize:18,color:'var(--brown)'}}>{viewInv.id}</div>
                <div>Date: {fmtDate(viewInv.date)}</div>
                <span className={`badge badge-${viewInv.status||'unpaid'}`} style={{marginTop:4,display:'inline-block'}}>{viewInv.status||'unpaid'}</span>
              </div>
            </div>
            <div className="card" style={{padding:12,marginBottom:12,background:'#fffdf8'}}>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,fontSize:13}}>
                <div>
                  <strong>From:</strong> {viewInv.from}
                  {viewInv.fromContact && <div style={{color:'#666',fontSize:12,marginTop:2}}>{viewInv.fromContact}</div>}
                </div>
                <div>
                  <strong>To:</strong> {viewInv.to}
                  {viewInv.toContact && <div style={{color:'#666',fontSize:12,marginTop:2}}>{viewInv.toContact}</div>}
                </div>
              </div>
            </div>
            <div className="tbl-wrap mb-3">
              <table>
                <thead><tr><th>Quantity</th><th>Item</th><th>Price</th><th>15% commission</th><th>Total</th></tr></thead>
                <tbody>
                  {viewInv.lineItems.map((l,i)=>(
                    <tr key={i}>
                      <td>{l.quantity}</td>
                      <td>{l.item}</td>
                      <td>{fmt$(l.price)}</td>
                      <td>{fmt$(l.commission)}</td>
                      <td style={{fontWeight:700}}>{fmt$(l.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{textAlign:'right',fontSize:14}}>
              <div>Subtotal: <strong>{fmt$(viewInv.subTotal)}</strong></div>
              <div>Commission: <strong>{fmt$(viewInv.commissionTotal)}</strong></div>
              <div style={{fontSize:16,color:'var(--brown)'}}>Grand Total: <strong>{fmt$(viewInv.grandTotal)}</strong></div>
            </div>
            {viewInv.notes&&<div style={{marginTop:12,fontSize:13,color:'#666'}}><strong>Notes:</strong> {viewInv.notes}</div>}
            <div className="flex gap-2" style={{justifyContent:'flex-end',marginTop:16}}>
              <Btn className="btn-outline" onClick={()=>printInvoiceById(`transfer-view-${viewInv.id}`)}>🖨 Print / Save PDF</Btn>
              <Btn className="btn-secondary" onClick={()=>{const v=viewInv; setViewId(null); openTransferEdit(v);}}>Edit</Btn>
              <Btn className="btn-primary" onClick={()=>setViewId(null)}>Close</Btn>
            </div>
          </div>
        )}
      </Modal>

      <Confirm
        open={!!confirmId}
        title="Delete transfer invoice?"
        message={
          pendingDeleteTransfer
            ? `Permanently remove ${pendingDeleteTransfer.id} (${fmtDate(pendingDeleteTransfer.date || '')}) on this device?`
            : 'Permanently remove this transfer invoice on this device?'
        }
        detail="This cannot be undone here. Export a backup from Settings if you might need to recover this record."
        dangerCode="DMG-E012 (local data change)"
        confirmLabel="Delete invoice"
        onConfirm={() => deleteTransferInvoice(confirmId)}
        onCancel={() => setConfirmId(null)}
      />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// TAB 8 — PRICE HISTORY
// ═══════════════════════════════════════════════════════════
function PriceHistory({ items, priceHistory, setPriceHistory }) {
  const [selId,setSelId]=useState('');
  const [confirmId,setConfirmId]=useState(null);
  const selItem=items.find(i=>i.id===selId);
  const hist=useMemo(()=>priceHistory.filter(h=>h.itemId===selId).sort((a,b)=>a.date.localeCompare(b.date)),[selId,priceHistory]);
  const pendingDeleteHistEntry = useMemo(
    () => (confirmId ? priceHistory.find((h) => h.id === confirmId) : null),
    [confirmId, priceHistory]
  );
  const sellers=useMemo(()=>[...new Set(hist.map(h=>h.seller))],[hist]);
  const chartData=useMemo(()=>{
    if(!hist.length) return [];
    const dates=[...new Set(hist.map(h=>h.date))].sort();
    const last={};sellers.forEach(s=>{last[s]=null;});
    return dates.map(date=>{
      hist.filter(h=>h.date===date).forEach(e=>{last[e.seller]=e.newPrice;});
      return{date:fmtDate(date),...Object.fromEntries(sellers.map(s=>[s,last[s]]))};
    });
  },[hist,sellers]);

  function delEntry(id){const u=priceHistory.filter(h=>h.id!==id);setPriceHistory(u);save('priceHistory',u);setConfirmId(null);}

  return (
    <div>
      <div className="section-title">Price History</div>
      <div className="card mb-4">
        <label>Select Item to View Price Trends</label>
        <select className="input" value={selId} onChange={e=>setSelId(e.target.value)}>
          <option value="">— Choose an item —</option>
          {items.map(i=><option key={i.id} value={i.id}>{i.name} ({i.category})</option>)}
        </select>
      </div>

      {!selId&&items.length>0&&<div className="card empty-state">Select an item above to see how its prices changed over time.</div>}
      {items.length===0&&<div className="card empty-state">No items yet. Add items in the Item Database tab first.</div>}
      {selId&&hist.length===0&&(
        <div className="card empty-state">
          No price history for <strong>{selItem?.name}</strong> yet.<br/>
          <span style={{fontSize:13,color:'#bbb'}}>Price changes are recorded automatically when you edit a seller's price.</span>
        </div>
      )}

      {hist.length>0&&(
        <>
          {chartData.length>1 && (
            <Suspense fallback={<div className="card mb-4 text-muted" style={{ padding: 24, textAlign: 'center' }}>Loading chart…</div>}>
              <LazyPriceHistoryChart
                chartData={chartData}
                sellers={sellers}
                itemLabel={`${selItem?.name} (${selItem?.unit})`}
                fmt$={fmt$}
                chartColors={CHART_COLORS}
              />
            </Suspense>
          )}
          <div className="card" style={{padding:0}}>
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>Date</th><th>Seller</th><th>Old Price</th><th>New Price</th><th>Change</th><th></th></tr></thead>
                <tbody>
                  {[...hist].reverse().map(h=>{
                    const diff=h.newPrice-h.oldPrice;
                    const pct=h.oldPrice?(diff/h.oldPrice*100).toFixed(1)+'%':'—';
                    return (
                      <tr key={h.id}>
                        <td>{fmtDate(h.date)}</td>
                        <td style={{fontWeight:600}}>{h.seller}</td>
                        <td>{fmt$(h.oldPrice)}</td>
                        <td style={{fontWeight:600}}>{fmt$(h.newPrice)}</td>
                        <td style={{fontWeight:600,color:diff>0?'var(--danger)':'var(--success)'}}>{diff>0?'▲':'▼'} {fmt$(Math.abs(diff))} ({pct})</td>
                        <td><Btn className="btn-danger btn-sm" onClick={()=>setConfirmId(h.id)}>✕</Btn></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
      <Confirm
        open={!!confirmId}
        title="Delete price history row?"
        message={
          pendingDeleteHistEntry
            ? `Remove the ${fmtDate(pendingDeleteHistEntry.date)} price change for "${pendingDeleteHistEntry.seller}" on "${selItem?.name || 'item'}"?`
            : 'Remove this price history row?'
        }
        detail="This only deletes the audit row, not the current item price. Export a backup if unsure."
        dangerCode="DMG-E012 (local data change)"
        confirmLabel="Delete row"
        onConfirm={() => delEntry(confirmId)}
        onCancel={() => setConfirmId(null)}
      />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// PRICE UPDATER
// ═══════════════════════════════════════════════════════════
function PriceUpdater({ items, setItems, priceHistory, setPriceHistory }) {
  const [search, setSearch] = useState('');
  const [edits, setEdits] = useState({});
  const sellerEditKey = (itemId, sellerName, sellerIdx) => itemId+'|'+sellerKey(sellerName)+'|'+sellerIdx;

  const filtered = useMemo(() => {
    if (!search.trim()) return items;
    const q = search.toLowerCase();
    return items.filter(i => i.name.toLowerCase().includes(q) || (i.category||'').toLowerCase().includes(q));
  }, [items, search]);

  function setPrice(itemId, sellerName, val, sellerIdx) {
    setEdits(prev => ({ ...prev, [sellerEditKey(itemId, sellerName, sellerIdx)]: val }));
  }
  function hasChanges(item) { return Object.keys(edits).some(k => k.startsWith(item.id+'|')); }
  function hasSellerChange(itemId, sellerName, sellerIdx) { return edits[sellerEditKey(itemId, sellerName, sellerIdx)] !== undefined; }

  function saveItem(item) {
    let valid = true;
    const newSellers = item.sellers.map((s, sellerIdx) => {
      const key = sellerEditKey(item.id, s.name, sellerIdx);
      if (edits[key] !== undefined) {
        const val = edits[key];
        if (val !== '' && safePrice(val) === null) { showToast('Invalid price for ' + s.name, 'error'); valid = false; return s; }
        return { ...s, price: val==='' ? null : safePrice(val) };
      }
      return s;
    });
    if (!valid) return;

    const newHist = [];
    item.sellers.forEach((s, sellerIdx) => {
      const key = sellerEditKey(item.id, s.name, sellerIdx);
      if (edits[key] !== undefined) {
        const newPrice = edits[key]==='' ? null : safePrice(edits[key]);
        const oldPrice = s.price !== undefined ? s.price : null;
        if (oldPrice !== newPrice && oldPrice !== null && newPrice !== null)
          newHist.push({ id:uid(), itemId:item.id, itemName:item.name, seller:s.name, oldPrice, newPrice, date:today() });
      }
    });
    if (newHist.length) { const h=[...priceHistory,...newHist]; setPriceHistory(h); save('priceHistory',h); }

    const updated = items.map(i => i.id===item.id ? {...i, sellers:newSellers} : i);
    setItems(updated); save('items', updated);

    const remaining = {...edits};
    Object.keys(remaining).forEach(k => { if (k.startsWith(item.id+'|')) delete remaining[k]; });
    setEdits(remaining);
    logActivity('update_prices', item.name);
    showToast('Prices saved for ' + item.name);
  }

  return (
    <div>
      <div className="section-title">💰 Price Updater</div>
      <div style={{background:'#dbeafe',color:'#1d4ed8',borderRadius:8,padding:'12px 16px',marginBottom:16,fontSize:13.5,lineHeight:1.6}}>
        Update prices for each supplier below. Changed fields are highlighted. Click <strong>Save Prices</strong> to save an item's changes — price history is recorded automatically.
      </div>
      <input className="input mb-4" placeholder="Search items by name or category…" value={search} onChange={e=>setSearch(e.target.value)} />
      {items.length===0 && <div className="card empty-state">No items yet. Use the Add Items tab to add items first.</div>}
      {items.length>0 && filtered.length===0 && <div className="card empty-state">No items match your search.</div>}
      {filtered.map(item=>(
        <div key={item.id} className="card mb-3">
          <div className="flex-between mb-3">
            <div>
              <div style={{fontWeight:700,fontSize:15,color:'var(--brown)'}}>{item.name}</div>
              <div style={{fontSize:12,color:'#888'}}>{item.category} · per {item.unit}</div>
            </div>
            <Btn className={'btn-primary btn-sm'+(hasChanges(item)?'':' btn-disabled')} onClick={()=>saveItem(item)} disabled={!hasChanges(item)} title={hasChanges(item)?'Save changes':'No changes to save'}>
              💾 Save Prices
            </Btn>
          </div>
          {(!item.sellers||item.sellers.length===0)
            ? <div style={{fontSize:13,color:'#aaa'}}>No suppliers added. Edit this item in the Item Database to add suppliers.</div>
            : item.sellers.map((s, sellerIdx) => {
                const key = sellerEditKey(item.id, s.name, sellerIdx);
                const changed = hasSellerChange(item.id, s.name, sellerIdx);
                const val = changed ? edits[key] : (s.price!=null ? String(s.price) : '');
                return (
                  <div key={s.name} style={{display:'flex',alignItems:'center',gap:10,marginBottom:8,padding:'8px 12px',borderRadius:6,background:changed?'#FFF8DC':'#f9f9f9',border:changed?'1px solid #DEB887':'1px solid #eee'}}>
                    <span style={{flex:2,fontWeight:600,color:'#5a3010',fontSize:14}}>{s.name}</span>
                    <input className="input" type="number" min="0" step="0.01" value={val} placeholder="Enter price"
                      onChange={e=>setPrice(item.id,s.name,e.target.value,sellerIdx)}
                      style={{flex:1.5,borderColor:changed?'var(--brown)':undefined}} />
                    <span style={{fontSize:13,color:'#888',minWidth:40}}>/{item.unit}</span>
                    {s.price!=null && <span style={{fontSize:11,color:'#aaa',whiteSpace:'nowrap'}}>saved: {fmt$(s.price)}</span>}
                  </div>
                );
              })
          }
        </div>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// ACTIVITY LOG
// ═══════════════════════════════════════════════════════════
function ActivityLog() {
  const [log, setLog] = useState(() => load('_activityLog',[]));
  const [userF, setUserF] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [showClearLogConfirm, setShowClearLogConfirm] = useState(false);

  function refresh() { setLog(load('_activityLog',[])); showToast('Log refreshed'); }
  function clearLog() {
    setShowClearLogConfirm(true);
  }
  function confirmClearLog() {
    setShowClearLogConfirm(false);
    save('_activityLog',[]); setLog([]);
    showToast('Activity log cleared');
  }

  const users = useMemo(()=>[...new Set(log.map(e=>e.username))],[log]);

  const filtered = useMemo(()=>{
    let r = [...log].reverse();
    if (userF!=='all') r = r.filter(e=>e.username===userF);
    if (dateFrom) r = r.filter(e=>e.timestamp&&e.timestamp.slice(0,10)>=dateFrom);
    if (dateTo)   r = r.filter(e=>e.timestamp&&e.timestamp.slice(0,10)<=dateTo);
    return r;
  },[log,userF,dateFrom,dateTo]);

  const ACTION_LABELS = {login:'Logged In',logout:'Logged Out',view_tab:'Viewed Page',tab_change:'Viewed Page',update_prices:'Updated Prices',add_item:'Added Item',edit_item:'Edited Item',delete_item:'Deleted Item',create_invoice:'Created Invoice',delete_invoice:'Deleted Invoice',mark_paid:'Marked Paid',add_customer:'Added Customer',edit_customer:'Edited Customer',delete_customer:'Deleted Customer',profile_update:'Updated Profile',restore_backup:'Restored Backup',export_backup:'Exported Backup',export_csv:'Exported CSV',export_xlsx:'Exported Excel',admin_password_reset:'Admin Password Reset'};
  const fmtAction = a => ACTION_LABELS[a] || (a ? a.charAt(0).toUpperCase()+a.slice(1) : '');

  return (
    <div>
      <div className="flex-between mb-3 flex-wrap gap-2">
        <div style={{display:'flex',alignItems:'center',gap:10}}>
          <span className="section-title" style={{margin:0}}>🔍 Activity Log</span>
          <span className="badge badge-user">{log.length} entries</span>
        </div>
        <div className="flex gap-2">
          <Btn className="btn-outline btn-sm" onClick={refresh}>↻ Refresh</Btn>
          <Btn className="btn-danger btn-sm" onClick={clearLog}>🗑 Clear Log</Btn>
        </div>
      </div>
      <p style={{fontSize:13,color:'#666',marginBottom:14}}>All user actions are automatically recorded here. Use filters to find specific activity.</p>

      <div className="card mb-3" style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(145px,1fr))',gap:12}}>
        <div className="field" style={{margin:0}}>
          <label>User</label>
          <select className="input" value={userF} onChange={e=>setUserF(e.target.value)}>
            <option value="all">All Users</option>
            {users.map(u=><option key={u} value={u}>{u}</option>)}
          </select>
        </div>
        <div className="field" style={{margin:0}}><label>From Date</label><input className="input" type="date" value={dateFrom} onChange={e=>setDateFrom(e.target.value)} /></div>
        <div className="field" style={{margin:0}}><label>To Date</label><input className="input" type="date" value={dateTo} onChange={e=>setDateTo(e.target.value)} /></div>
      </div>

      <div style={{fontSize:13,color:'#666',marginBottom:12,display:'flex',alignItems:'center',gap:10,flexWrap:'wrap'}}>
        <span>Showing <strong>{filtered.length}</strong> of {log.length} entries</span>
        {(userF!=='all'||dateFrom||dateTo) && <Btn className="btn-sm" style={{background:'#eee',color:'#666'}} onClick={()=>{setUserF('all');setDateFrom('');setDateTo('');}}>✕ Clear Filters</Btn>}
      </div>

      {log.length===0 && <div className="card empty-state">No activity logged yet. Actions are recorded automatically as users interact with the app.</div>}
      {log.length>0 && filtered.length===0 && <div className="card empty-state">No entries match the current filters.</div>}
      {filtered.length>0 && (
        <div className="card" style={{padding:0}}>
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Time</th><th>User</th><th>Action</th><th>Details</th></tr></thead>
              <tbody>
                {filtered.map((e,i)=>(
                  <tr key={e.id||i}>
                    <td style={{fontFamily:'monospace',fontSize:12,whiteSpace:'nowrap'}}>{e.timestamp ? new Date(e.timestamp).toLocaleString() : ''}</td>
                    <td><span className={'badge badge-'+(e.username==='admin'?'admin':'user')}>{e.username}</span></td>
                    <td style={{fontWeight:600,fontSize:13}}>{fmtAction(e.action)}</td>
                    <td style={{fontSize:13,color:'#666'}}>{e.details}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <Confirm
        open={showClearLogConfirm}
        title="Clear activity log?"
        message="Remove all recorded actions from this device’s activity log."
        detail="This cannot be undone. Invoices and other business data are not deleted — only the audit trail here."
        dangerCode="DMG-E012 (local data change)"
        confirmLabel="Clear log"
        confirmClass="btn-danger"
        onConfirm={confirmClearLog}
        onCancel={() => setShowClearLogConfirm(false)}
      />
    </div>
  );
}

function ScanDatabaseBeta({ currentUser, onAuthHashSaved, isOnline }) {
  const [pwd, setPwd] = useState('');
  const [status, setStatus] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [backendDown, setBackendDown] = useState(false);
  const [config, setConfig] = useState({ inboxPath:'', libraryPath:'', enabled:false });
  const [filters, setFilters] = useState({ q:'', sender:'', docType:'', year:'', month:'', businessTag:'', status:'' });
  const [results, setResults] = useState([]);
  const [selectedIds, setSelectedIds] = useState([]);
  const [bulkBusiness, setBulkBusiness] = useState('');
  const [bulkType, setBulkType] = useState('');
  const [bulkStatus, setBulkStatus] = useState('');

  const hasAuth = !!currentUser?.authHash;

  async function refreshStatus(silent) {
    if (!hasAuth) return;
    const res = await scanApiCall('/api/scan/status', { currentUser });
    if (!res.ok) {
      if (!silent) toastApiFailure(res, 'Scanner unavailable');
      setErr(res.error || 'Failed to load scanner status');
      if (res.code === 'DMG-E021' || res.code === 'DMG-E030') setBackendDown(true);
      return;
    }
    setBackendDown(false);
    setErr('');
    setStatus(res.data);
    setConfig(res.data.config || { inboxPath:'', libraryPath:'', enabled:false });
  }
  async function runSearch(silent) {
    if (!hasAuth) return;
    const q = {};
    Object.entries(filters).forEach(([k,v]) => { if (String(v||'').trim()) q[k] = v; });
    const res = await scanApiCall('/api/scan/search', { currentUser, query:q });
    if (!res.ok) {
      if (!silent) toastApiFailure(res, 'Search failed');
      setErr(res.error || 'Search failed');
      return;
    }
    setErr('');
    setResults(res.data.items || []);
  }
  useEffect(() => {
    if (!hasAuth) return;
    refreshStatus(true);
    runSearch(true);
    const t = setInterval(() => { refreshStatus(true); }, 12000);
    return () => clearInterval(t);
  }, [hasAuth]);

  async function unlockAdmin() {
    setErr('');
    if (!pwd) { setErr('Enter admin password.'); return; }
    const authHash = await hashPwd(pwd);
    const probeUser = { ...currentUser, authHash };
    const probe = await scanApiCall('/api/scan/status', { currentUser: probeUser });
    if (!probe.ok) {
      toastApiFailure(probe, 'Scanner unreachable');
      setErr('Admin authentication failed.');
      return;
    }
    onAuthHashSaved(authHash);
    setPwd('');
  }
  async function saveConfig(nextEnabled = config.enabled) {
    setBusy(true);
    const res = await scanApiCall('/api/scan/config', {
      currentUser,
      method:'POST',
      body:{ inboxPath: config.inboxPath, libraryPath: config.libraryPath, enabled: !!nextEnabled }
    });
    setBusy(false);
    if (!res.ok) {
      toastApiFailure(res, 'Save failed');
      setErr(res.error || 'Save failed');
      return;
    }
    setErr('');
    setConfig(res.data.config);
    refreshStatus();
  }
  async function scanNow() {
    setBusy(true);
    const res = await scanApiCall('/api/scan/scan-now', { currentUser, method:'POST' });
    setBusy(false);
    if (!res.ok) {
      toastApiFailure(res, 'Scan failed');
      setErr(res.error || 'Scan failed');
      return;
    }
    showToast('Scan completed.');
    refreshStatus();
    runSearch();
  }
  async function updateOne(item, patch) {
    const res = await scanApiCall(`/api/scan/update/${item.id}`, { currentUser, method:'POST', body: patch });
    if (!res.ok) {
      toastApiFailure(res, 'Update failed');
      setErr(res.error || 'Update failed');
      return;
    }
    runSearch();
  }
  async function bulkApply() {
    if (!selectedIds.length) return;
    const res = await scanApiCall('/api/scan/bulk-tag', {
      currentUser,
      method:'POST',
      body:{ ids:selectedIds, businessTag:bulkBusiness, docType:bulkType, status:bulkStatus }
    });
    if (!res.ok) {
      toastApiFailure(res, 'Bulk update failed');
      setErr(res.error || 'Bulk update failed');
      return;
    }
    showToast(`Updated ${res.data.updated} documents.`);
    setSelectedIds([]);
    runSearch();
  }
  async function exportDb() {
    const res = await scanApiCall('/api/scan/export', { currentUser });
    if (!res.ok) {
      toastApiFailure(res, 'Export failed');
      setErr(res.error || 'Export failed');
      return;
    }
    const blob = new Blob([JSON.stringify(res.data.data, null, 2)], { type:'application/json;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `scan-db-backup-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  async function importDb(file) {
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const res = await scanApiCall('/api/scan/import', { currentUser, method:'POST', body:{ data } });
      if (!res.ok) {
        toastApiFailure(res, 'Import failed');
        setErr(res.error || 'Import failed');
        return;
      }
      showToast('Backup imported.');
      refreshStatus();
      runSearch();
    } catch {
      setErr('Invalid backup file.');
    }
  }

  return (
    <div className="card">
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10,flexWrap:'wrap',gap:8}}>
        <h2 style={{margin:0}}>Scanned Documents Database <span className="badge badge-user" style={{marginLeft:8}}>BETA · WIP</span></h2>
        <div style={{fontSize:12,color:'#555'}}>Admin-only local-device scanner index</div>
      </div>
      {(!isOnline || backendDown) && <BackendUnavailableBanner code={backendDown ? 'DMG-E021' : 'DMG-E030'} />}
      {!hasAuth && (
        <div style={{background:'#FFF8DC',border:'1px solid #DEB887',borderRadius:8,padding:12,marginBottom:12}}>
          <div style={{fontWeight:700,marginBottom:6}}>Unlock admin scanner controls</div>
          <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center'}}>
            <input className="input" type="password" placeholder="Enter admin password" value={pwd} onChange={e=>setPwd(e.target.value)} style={{maxWidth:280}} />
            <Btn className="btn-primary btn-sm" onClick={unlockAdmin}>Unlock</Btn>
          </div>
        </div>
      )}
      {err && <div style={{background:'#fee2e2',color:'#991b1b',padding:'8px 12px',borderRadius:6,marginBottom:10,fontSize:12.5}}>{err}</div>}
      {hasAuth && (
        <>
          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(220px,1fr))',gap:10,marginBottom:12}}>
            <FI label="Watch Inbox Folder" value={config.inboxPath || ''} onChange={e=>setConfig(c=>({ ...c, inboxPath:e.target.value }))} placeholder="C:\\Scans\\Inbox" />
            <FI label="Library Root Folder" value={config.libraryPath || ''} onChange={e=>setConfig(c=>({ ...c, libraryPath:e.target.value }))} placeholder="C:\\Scans\\Library" />
          </div>
          <div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:12}}>
            <Btn className="btn-outline btn-sm" disabled={busy} onClick={()=>saveConfig(config.enabled)}>💾 Save Config</Btn>
            <Btn className="btn-primary btn-sm" disabled={busy} onClick={()=>saveConfig(!config.enabled)}>{config.enabled ? '⏸ Stop Watcher' : '▶ Start Watcher'}</Btn>
            <Btn className="btn-outline btn-sm" disabled={busy} onClick={scanNow}>🔎 Scan Now</Btn>
            <Btn className="btn-outline btn-sm" onClick={exportDb}>⬇ Export Backup</Btn>
            <label className="btn btn-outline btn-sm" style={{margin:0,cursor:'pointer'}}>
              ⬆ Import Backup
              <input type="file" accept=".json" style={{display:'none'}} onChange={e=>{importDb(e.target.files?.[0]);e.target.value='';}} />
            </label>
          </div>
          {status && (
            <div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:12,fontSize:12.5}}>
              <span className="badge badge-admin">Total: {status.counts?.total || 0}</span>
              <span className="badge badge-user">Needs Review: {status.counts?.needsReview || 0}</span>
              <span className="badge badge-user">Failures: {status.counts?.failures || 0}</span>
              <span className="badge badge-user">Polling: {status.pollMs}ms</span>
            </div>
          )}
          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(160px,1fr))',gap:8,marginBottom:10}}>
            <input className="input" placeholder="Search text/sender/type" value={filters.q} onChange={e=>setFilters(f=>({ ...f, q:e.target.value }))} />
            <input className="input" placeholder="Sender" value={filters.sender} onChange={e=>setFilters(f=>({ ...f, sender:e.target.value }))} />
            <select className="input" value={filters.docType} onChange={e=>setFilters(f=>({ ...f, docType:e.target.value }))}>
              <option value="">All Types</option>
              {SCAN_DOC_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <input className="input" placeholder="Year (e.g. 2026)" value={filters.year} onChange={e=>setFilters(f=>({ ...f, year:e.target.value }))} />
            <input className="input" placeholder="Month (e.g. March)" value={filters.month} onChange={e=>setFilters(f=>({ ...f, month:e.target.value }))} />
            <select className="input" value={filters.businessTag} onChange={e=>setFilters(f=>({ ...f, businessTag:e.target.value }))}>
              <option value="">All Businesses</option>
              <option value="degrill">degrill</option>
              <option value="parathas">parathas</option>
              <option value="dera">dera</option>
              <option value="unknown">unknown</option>
            </select>
          </div>
          <div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:10}}>
            <Btn className="btn-outline btn-sm" onClick={()=>runSearch(false)}>Search</Btn>
            <select className="input" style={{maxWidth:160}} value={bulkType} onChange={e=>setBulkType(e.target.value)}>
              <option value="">Bulk Type</option>
              {SCAN_DOC_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <select className="input" style={{maxWidth:160}} value={bulkStatus} onChange={e=>setBulkStatus(e.target.value)}>
              <option value="">Bulk Status</option>
              <option value="classified">classified</option>
              <option value="needs_review">needs_review</option>
            </select>
            <input className="input" style={{maxWidth:180}} placeholder="Bulk Business Tag" value={bulkBusiness} onChange={e=>setBulkBusiness(e.target.value)} />
            <Btn className="btn-outline btn-sm" onClick={bulkApply}>Apply to Selected ({selectedIds.length})</Btn>
          </div>
          <div style={{maxHeight:440,overflow:'auto',border:'1px solid #eee',borderRadius:8}}>
            <table className="table">
              <thead>
                <tr><th></th><th>Date</th><th>Sender</th><th>Type</th><th>Business</th><th>Status</th><th>File</th><th>Actions</th></tr>
              </thead>
              <tbody>
                {results.map(item => {
                  const checked = selectedIds.includes(item.id);
                  return (
                    <tr key={item.id}>
                      <td><input type="checkbox" checked={checked} onChange={e=>setSelectedIds(ids=>e.target.checked?[...new Set([...ids,item.id])]:ids.filter(x=>x!==item.id))} /></td>
                      <td>{fmtDate(String(item.importedAt||'').slice(0,10))}</td>
                      <td>{item.sender}</td>
                      <td>{item.docType}</td>
                      <td>{item.businessTag || 'unknown'}</td>
                      <td>{item.status}</td>
                      <td style={{maxWidth:220,wordBreak:'break-word'}}>{item.fileName}</td>
                      <td>
                        <Btn className="btn-outline btn-sm" onClick={()=>updateOne(item, { status:'classified' })}>Mark OK</Btn>
                      </td>
                    </tr>
                  );
                })}
                {!results.length && <tr><td colSpan={8}><div className="muted text-center">No scanned documents matched current filters.</div></td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function CheckInOutPage({ currentUser, attendanceToken, onEnterKiosk, kioskLock, selectedBusiness, payrollInvoices, setPayrollInvoices, isOnline }) {
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
    showToast(`Checked ${res.data.status === 'in' ? 'in' : 'out'} successfully.`);
    loadMe();
    loadSummary();
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
      <div style={{background:'#E8F4FC',border:'1px solid #B6DBF7',borderRadius:8,padding:'10px 12px',marginBottom:12,fontSize:12.5,color:'#1e4f72'}}>
        Scan QR, log in, then tap Check In or Check Out.
      </div>
      <div className="hint-card">Tip: If a phone is used daily, enable "Remember this device" at login.</div>
      {err && <div style={{background:'#fee2e2',color:'#991b1b',padding:'8px 12px',borderRadius:6,marginBottom:10,fontSize:12.5}}>{err}</div>}

      <div className="card mb-4">
        <div style={{fontWeight:700,color:'var(--brown)',marginBottom:8}}>My Status</div>
        <div style={{display:'flex',gap:10,flexWrap:'wrap',alignItems:'center'}}>
          {isAdmin
            ? <span style={{fontSize:13,color:'#555'}}>Admins are excluded from attendance tracking.</span>
            : <span style={{fontSize:13,color:'#555'}}>Status: <strong>{me?.active ? 'Currently Checked In' : 'Currently Checked Out'}</strong></span>}
          {!isAdmin && <span style={{fontSize:13,color:'#555'}}>This week: <strong>{me?.weekHours || 0} hours</strong></span>}
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
        </>
      )}
    </div>
  );
}


function MenuMarginsLab({ items, priceHistory, selectedBusiness }) {
  const [menuItems, setMenuItems] = useState(() => load('_menuItems', []));
  const [recipes, setRecipes] = useState(() => load('_menuRecipes', []));
  const [search, setSearch] = useState('');
  const [menuTypeF, setMenuTypeF] = useState('all');
  const [bizF, setBizF] = useState(selectedBusiness || 'all');
  const [asOfDate, setAsOfDate] = useState(today());
  const [targetMargin, setTargetMargin] = useState(32);
  const [showMenuForm, setShowMenuForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [expandedId, setExpandedId] = useState('');
  const [pendingDeleteMenuId, setPendingDeleteMenuId] = useState(null);
  const [menuForm, setMenuForm] = useState(() => ({
    name:'',
    menuType:'regular',
    category:'Main',
    defaultUnit:'each',
    basePrice:'',
    pricing:{ degrill:'', parathas:'', dera:'' },
    notes:'',
    active:true
  }));

  useEffect(() => { save('_menuItems', menuItems); }, [menuItems]);
  useEffect(() => { save('_menuRecipes', recipes); }, [recipes]);

  const toBase = (qty, unit) => {
    const q = Number(qty || 0);
    const u = String(unit || 'each').toLowerCase();
    const mult = ({ each:1, oz:1, lb:16, g:0.035274, kg:35.274, ml:0.033814, l:33.814 })[u] || 1;
    return q * mult;
  };
  const itemLatestCost = (itemId) => {
    const item = items.find(i => i.id === itemId);
    if (!item) return null;
    const sellerPrices = (item.sellers || []).map(s => safePrice(s.price)).filter(v => v !== null);
    if (!sellerPrices.length) return null;
    return Math.min(...sellerPrices);
  };
  const itemCostAtDate = (itemId, dateStr) => {
    const hist = priceHistory
      .filter(h => h.itemId === itemId && h.date <= dateStr)
      .sort((a,b) => b.date.localeCompare(a.date));
    if (hist.length) return Number(hist[0].newPrice || 0);
    return itemLatestCost(itemId);
  };
  const recipeFor = (menuItemId) => {
    const list = recipes.filter(r => r.menuItemId === menuItemId);
    if (!list.length) return null;
    return [...list].sort((a,b) => String(b.effectiveDate || '').localeCompare(String(a.effectiveDate || '')))[0];
  };
  const calcMenuMetrics = (m) => {
    const recipe = recipeFor(m.id);
    const lines = (recipe?.lines || []).map(line => {
      const invItem = items.find(i => i.id === line.itemId);
      const unitCostNow = itemLatestCost(line.itemId);
      const unitCostAtDate = itemCostAtDate(line.itemId, asOfDate);
      const qtyBase = toBase(line.qty, line.unit);
      const invBase = toBase(1, invItem?.unit || 'each');
      const scale = invBase ? (qtyBase / invBase) : 0;
      const wasteMult = 1 + (Number(line.wastePct || 0) / 100);
      return {
        ...line,
        itemName: invItem?.name || 'Unknown Item',
        unitCostNow,
        unitCostAtDate,
        lineCostNow: (unitCostNow ?? 0) * scale * wasteMult,
        lineCostAtDate: (unitCostAtDate ?? 0) * scale * wasteMult
      };
    });
    const costNow = lines.reduce((s,l)=>s+(l.lineCostNow||0),0);
    const costAtDate = lines.reduce((s,l)=>s+(l.lineCostAtDate||0),0);
    const price = Number(m.pricing?.[bizF === 'all' ? selectedBusiness : bizF] || m.basePrice || 0);
    const profitNow = price - costNow;
    const marginNow = price > 0 ? (profitNow / price * 100) : 0;
    const profitThen = price - costAtDate;
    const marginThen = price > 0 ? (profitThen / price * 100) : 0;
    const recommended = costNow > 0 ? (costNow / (1 - (targetMargin/100))) : price;
    return { price, costNow, costAtDate, profitNow, marginNow, profitThen, marginThen, recommended, lines, recipe };
  };

  const menuCategorySuggestions = useMemo(()=>uniqSuggestions(...menuItems.map(m=>m.category)),[menuItems]);
  const menuNameSuggestions = useMemo(()=>uniqSuggestions(...menuItems.map(m=>m.name)),[menuItems]);

  const filteredMenus = useMemo(() => menuItems.filter(m => {
    if (menuTypeF !== 'all' && m.menuType !== menuTypeF) return false;
    if (bizF !== 'all' && !(m.pricing && m.pricing[bizF] !== undefined)) return false;
    const q = search.toLowerCase().trim();
    if (q && !(`${m.name} ${m.category} ${m.notes || ''}`.toLowerCase().includes(q))) return false;
    return true;
  }), [menuItems, menuTypeF, bizF, search]);

  const rows = useMemo(() => filteredMenus.map(m => ({ menu:m, metrics:calcMenuMetrics(m) })), [filteredMenus, recipes, items, priceHistory, asOfDate, targetMargin, bizF, selectedBusiness]);
  const lowMarginRows = rows.filter(r => r.metrics.marginNow < Number(targetMargin || 0));
  const missingRecipeRows = rows.filter(r => !r.metrics.recipe);
  const missingCostRows = rows.filter(r => r.metrics.lines.some(l => l.unitCostNow === null || l.unitCostAtDate === null));

  function resetMenuForm() {
    setMenuForm({ name:'', menuType:'regular', category:'Main', defaultUnit:'each', basePrice:'', pricing:{degrill:'',parathas:'',dera:''}, notes:'', active:true });
    setEditingId(null);
  }
  function openEditMenu(m) {
    setEditingId(m.id);
    setMenuForm({
      name:m.name || '',
      menuType:m.menuType || 'regular',
      category:m.category || 'Main',
      defaultUnit:m.defaultUnit || 'each',
      basePrice:String(m.basePrice ?? ''),
      pricing:{
        degrill:String(m.pricing?.degrill ?? ''),
        parathas:String(m.pricing?.parathas ?? ''),
        dera:String(m.pricing?.dera ?? '')
      },
      notes:m.notes || '',
      active:m.active !== false
    });
    setShowMenuForm(true);
  }
  function saveMenuItem() {
    if (!menuForm.name.trim()) { showToast('Menu item name is required.', 'error'); return; }
    const payload = {
      id: editingId || uid(),
      name: menuForm.name.trim(),
      menuType: menuForm.menuType,
      category: menuForm.category.trim() || 'Main',
      defaultUnit: menuForm.defaultUnit || 'each',
      basePrice: Number(menuForm.basePrice || 0),
      pricing: {
        degrill: Number(menuForm.pricing.degrill || 0),
        parathas: Number(menuForm.pricing.parathas || 0),
        dera: Number(menuForm.pricing.dera || 0)
      },
      notes: menuForm.notes || '',
      active: !!menuForm.active,
      updatedAt: new Date().toISOString()
    };
    if (editingId) {
      setMenuItems(prev => prev.map(x => x.id === editingId ? payload : x));
      logActivity('update_menu_item', payload.name);
    } else {
      setMenuItems(prev => [...prev, payload]);
      logActivity('create_menu_item', payload.name);
    }
    showToast('Menu item saved.');
    setShowMenuForm(false);
    resetMenuForm();
  }
  function deleteMenuItem(menuId) {
    setPendingDeleteMenuId(menuId);
  }
  function confirmDeleteMenuItem() {
    const menuId = pendingDeleteMenuId;
    if (!menuId) return;
    setPendingDeleteMenuId(null);
    setMenuItems(prev => prev.filter(x => x.id !== menuId));
    setRecipes(prev => prev.filter(x => x.menuItemId !== menuId));
    showToast('Menu item deleted.');
  }
  function addRecipeVersion(menuId) {
    const base = {
      id: uid(),
      menuItemId: menuId,
      version: `v${recipes.filter(r => r.menuItemId===menuId).length + 1}`,
      effectiveDate: today(),
      notes: '',
      lines: [{ id:uid(), itemId:'', qty:'', unit:'each', wastePct:'' }]
    };
    setRecipes(prev => [...prev, base]);
    showToast('Recipe version added.');
  }
  function updateRecipe(recipeId, updater) {
    setRecipes(prev => prev.map(r => r.id === recipeId ? updater(r) : r));
  }
  function exportMarginsCsv() {
    const header = ['Menu Item','Type','Store','Price','Current Cost','Current Margin %','AsOf Cost','AsOf Margin %','Recommended Price','Low Margin'];
    const esc = v => `"${String(v ?? '').replace(/"/g,'""')}"`;
    const lines = rows.map(r => {
      const store = bizF === 'all' ? selectedBusiness : bizF;
      return [
        r.menu.name,
        r.menu.menuType,
        store,
        r.metrics.price.toFixed(2),
        r.metrics.costNow.toFixed(2),
        r.metrics.marginNow.toFixed(2),
        r.metrics.costAtDate.toFixed(2),
        r.metrics.marginThen.toFixed(2),
        r.metrics.recommended.toFixed(2),
        r.metrics.marginNow < Number(targetMargin||0) ? 'YES' : 'NO'
      ].map(esc).join(',');
    });
    const csv = [header.map(esc).join(','), ...lines].join('\n');
    const blob = new Blob([csv], { type:'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `menu-margins-${today()}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    showToast('Margin report exported.');
  }
  function applyRecommendedPrice(menu, metrics) {
    const store = bizF === 'all' ? selectedBusiness : bizF;
    const rounded = +Number(metrics.recommended || 0).toFixed(2);
    setMenuItems(prev => prev.map(m => {
      if (m.id !== menu.id) return m;
      return {
        ...m,
        pricing: { ...(m.pricing || {}), [store]: rounded },
        updatedAt: new Date().toISOString()
      };
    }));
    showToast(`Set ${menu.name} price to ${fmt$(rounded)} for ${BUSINESSES[store]?.name || store}.`);
    logActivity('apply_target_price', `${menu.name} -> ${store} ${rounded}`);
  }
  const topCostDrivers = (metrics) => {
    return [...(metrics.lines || [])]
      .sort((a,b) => (b.lineCostNow || 0) - (a.lineCostNow || 0))
      .slice(0, 3);
  };

  return (
    <div>
      <div className="flex-between mb-3 flex-wrap gap-2">
        <div className="section-title" style={{margin:0}}>Menu Costing & Margin Analytics</div>
        <div className="flex gap-2">
          <Btn className="btn-outline btn-sm" onClick={exportMarginsCsv}>⬇ Export Margin CSV</Btn>
          <Btn className="btn-primary btn-sm" onClick={()=>{resetMenuForm();setShowMenuForm(true);}}>+ Add Menu Item</Btn>
        </div>
      </div>
      <div style={{background:'#E8F4FC',border:'1px solid #B6DBF7',borderRadius:8,padding:'10px 12px',marginBottom:12,fontSize:12.5,color:'#1e4f72'}}>
        Define recipes once, keep grocery prices updated, and this module auto-calculates current and historical margins by menu item and store.
      </div>

      <div className="card mb-4">
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(170px,1fr))',gap:10}}>
          <div className="field" style={{margin:0}}><label>Search</label><input className="input" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Menu item/category" /></div>
          <div className="field" style={{margin:0}}><label>Menu Type</label><select className="input" value={menuTypeF} onChange={e=>setMenuTypeF(e.target.value)}><option value="all">All</option><option value="regular">Regular</option><option value="catering">Catering</option></select></div>
          <div className="field" style={{margin:0}}><label>Store</label><select className="input" value={bizF} onChange={e=>setBizF(e.target.value)}><option value="all">Current Store</option>{Object.keys(BUSINESSES).map(k=><option key={k} value={k}>{BUSINESSES[k].name}</option>)}</select></div>
          <div className="field" style={{margin:0}}><label>Cost As-Of Date</label><input className="input" type="date" value={asOfDate} onChange={e=>setAsOfDate(e.target.value)} /></div>
          <div className="field" style={{margin:0}}><label>Target Margin %</label><input className="input" type="number" min="0" max="95" step="0.5" value={targetMargin} onChange={e=>setTargetMargin(e.target.value)} /></div>
        </div>
        <div style={{marginTop:10,fontSize:13,color:'#666'}}>
          Total Items: <strong>{rows.length}</strong>
          {' · '}Below Target: <strong style={{color:lowMarginRows.length?'#991b1b':'#166534'}}>{lowMarginRows.length}</strong>
          {' · '}Missing Recipe: <strong style={{color:missingRecipeRows.length?'#991b1b':'#166534'}}>{missingRecipeRows.length}</strong>
          {' · '}Missing Cost Data: <strong style={{color:missingCostRows.length?'#991b1b':'#166534'}}>{missingCostRows.length}</strong>
        </div>
      </div>

      <div className="card mb-4" style={{padding:0}}>
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Item</th><th>Type</th><th>Store Price</th><th>Current Cost</th><th>Current Margin</th><th>As-Of Margin</th><th>Recommended Price</th><th>Recipe</th><th>Actions</th></tr></thead>
            <tbody>
              {rows.map(({menu,metrics})=>(
                <React.Fragment key={menu.id}>
                <tr>
                  <td><div style={{fontWeight:700}}>{menu.name}</div><div style={{fontSize:11,color:'#777'}}>{menu.category}</div></td>
                  <td>{menu.menuType}</td>
                  <td>{fmt$(metrics.price)}</td>
                  <td>{fmt$(metrics.costNow)}</td>
                  <td style={{fontWeight:700,color:metrics.marginNow<0?'#991b1b':metrics.marginNow<targetMargin?'#b45309':'#166534'}}>
                    {metrics.marginNow.toFixed(1)}%
                    {metrics.marginNow < 0 && <span className="badge badge-user" style={{marginLeft:6,background:'#fee2e2',color:'#991b1b'}}>NEG</span>}
                    {metrics.marginNow >= 0 && metrics.marginNow < targetMargin && <span className="badge badge-user" style={{marginLeft:6,background:'#fff7ed',color:'#b45309'}}>LOW</span>}
                  </td>
                  <td>{metrics.marginThen.toFixed(1)}%</td>
                  <td>{fmt$(metrics.recommended)}</td>
                  <td>{metrics.recipe ? `${metrics.recipe.version} (${metrics.lines.length} lines)` : <span style={{color:'#991b1b'}}>Missing</span>}</td>
                  <td style={{whiteSpace:'nowrap'}}>
                    <Btn className="btn-outline btn-sm" style={{marginRight:4}} onClick={()=>setExpandedId(v=>v===menu.id?'':menu.id)}>{expandedId===menu.id?'Hide':'Details'}</Btn>
                    <Btn className="btn-success btn-sm" style={{marginRight:4}} onClick={()=>applyRecommendedPrice(menu, metrics)}>Set Target</Btn>
                    <Btn className="btn-secondary btn-sm" style={{marginRight:4}} onClick={()=>openEditMenu(menu)}>Edit</Btn>
                    <Btn className="btn-outline btn-sm" style={{marginRight:4}} onClick={()=>addRecipeVersion(menu.id)}>+ Recipe</Btn>
                    <Btn className="btn-danger btn-sm" onClick={()=>deleteMenuItem(menu.id)}>Del</Btn>
                  </td>
                </tr>
                {expandedId===menu.id && (
                  <tr>
                    <td colSpan={9} style={{background:'#fffdf8'}}>
                      <div style={{padding:'10px 8px'}}>
                        <div style={{fontWeight:700,color:'var(--brown)',marginBottom:6}}>Top Cost Drivers</div>
                        {topCostDrivers(metrics).length ? (
                          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(180px,1fr))',gap:8}}>
                            {topCostDrivers(metrics).map((d, i) => (
                              <div key={`${menu.id}-drv-${i}`} style={{border:'1px solid #EED9B0',borderRadius:6,padding:'8px 10px',fontSize:12.5}}>
                                <div style={{fontWeight:700}}>{d.itemName}</div>
                                <div>Current Cost: <strong>{fmt$(d.lineCostNow || 0)}</strong></div>
                                <div>As-Of Cost: <strong>{fmt$(d.lineCostAtDate || 0)}</strong></div>
                              </div>
                            ))}
                          </div>
                        ) : <div style={{fontSize:12.5,color:'#777'}}>No recipe lines yet.</div>}
                        {metrics.lines.some(l => l.unitCostNow === null || l.unitCostAtDate === null) && (
                          <div style={{marginTop:8,background:'#fff7ed',border:'1px solid #fdba74',borderRadius:6,padding:'8px 10px',fontSize:12.5,color:'#9a3412'}}>
                            Missing ingredient cost data detected for one or more lines. Add supplier prices in Item Database / Price Updater for accurate margins.
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
                </React.Fragment>
              ))}
              {!rows.length && <tr><td colSpan={9}><div className="empty-state">No menu items yet. Add one to begin costing.</div></td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {menuItems.map(m => {
        const rs = recipes.filter(r => r.menuItemId === m.id).sort((a,b)=>String(b.effectiveDate).localeCompare(String(a.effectiveDate)));
        if (!rs.length) return null;
        return (
          <div className="card mb-3" key={`r-${m.id}`}>
            <div style={{fontWeight:700,color:'var(--brown)',marginBottom:8}}>Recipe Versions — {m.name}</div>
            {rs.map(r => (
              <div key={r.id} style={{border:'1px solid #EED9B0',borderRadius:8,padding:10,marginBottom:8}}>
                <div style={{display:'grid',gridTemplateColumns:'1fr 160px 160px',gap:8,marginBottom:8}}>
                  <FI label="Version" value={r.version} onChange={e=>updateRecipe(r.id, old=>({ ...old, version:e.target.value }))} />
                  <FI label="Effective Date" type="date" value={r.effectiveDate} onChange={e=>updateRecipe(r.id, old=>({ ...old, effectiveDate:e.target.value }))} />
                  <FI label="Notes" value={r.notes || ''} onChange={e=>updateRecipe(r.id, old=>({ ...old, notes:e.target.value }))} />
                </div>
                {(r.lines || []).map((ln, idx) => (
                  <div key={ln.id || idx} style={{display:'grid',gridTemplateColumns:'2fr 120px 120px 120px auto',gap:8,alignItems:'end',marginBottom:6}}>
                    <div className="field" style={{margin:0}}>
                      <label>Ingredient</label>
                      <select className="input" value={ln.itemId || ''} onChange={e=>updateRecipe(r.id, old=>({ ...old, lines: old.lines.map((x,i)=>i===idx?{...x,itemId:e.target.value}:x) }))}>
                        <option value="">Choose item</option>
                        {items.map(it=><option key={it.id} value={it.id}>{it.name} ({it.unit})</option>)}
                      </select>
                    </div>
                    <FI label="Qty" type="number" min="0" step="0.001" value={ln.qty || ''} onChange={e=>updateRecipe(r.id, old=>({ ...old, lines: old.lines.map((x,i)=>i===idx?{...x,qty:e.target.value}:x) }))} />
                    <div className="field" style={{margin:0}}>
                      <label>Unit</label>
                      <select className="input" value={ln.unit || 'each'} onChange={e=>updateRecipe(r.id, old=>({ ...old, lines: old.lines.map((x,i)=>i===idx?{...x,unit:e.target.value}:x) }))}>
                        {MENU_UNITS.map(u=><option key={u} value={u}>{u}</option>)}
                      </select>
                    </div>
                    <FI label="Waste %" type="number" min="0" step="0.1" value={ln.wastePct || ''} onChange={e=>updateRecipe(r.id, old=>({ ...old, lines: old.lines.map((x,i)=>i===idx?{...x,wastePct:e.target.value}:x) }))} />
                    <Btn className="btn-danger btn-sm" onClick={()=>updateRecipe(r.id, old=>({ ...old, lines: old.lines.filter((_,i)=>i!==idx) }))}>✕</Btn>
                  </div>
                ))}
                <Btn className="btn-outline btn-sm" onClick={()=>updateRecipe(r.id, old=>({ ...old, lines:[...(old.lines||[]),{id:uid(),itemId:'',qty:'',unit:'each',wastePct:''}] }))}>+ Ingredient Line</Btn>
              </div>
            ))}
          </div>
        );
      })}

      <Modal open={showMenuForm} onClose={()=>setShowMenuForm(false)} title={editingId?'Edit Menu Item':'Add Menu Item'} maxW={760}>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
          <FI label="Item Name" value={menuForm.name} onChange={e=>setMenuForm(f=>({ ...f, name:e.target.value }))} suggestions={menuNameSuggestions} />
          <FI label="Category" value={menuForm.category} onChange={e=>setMenuForm(f=>({ ...f, category:e.target.value }))} suggestions={menuCategorySuggestions} />
          <div className="field" style={{margin:0}}><label>Menu Type</label><select className="input" value={menuForm.menuType} onChange={e=>setMenuForm(f=>({ ...f, menuType:e.target.value }))}><option value="regular">Regular</option><option value="catering">Catering</option></select></div>
          <div className="field" style={{margin:0}}><label>Unit</label><select className="input" value={menuForm.defaultUnit} onChange={e=>setMenuForm(f=>({ ...f, defaultUnit:e.target.value }))}>{MENU_UNITS.map(u=><option key={u} value={u}>{u}</option>)}</select></div>
          <FI label="Default Price" type="number" min="0" step="0.01" value={menuForm.basePrice} onChange={e=>setMenuForm(f=>({ ...f, basePrice:e.target.value }))} />
          <FI label="Notes" value={menuForm.notes} onChange={e=>setMenuForm(f=>({ ...f, notes:e.target.value }))} />
        </div>
        <div style={{marginTop:8,paddingTop:8,borderTop:'1px solid #EED9B0'}}>
          <div style={{fontWeight:700,color:'var(--brown)',marginBottom:6,fontSize:13}}>Store Pricing Overrides</div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:10}}>
            <FI label="DeGrill" type="number" min="0" step="0.01" value={menuForm.pricing.degrill} onChange={e=>setMenuForm(f=>({ ...f, pricing:{...f.pricing,degrill:e.target.value} }))} />
            <FI label="Parathas & Platters" type="number" min="0" step="0.01" value={menuForm.pricing.parathas} onChange={e=>setMenuForm(f=>({ ...f, pricing:{...f.pricing,parathas:e.target.value} }))} />
            <FI label="Dera Masala Grill" type="number" min="0" step="0.01" value={menuForm.pricing.dera} onChange={e=>setMenuForm(f=>({ ...f, pricing:{...f.pricing,dera:e.target.value} }))} />
          </div>
        </div>
        <div className="flex gap-2" style={{justifyContent:'flex-end',marginTop:12}}>
          <Btn className="btn-outline" onClick={()=>setShowMenuForm(false)}>Cancel</Btn>
          <Btn className="btn-primary" onClick={saveMenuItem}>{editingId?'Save Changes':'Add Item'}</Btn>
        </div>
      </Modal>
      <Confirm
        open={!!pendingDeleteMenuId}
        title="Delete menu item?"
        message="This removes the menu item and every saved recipe version for it on this device."
        detail="Export a backup from Settings first if you might need to recover this data."
        dangerCode="DMG-E012 (local data change)"
        confirmLabel="Delete menu item"
        confirmClass="btn-danger"
        onConfirm={confirmDeleteMenuItem}
        onCancel={() => setPendingDeleteMenuId(null)}
      />
    </div>
  );
}
// ═══════════════════════════════════════════════════════════
function App() {
  useEffect(() => { initGlobalFailureCapture(); }, []);
  const attendanceParams = useMemo(() => parseAttendanceParams(), []);

  const bootWarnings = useMemo(() => getBootCapabilityWarnings(), []);
  const online = useOnlineStatus();

  useEffect(() => {
    bootWarnings.forEach((w) => reportError(w.code, { phase: 'boot_caps', detail: w.message }));
  }, [bootWarnings]);

  const [currentUser, setCurrentUser] = useState(()=>load('_session',null));
  const [tab, setTab] = useState('items');
  const [biz, setBiz] = useState(()=>load('_lastBiz','degrill'));
  const [logoOverrides, setLogoOverrides] = useState(() => normalizeLogoOverrides(load(LOGO_OVERRIDES_KEY, {})));
  const brandingMap = useMemo(() => mergeBrandingWithOverrides(logoOverrides), [logoOverrides]);
  const [showSettings, setShowSettings] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [navGroup, setNavGroup] = useState('ops');
  const [items, setItems] = useState(()=>load('items',[]));
  const [shopping, setShopping] = useState(()=>migrateShoppingList(load('shoppingList',[])));
  const [purchaseInv, setPurchaseInv] = useState(()=>load('purchaseInvoices',[]));
  const [transferInv, setTransferInv] = useState(()=>load('transferInvoices',[]));
  const [payrollInvoices, setPayrollInvoices] = useState(()=>load('payrollInvoices',[]));
  const [cateringInv, setCateringInv] = useState(()=>load('cateringInvoices',[]));
  const [customers, setCustomers] = useState(()=>load('customers',[]));
  const [dailyFinanceEntries, setDailyFinanceEntries] = useState(()=>load('_dailyFinanceEntries', []));
  const [priceHist, setPriceHist] = useState(()=>load('priceHistory',[]));
  const [userPerms, setUserPerms] = useState(()=>load('_userPermissions', DEFAULT_USER_PERMS));
  const [kioskLock, setKioskLock] = useState(()=>load('_kioskLock', false));
  const [localFeatureWarning, setLocalFeatureWarning] = useState('');
  const [storageEnvOk, setStorageEnvOk] = useState(true);
  const [storageQuotaWarn, setStorageQuotaWarn] = useState(null);
  const [storageCorruptKeys, setStorageCorruptKeys] = useState([]);
  const storageWarnRef = useRef({ quota: false });
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [confirmKiosk, setConfirmKiosk] = useState(false);
  const [confirmClearCorrupt, setConfirmClearCorrupt] = useState(false);
  const [profile, setProfile] = useState(()=> {
    const u = load('_session', null);
    return u ? getProfile(u.username) : { displayName:'Staff User', icon:'👤' };
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const probe = probeLocalStorage();
      if (!probe.ok) {
        setStorageEnvOk(false);
        reportError('DMG-E010', { phase: 'probe', readable: probe.readable, writable: probe.writable });
      }
      const est = await estimateStorageUsage();
      if (cancelled) return;
      if (est.usageRatio != null && est.usageRatio > 0.9) {
        setStorageQuotaWarn({
          usageBytes: est.usageBytes,
          quotaBytes: est.quotaBytes,
          ratio: est.usageRatio,
        });
        if (!storageWarnRef.current.quota) {
          storageWarnRef.current.quota = true;
          reportError('DMG-E011', { phase: 'estimate', usageRatio: est.usageRatio, warn: 'near_quota' });
        }
      }
      const bad = findCorruptStorageKeys();
      if (bad.length) {
        setStorageCorruptKeys(bad);
        reportError('DMG-E012', { keys: bad });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    setSaveFailNotifier((payload) => {
      if (payload?.code === 'DMG-E011') {
        setStorageQuotaWarn((prev) => prev || { usageBytes: null, quotaBytes: null, ratio: 1 });
        showToast('Storage full — export a backup soon.', 'warning');
      }
    });
    return () => setSaveFailNotifier(() => {});
  }, []);

  // Keep active tab valid when permissions change — MUST be before any conditional return
  useEffect(() => {
    if (!currentUser) return;
    const isAdmin = currentUser.role === 'admin';
    const available = (isAdmin && kioskLock) ? TABS_ADMIN.filter(t=>t.id==='checkio') : isAdmin ? TABS_ADMIN : ALL_USER_TABS.filter(t => userPerms.includes(t.id));
    if (!available.find(t => t.id === tab)) {
      setTab(available[0]?.id || 'shopping');
    }
  }, [userPerms, currentUser, kioskLock]);

  useEffect(() => {
    if (!currentUser || currentUser.role !== 'admin' || !kioskLock) return;
    setTab('checkio');
    const onPop = () => { setTab('checkio'); window.history.pushState(null, '', window.location.href); };
    window.history.pushState(null, '', window.location.href);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [currentUser, kioskLock]);

  useEffect(() => {
    if (!currentUser || currentUser.role !== 'admin') return;
    probeResetApi('http://localhost:8787').then(chk => {
      if (chk.ok) setLocalFeatureWarning('');
      else setLocalFeatureWarning('Local backend is not reachable on this device. Scanner folder automation and local kiosk attendance station features may not work here.');
    }).catch(() => {
      setLocalFeatureWarning('Local backend is not reachable on this device. Scanner folder automation and local kiosk attendance station features may not work here.');
    });
  }, [currentUser?.username]);

  // One-time in-place migration so older transfer invoice shapes keep working.
  useEffect(() => {
    const src = Array.isArray(transferInv) ? transferInv : [];
    const normalized = src.map(normalizeTransferInvoice);
    const changed = JSON.stringify(src) !== JSON.stringify(normalized);
    if (changed) {
      setTransferInv(normalized);
      save('transferInvoices', normalized);
    }
  }, []);

  useEffect(() => {
    const raw = load('shoppingList', []);
    const normalized = migrateShoppingList(raw);
    try {
      if (JSON.stringify(normalized) !== JSON.stringify(raw)) {
        setShopping(normalized);
        save('shoppingList', normalized);
      }
    } catch (_) {}
  }, []);

  useEffect(() => {
    if (!currentUser || currentUser.role !== 'admin') return;
    const creds = load('credentials', {});
    if (!creds || !Object.keys(creds).length) return;
    syncCredentialsToBackend(creds, loadAdminResetApiBase()).then(result => {
      if (!result.ok) {
        logFailure({ area:'app', action:'admin_login_sync_credentials', error:result.error });
      }
    });
  }, [currentUser]);

  function handleLogin(user) {
    setCurrentUser(user);
    save('_session', user);
    const p = getProfile(user.username);
    setProfile(p);
    const creds = load('credentials', {});
    const perms = user.permissions || creds[user.username]?.permissions || DEFAULT_USER_PERMS;
    setUserPerms(perms);
    const isAdmin = user.role === 'admin';
    const firstTab = isAdmin ? TABS_ADMIN[0].id : (ALL_USER_TABS.find(t => perms.includes(t.id))?.id || 'shopping');
    if (attendanceParams && user.role !== 'admin') setTab('checkio');
    else setTab(firstTab);
    logActivity('login', 'Signed in as ' + user.role);
  }

  function handleLogout() {
    setConfirmLogout(true);
  }
  function confirmDoLogout() {
    setConfirmLogout(false);
    logActivity('logout', 'Signed out');
    setCurrentUser(null);
    save('_session', null);
    if (kioskLock) { setKioskLock(false); save('_kioskLock', false); }
  }

  function handleBizChange(k) { setBiz(k); save('_lastBiz', k); }

  function handleTabChange(id) {
    if (kioskLock && currentUser?.role === 'admin' && id !== 'checkio') return;
    setTab(id);
    logActivity('tab_change', 'Navigated to ' + id);
  }
  function goToTab(id) {
    const owner = navGroups.find(g => g.tabs.includes(id));
    if (owner) setNavGroup(owner.id);
    handleTabChange(id);
  }

  function handleProfileSave(data) {
    saveProfileData(currentUser.username, data);
    setProfile(data);
    showToast('Profile updated!');
  }
  function handleScannerAuthHash(authHash) {
    if (!currentUser) return;
    const next = { ...currentUser, authHash };
    setCurrentUser(next);
    save('_session', next);
  }
  function enterKioskMode() {
    if (currentUser?.role !== 'admin') return;
    setConfirmKiosk(true);
  }
  function confirmDoKiosk() {
    setConfirmKiosk(false);
    setKioskLock(true);
    save('_kioskLock', true);
    setTab('checkio');
  }
  if (!currentUser) return <LoginScreen onLogin={handleLogin} bootWarnings={bootWarnings} online={online} />;

  const isAdmin = currentUser.role === 'admin';
  const TABS = (isAdmin && kioskLock) ? TABS_ADMIN.filter(t=>t.id==='checkio') : isAdmin ? TABS_ADMIN : ALL_USER_TABS.filter(t => userPerms.includes(t.id));
  const navGroups = useMemo(() => {
    const allowed = new Set(TABS.map(t => t.id));
    const src = (isAdmin && kioskLock)
      ? [{ id:'work', label:'Work', tabs:['checkio'] }]
      : (isAdmin ? NAV_GROUPS_ADMIN : NAV_GROUPS_USER);
    const groups = src
      .map(g => ({ ...g, tabs: g.tabs.filter(id => allowed.has(id)) }))
      .filter(g => g.tabs.length > 0);
    return groups.length ? groups : [{ id:'all', label:'All', tabs:[...allowed] }];
  }, [isAdmin, kioskLock, TABS, userPerms]);
  const visibleTabIds = useMemo(() => {
    const g = navGroups.find(x => x.id === navGroup) || navGroups[0];
    return g ? g.tabs : TABS.map(t=>t.id);
  }, [navGroups, navGroup, TABS]);
  const visibleTabs = TABS.filter(t => visibleTabIds.includes(t.id));

  useEffect(() => {
    if (!navGroups.find(g => g.id === navGroup)) setNavGroup(navGroups[0]?.id || 'ops');
  }, [navGroups, navGroup]);
  useEffect(() => {
    if (!visibleTabIds.includes(tab)) {
      const g = navGroups.find(gx => gx.tabs.includes(tab));
      if (g) setNavGroup(g.id);
    }
  }, [tab, visibleTabIds, navGroups]);
  const bizInfo = BUSINESSES[biz];

  const appState = {
    items, shopping, purchaseInv, cateringInv, transferInv, payrollInvoices,
    dailyFinanceEntries, customers, priceHist,
    setItems, setShopping, setPurchaseInv, setCateringInv, setTransferInv,
    setPayrollInvoices, setDailyFinanceEntries, setCustomers, setPriceHist, setBiz,
    logoOverrides, setLogoOverrides,
  };

  function handleClearCorruptKeys() {
    const keys = [...storageCorruptKeys];
    if (!keys.length) return;
    setConfirmClearCorrupt(true);
  }
  function confirmDoClearCorruptKeys() {
    const keys = [...storageCorruptKeys];
    if (!keys.length) { setConfirmClearCorrupt(false); return; }
    setConfirmClearCorrupt(false);
    removeStorageKeys(keys);
    reportError('DMG-E012', { phase: 'cleared_keys', cleared: keys });
    setStorageCorruptKeys([]);
    showToast('Removed unreadable keys. Reloading…', 'warning');
    window.setTimeout(() => window.location.reload(), 400);
  }

  function handleRepairStorageKey(key, jsonText) {
    if (!key || !jsonText) return false;
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      return false;
    }
    if (!save(key, parsed)) {
      showToast('Could not write storage. Check space or permissions (DMG-E010/E011).', 'error');
      return false;
    }
    reportError('DMG-E012', { phase: 'repaired_key', key });
    setStorageCorruptKeys(findCorruptStorageKeys());
    const stillBad = findCorruptStorageKeys();
    if (!stillBad.includes(key)) {
      showToast(`Repaired storage key: ${key}`, 'success');
    } else {
      showToast('Key written but still unreadable — double-check JSON.', 'warning');
    }
    return true;
  }

  return (
    <div id="app-shell">
      <div className="app-header no-print">
        <div className="header-row">
          <div>
            <div className="header-title">
              <img className="header-title-logo" src={resolveAssetUrl(brandingMap[biz]?.logo || brandingMap.degrill.logo, documentBaseHref())} alt={`${bizInfo.name} logo`} />
              <h1 style={{margin:0}}>DMG Software Suite</h1>
            </div>
            <div className="sub">{bizInfo.name} · {bizInfo.location} · Tax: {(bizInfo.taxRate*100).toFixed(3)}%</div>
          </div>
          <div className="header-actions">
            {isAdmin && !kioskLock &&(
              <select style={{padding:'6px 10px',borderRadius:5,border:'none',background:'rgba(255,255,255,0.92)',color:'var(--brown)',fontWeight:700,fontSize:13,cursor:'pointer'}}
                value={biz} onChange={e=>handleBizChange(e.target.value)}>
                {Object.entries(BUSINESSES).map(([k,v])=><option key={k} value={k}>{v.name}</option>)}
              </select>
            )}
            {isAdmin && !kioskLock && <Btn className="btn-ghost btn-sm" onClick={()=>setShowSettings(true)}>⚙ Settings</Btn>}
            <div
              title="Click to edit your profile"
              onClick={()=>setShowProfile(true)}
              style={{display:'flex',alignItems:'center',gap:6,background:'rgba(255,255,255,0.12)',padding:'5px 10px',borderRadius:5,cursor:'pointer',transition:'background .15s'}}
              onMouseEnter={e=>e.currentTarget.style.background='rgba(255,255,255,0.22)'}
              onMouseLeave={e=>e.currentTarget.style.background='rgba(255,255,255,0.12)'}
            >
              <span style={{fontSize:20}}>{profile.icon}</span>
              <span style={{fontSize:13,color:'rgba(255,255,255,0.92)',fontWeight:600}}>{profile.displayName}</span>
              <span style={{fontSize:11,opacity:.65}}>✏️</span>
              <span className={`badge badge-${currentUser.role}`} style={{fontSize:11}}>{currentUser.role}</span>
              <Btn className="btn-ghost btn-sm" onClick={e=>{e.stopPropagation();handleLogout();}} style={{padding:'3px 8px',marginLeft:4}}>Sign Out</Btn>
            </div>
          </div>
        </div>
      </div>

      {/* ── Tabs ── */}
      <div className="group-bar no-print">
        {navGroups.map(g => (
          <button
            key={g.id}
            className={`group-btn${navGroup===g.id?' active':''}`}
            onClick={()=>{
              setNavGroup(g.id);
              if (!g.tabs.includes(tab) && g.tabs[0]) handleTabChange(g.tabs[0]);
            }}
          >
            {g.label}
          </button>
        ))}
      </div>
      <div className="tab-bar no-print">
        {visibleTabs.map(t=>(
          <button key={t.id} className={`tab-btn${tab===t.id?' active':''}`} onClick={()=>handleTabChange(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Content ── */}
      <div className="content-area">
        <div className="hint-card no-print">
          {isAdmin ? 'Use top groups to find tools faster. Start with Stock or Invoices for daily work.' : 'Use top groups to find what you need quickly. Start with Work or Stock.'}
        </div>
        <OfflineBanner online={online} />
        <BrowserCapsBanner warnings={bootWarnings} />
        {!storageEnvOk && (
          <div style={{background:'#fff7ed',border:'1px solid #fdba74',borderRadius:8,padding:'10px 12px',marginBottom:12,fontSize:13,color:'#9a3412'}}>
            <strong>DMG-E010:</strong> Browser storage is not available or blocked. The app cannot save changes reliably. Allow site data / exit strict private browsing, then refresh.
          </div>
        )}
        {storageQuotaWarn && (
          <div style={{background:'#fffbeb',border:'1px solid #fcd34d',borderRadius:8,padding:'10px 12px',marginBottom:12,fontSize:13,color:'#92400e'}}>
            <strong>DMG-E011:</strong> Device storage for this site is nearly full
            {storageQuotaWarn.usageBytes != null && storageQuotaWarn.quotaBytes != null && (
              <> ({fmtBytes(storageQuotaWarn.usageBytes)} / {fmtBytes(storageQuotaWarn.quotaBytes)})</>
            )}
            . Export a backup from Settings, then remove old invoices or clear other sites’ data.
          </div>
        )}
        {!!storageCorruptKeys.length && (
          <div style={{background:'#fefce8',border:'1px solid #fde047',borderRadius:8,padding:'10px 12px',marginBottom:12,fontSize:13,color:'#713f12'}}>
            <strong>DMG-E012:</strong> Some saved data could not be read (keys: {storageCorruptKeys.join(', ')}).
            Export a backup if possible, then remove the bad keys.
            {' '}
            <button type="button" className="btn btn-outline btn-sm" style={{marginLeft:8}} onClick={handleClearCorruptKeys}>Remove unreadable keys</button>
          </div>
        )}
        {isAdmin && localFeatureWarning && (
          <div style={{background:'#fff7ed',border:'1px solid #fdba74',borderRadius:8,padding:'10px 12px',marginBottom:12,fontSize:12.5,color:'#9a3412'}}>
            Note: {localFeatureWarning}
          </div>
        )}
        {isAdmin && !kioskLock && (
          <div className="mb-3">
            <SetupQuickActions
              itemsCount={items.length}
              onOpenSettings={()=>setShowSettings(true)}
              onGoTransfer={()=>goToTab('transfer')}
              onGoArchive={()=>goToTab('archive')}
            />
          </div>
        )}
        {tab==='items'     && <ItemDatabase     items={items} setItems={setItems} priceHistory={priceHist} setPriceHistory={setPriceHist} userRole={currentUser.role} />}
        {tab==='shopping'  && <ShoppingList     items={items} shoppingList={shopping} setShoppingList={setShopping} />}
        {tab==='checkio'   && <CheckInOutPage currentUser={currentUser} attendanceToken={attendanceParams?.token || ''} onEnterKiosk={enterKioskMode} kioskLock={kioskLock} selectedBusiness={biz} payrollInvoices={payrollInvoices} setPayrollInvoices={setPayrollInvoices} isOnline={online} />}
        {tab==='pricer'    && <PriceUpdater     items={items} setItems={setItems} priceHistory={priceHist} setPriceHistory={setPriceHist} />}
        {tab==='purchase'  && isAdmin && <PurchaseInvoices purchaseInvoices={purchaseInv} setPurchaseInvoices={setPurchaseInv} selectedBusiness={biz} items={items} brandingMap={brandingMap} />}
        {tab==='transfer'  && isAdmin && <TransferInvoices transferInvoices={transferInv} setTransferInvoices={setTransferInv} items={items} brandingMap={brandingMap} />}
        {tab==='catering'  && <CateringInvoices cateringInvoices={cateringInv} setCateringInvoices={setCateringInv} customers={customers} setCustomers={setCustomers} selectedBusiness={biz} userRole={currentUser.role} items={items} brandingMap={brandingMap} />}
        {tab==='customers' && isAdmin && <CustomerManagement customers={customers} setCustomers={setCustomers} cateringInvoices={cateringInv} />}
        {tab==='analytics' && isAdmin && <Analytics cateringInvoices={cateringInv} purchaseInvoices={purchaseInv} dailyFinanceEntries={dailyFinanceEntries} />}
        {tab==='dailyfin'  && <DailyIncomeExpense entries={dailyFinanceEntries} setEntries={setDailyFinanceEntries} selectedBusiness={biz} />}
        {tab==='archive'   && <InvoiceArchive   purchaseInvoices={purchaseInv} setPurchaseInvoices={setPurchaseInv} cateringInvoices={cateringInv} setCateringInvoices={setCateringInv} transferInvoices={transferInv} setTransferInvoices={setTransferInv} payrollInvoices={payrollInvoices} setPayrollInvoices={setPayrollInvoices} userRole={currentUser.role} brandingMap={brandingMap} />}
        {tab==='history'   && isAdmin && <PriceHistory items={items} priceHistory={priceHist} setPriceHistory={setPriceHist} />}
        {tab==='margins'   && isAdmin && <MenuMarginsLab items={items} priceHistory={priceHist} selectedBusiness={biz} />}
        {tab==='actlog'    && isAdmin && <ActivityLog />}
        {tab==='scanbeta'  && isAdmin && <ScanDatabaseBeta currentUser={currentUser} onAuthHashSaved={handleScannerAuthHash} isOnline={online} />}
        {tab==='help'      && <HelpCenter currentUser={currentUser} corruptKeys={storageCorruptKeys} onRepairStorageKey={handleRepairStorageKey} />}
      </div>

      {/* ── Modals ── */}
      <SettingsModal open={showSettings} onClose={()=>setShowSettings(false)} appState={appState} currentUser={currentUser} localFeatureWarning={localFeatureWarning} brandingMap={brandingMap} onPermsChange={(perms, uname)=>{ if(uname===currentUser.username) setUserPerms(perms); }} />
      <ProfileModal open={showProfile} onClose={()=>setShowProfile(false)} username={currentUser.username} profile={profile} onSave={handleProfileSave} />

      <Confirm
        open={confirmLogout}
        title="Sign out?"
        message="You will need to sign in again to use the app on this device."
        confirmLabel="Sign out"
        confirmClass="btn-danger"
        onConfirm={confirmDoLogout}
        onCancel={() => setConfirmLogout(false)}
      />
      <Confirm
        open={confirmKiosk}
        title="Enter Check-In Kiosk mode?"
        message="The screen will lock to Check In/Out only until you sign out and sign back in as admin."
        detail="Use this on a shared device at the counter. Keep the admin password private."
        dangerCode="DMG-E022 (session scope change)"
        confirmLabel="Enter kiosk mode"
        confirmClass="btn-danger"
        onConfirm={confirmDoKiosk}
        onCancel={() => setConfirmKiosk(false)}
      />
      <Confirm
        open={confirmClearCorrupt}
        title="Remove unreadable storage keys?"
        message={`Remove ${storageCorruptKeys.length} key(s) that could not be read as JSON?`}
        detail={`Keys: ${storageCorruptKeys.join(', ')}\n\nExport a backup from Settings first if unsure. The page will reload after removal.`}
        dangerCode="DMG-E012"
        confirmLabel="Remove keys"
        confirmClass="btn-danger"
        wide
        onConfirm={confirmDoClearCorruptKeys}
        onCancel={() => setConfirmClearCorrupt(false)}
      />
    </div>
  );
}

export default App;