import React, { useState, useEffect, useMemo, useRef, useCallback, useId, lazy, Suspense } from 'react';
import QRCode from 'qrcode';
import { load, save, uid, today } from './utils/storage.js';
import { logActivity } from './utils/activity.js';
import { documentBaseHref, rewriteImgSrcsForPrint, printHtmlDocument, printInvoiceById } from './utils/print.js';
import { nextId, nextTransferId, normalizeTransferInvoice } from './utils/invoiceIds.js';
import { BrandMark } from './ui/BrandMark.jsx';
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
import PayrollInvoices from './tabs/PayrollInvoices.jsx';
import ActivityLog from './tabs/ActivityLog.jsx';
import ScanDatabaseBeta from './tabs/ScanDatabaseBeta.jsx';
import CustomerManagement from './tabs/CustomerManagement.jsx';
import DailyIncomeExpense from './tabs/DailyIncomeExpense.jsx';
import CheckInOutPage from './tabs/CheckInOutPage.jsx';
import MenuMarginsLab from './tabs/MenuMarginsLab.jsx';
import ItemDatabase from './tabs/ItemDatabase.jsx';
import ShoppingList from './tabs/ShoppingList.jsx';
import PurchaseInvoices from './tabs/PurchaseInvoices.jsx';
import CateringInvoices from './tabs/CateringInvoices.jsx';
import TransferInvoices from './tabs/TransferInvoices.jsx';
import InvoiceArchive from './tabs/InvoiceArchive.jsx';
import Analytics from './tabs/Analytics.jsx';
import PriceHistory from './tabs/PriceHistory.jsx';
import PriceUpdater from './tabs/PriceUpdater.jsx';
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
  BIZ_CONTACT_KEY,
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

/*
 * Data compatibility (GitHub Pages / localStorage):
 * — Keys like `items`, `shoppingList`, `credentials` are stable API surface for users’ backups.
 * — Prefer additive fields (optional props on objects) over renames; use migrate* helpers when normalizing.
 * — `load()` / `save()` are imported from utils/storage.js.
 */
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
  degrill:  { mark:'DG',  name:'DeGrill Inc',                        location:'Spring Valley, NY',     address:'Spring Valley, NY 10977',          phone:'(845) 555-0100', email:'info@degrill.com',   logo:'assets/logos/degrill.jpg' },
  parathas: { mark:'PP',  name:'Parathas and Platters Inc',          location:'Hackensack, NJ',        address:'Hackensack, NJ 07601',             phone:'(201) 555-0200', email:'info@parathas.com',  logo:'assets/logos/parathas.jpg' },
  dera:     { mark:'DMG', name:'Dera Masala Grill Inc',              location:'Clifton, NJ',           address:'Clifton, NJ 07011',                phone:'(973) 555-0300', email:'info@deramasala.com',logo:'assets/logos/dera.jpg' },
  transfer: { mark:'PP',  name:'Parathas & Platters Internal Transfer', location:'Hackensack -> Englewood', address:'Hackensack, NJ 07601',        phone:'(201) 555-0200', email:'info@parathas.com',  logo:'assets/logos/parathas.jpg' },
};
function mergeBrandingWithOverrides(logoOverrides, contactOverrides) {
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
function getInvoiceBranding(inv, brandingMap) {
  const b = brandingMap || mergeBrandingWithOverrides(load(LOGO_OVERRIDES_KEY, {}), load(BIZ_CONTACT_KEY, {}));
  if (inv?._type === 'transfer' || inv?.invoiceType === 'pp_transfer') return b.transfer;
  return b[inv?.business] || { mark: 'INV', name: 'Invoice', location: '' };
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
function getProfile(username) {
  const profiles = load('_profiles', {});
  return profiles[username] || { displayName: username==='admin'?'Administrator':'Staff User', icon: username==='admin'?'👤':'👨‍🍳' };
}
function saveProfileData(username, data) {
  const profiles = load('_profiles', {});
  profiles[username] = { ...(profiles[username]||{}), ...data };
  save('_profiles', profiles);
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
          logoOverrides, setLogoOverrides,
          bizContact, setBizContact } = appState;
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
  const BIZ_KEYS = ['degrill', 'parathas', 'dera', 'transfer'];
  const blankContact = () => BIZ_KEYS.reduce((acc,k) => ({...acc,[k]:{phone:'',address:'',email:''}}), {});
  const [contactFields, setContactFields] = useState(blankContact);
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
    const bc = bizContact || {};
    setContactFields(BIZ_KEYS.reduce((acc, k) => ({
      ...acc,
      [k]: { phone: bc[k]?.phone || '', address: bc[k]?.address || '', email: bc[k]?.email || '' },
    }), {}));
  }, [open, logoOverrides, bizContact]);

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

  function commitContactOverrides() {
    const cleaned = BIZ_KEYS.reduce((acc, k) => ({
      ...acc,
      [k]: {
        phone:   (contactFields[k]?.phone   || '').trim(),
        address: (contactFields[k]?.address || '').trim(),
        email:   (contactFields[k]?.email   || '').trim(),
      },
    }), {});
    setBizContact(cleaned);
    save(BIZ_CONTACT_KEY, cleaned);
    showToast('Business contact info saved. Invoices updated immediately.');
    logActivity('profile_update', 'Saved business contact overrides');
  }
  function clearContactOverrides() {
    setContactFields(blankContact());
    setBizContact({});
    save(BIZ_CONTACT_KEY, {});
    showToast('Contact overrides cleared — built-in placeholders restored.');
    logActivity('profile_update', 'Cleared business contact overrides');
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
        settings:{ selectedBusiness: load('_lastBiz','degrill'), logoOverrides, bizContact },
        exportDate: new Date().toISOString(), version:'2.2'
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
        if (k==='settings'&&v.bizContact!=null) {
          setBizContact(v.bizContact);
          save(BIZ_CONTACT_KEY, v.bizContact);
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

      {/* Business contact info */}
      <div style={{border:'1px solid #EED9B0',borderRadius:8,padding:14,marginBottom:20,background:'#fffdf8'}}>
        <div style={{fontWeight:700,color:'var(--brown)',marginBottom:6,fontSize:14}}>📇 Business contact info</div>
        <p style={{fontSize:12,color:'#6b4b20',marginBottom:12,lineHeight:1.55}}>
          Override the phone, address and email shown on invoices for each business.
          Leave blank to use the built-in defaults.
        </p>
        {[
          {key:'degrill',  label:'DeGrill Inc'},
          {key:'parathas', label:'Parathas and Platters Inc'},
          {key:'dera',     label:'Dera Masala Grill Inc'},
          {key:'transfer', label:'Internal Transfer (Parathas brand)'},
        ].map(({key, label}) => (
          <div key={key} style={{marginBottom:14}}>
            <div style={{fontWeight:600,fontSize:13,color:'var(--brown)',marginBottom:6}}>{label}</div>
            <div className="grid-2 mb-2" style={{gap:8}}>
              <FI label="Phone" value={contactFields[key]?.phone||''} onChange={e=>setContactFields(f=>({...f,[key]:{...f[key],phone:e.target.value}}))} placeholder={BRANDING[key]?.phone||'(555) 000-0000'} />
              <FI label="Email" type="email" value={contactFields[key]?.email||''} onChange={e=>setContactFields(f=>({...f,[key]:{...f[key],email:e.target.value}}))} placeholder={BRANDING[key]?.email||'info@example.com'} />
            </div>
            <FI label="Address" value={contactFields[key]?.address||''} onChange={e=>setContactFields(f=>({...f,[key]:{...f[key],address:e.target.value}}))} placeholder={BRANDING[key]?.address||'Street, City, State ZIP'} />
          </div>
        ))}
        <div className="flex gap-2 flex-wrap" style={{marginTop:4}}>
          <Btn className="btn-primary btn-sm" onClick={commitContactOverrides}>Save contact info</Btn>
          <Btn className="btn-outline btn-sm" onClick={clearContactOverrides}>Clear overrides</Btn>
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

// ═══════════════════════════════════════════════════════════
// TAB 2 — SHOPPING LIST
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════
// TAB 3 — PURCHASE INVOICES
// ═══════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════



// ═══════════════════════════════════════════════════════════
// TAB 7 — ANALYTICS
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════
// TAB 7 — INVOICE ARCHIVE
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════
// INTERNAL TRANSFER INVOICES (P&P Hackensack -> Englewood)
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════
// TAB 8 — PRICE HISTORY
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════
// PRICE UPDATER
// ═══════════════════════════════════════════════════════════




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
  const [bizContact, setBizContact] = useState(() => load(BIZ_CONTACT_KEY, {}));
  const brandingMap = useMemo(() => mergeBrandingWithOverrides(logoOverrides, bizContact), [logoOverrides, bizContact]);
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
    bizContact, setBizContact,
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
        {tab==='checkio'   && <CheckInOutPage currentUser={currentUser} attendanceToken={attendanceParams?.token || ''} onEnterKiosk={enterKioskMode} kioskLock={kioskLock} selectedBusiness={biz} payrollInvoices={payrollInvoices} setPayrollInvoices={setPayrollInvoices} isOnline={online} attendanceApiCall={attendanceApiCall} />}
        {tab==='pricer'    && <PriceUpdater     items={items} setItems={setItems} priceHistory={priceHist} setPriceHistory={setPriceHist} />}
        {tab==='purchase'  && isAdmin && <PurchaseInvoices purchaseInvoices={purchaseInv} setPurchaseInvoices={setPurchaseInv} selectedBusiness={biz} items={items} brandingMap={brandingMap} getInvoiceBranding={getInvoiceBranding} />}
        {tab==='transfer'  && isAdmin && <TransferInvoices transferInvoices={transferInv} setTransferInvoices={setTransferInv} items={items} brandingMap={brandingMap} getInvoiceBranding={getInvoiceBranding} />}
        {tab==='catering'  && isAdmin && <CateringInvoices cateringInvoices={cateringInv} setCateringInvoices={setCateringInv} customers={customers} setCustomers={setCustomers} selectedBusiness={biz} userRole={currentUser.role} items={items} brandingMap={brandingMap} getInvoiceBranding={getInvoiceBranding} />}
        {tab==='customers' && isAdmin && <CustomerManagement customers={customers} setCustomers={setCustomers} cateringInvoices={cateringInv} save={save} />}
        {tab==='analytics' && isAdmin && <Analytics cateringInvoices={cateringInv} purchaseInvoices={purchaseInv} dailyFinanceEntries={dailyFinanceEntries} />}
        {tab==='dailyfin'  && <DailyIncomeExpense entries={dailyFinanceEntries} setEntries={setDailyFinanceEntries} selectedBusiness={biz} save={save} />}
        {tab==='payroll'   && isAdmin && <PayrollInvoices payrollInvoices={payrollInvoices} setPayrollInvoices={setPayrollInvoices} selectedBusiness={biz} brandingMap={brandingMap} />}
        {tab==='archive'   && isAdmin && <InvoiceArchive purchaseInvoices={purchaseInv} setPurchaseInvoices={setPurchaseInv} cateringInvoices={cateringInv} setCateringInvoices={setCateringInv} transferInvoices={transferInv} setTransferInvoices={setTransferInv} payrollInvoices={payrollInvoices} setPayrollInvoices={setPayrollInvoices} userRole={currentUser.role} brandingMap={brandingMap} selectedBusiness={biz} getInvoiceBranding={getInvoiceBranding} />}
        {tab==='history'   && isAdmin && <PriceHistory items={items} priceHistory={priceHist} setPriceHistory={setPriceHist} />}
        {tab==='margins'   && isAdmin && <MenuMarginsLab items={items} priceHistory={priceHist} selectedBusiness={biz} />}
        {tab==='actlog'    && isAdmin && <ActivityLog save={save} />}
        {tab==='scanbeta'  && isAdmin && <ScanDatabaseBeta currentUser={currentUser} onAuthHashSaved={handleScannerAuthHash} isOnline={online} scanApiCall={scanApiCall} hashPwd={hashPwd} />}
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