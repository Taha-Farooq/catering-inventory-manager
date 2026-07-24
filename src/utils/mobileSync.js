// Mobile sync — desktop pushes a snapshot of the admin's localStorage app
// data to the backend, and the phone pulls it on login or manual refresh.
// The desktop remains the source of truth; the backend snapshot is a
// mirror, not the canonical store.
//
// What's IN the snapshot: invoices (catering / purchase / transfer /
// payroll), customers, suppliers, items, daily finance entries, price
// history, inventory adjustments, branding overrides, biz contacts,
// custom categories, owners (profit-split config).
//
// What's NOT in the snapshot:
//   - Credentials / password hashes (flow through /api/auth/*)
//   - Per-device prefs (_uiMode, _kioskLock, _welcomeTourDone, etc.)
//   - Scanner config (lives in the backend already)
//   - Attendance data (lives in the backend already)
//   - Recently-deleted bin (per-device safety net)

import { load, save } from './storage.js';
import {
  INVENTORY_ADJUSTMENTS_KEY,
  CUSTOM_CATEGORIES_KEY,
  LOGO_OVERRIDES_KEY,
  BIZ_CONTACT_KEY,
  OWNERS_KEY,
} from '../constants.js';

const SYNC_MODE_KEY = '_syncMode';        // 'auto' | 'desktop' | 'mobile' | 'off'
const LAST_PUSH_KEY = '_syncLastPush';    // ISO timestamp string
const LAST_PULL_KEY = '_syncLastPull';    // ISO timestamp string
const MOBILE_HINT_KEY = '_syncMobileHintShown';

// Auto-pick mode by screen width. Wide screens are almost certainly her
// admin desktop; narrow screens are her phone. The toggle in Settings
// overrides this any time.
export function detectAutoMode() {
  if (typeof window === 'undefined') return 'desktop';
  return window.matchMedia?.('(min-width:1024px)').matches ? 'desktop' : 'mobile';
}
export function getSyncMode() {
  const stored = load(SYNC_MODE_KEY, 'auto');
  if (stored === 'auto') return detectAutoMode();
  return stored;
}
export function setSyncMode(mode) {
  if (!['auto', 'desktop', 'mobile', 'off'].includes(mode)) return;
  save(SYNC_MODE_KEY, mode);
}
export function getStoredSyncMode() { return load(SYNC_MODE_KEY, 'auto'); }

export function getLastPush() { return load(LAST_PUSH_KEY, null); }
export function getLastPull() { return load(LAST_PULL_KEY, null); }

// Phone mode is read-only — used to gate edit buttons across the app.
export function isReadOnly() {
  return getSyncMode() === 'mobile';
}
export function shouldShowMobileFirstHint() {
  return getSyncMode() === 'mobile' && !load(MOBILE_HINT_KEY, false);
}
export function dismissMobileFirstHint() { save(MOBILE_HINT_KEY, true); }

const SYNC_KEYS = [
  'items',
  'shoppingList',
  'cateringInvoices',
  'purchaseInvoices',
  'transferInvoices',
  'payrollInvoices',
  '_dailyFinanceEntries',
  'customers',
  '_suppliers',
  'priceHistory',
  INVENTORY_ADJUSTMENTS_KEY,
  CUSTOM_CATEGORIES_KEY,
  LOGO_OVERRIDES_KEY,
  BIZ_CONTACT_KEY,
  OWNERS_KEY,
  '_lastBiz',
];

export function collectSnapshot() {
  const out = {};
  for (const k of SYNC_KEYS) {
    // load() supplies a default; we only want what's actually stored, but
    // for sync purposes load's default is fine — an empty list mirrors
    // "she hasn't added any of these yet" which the phone needs to see.
    out[k] = load(k, null);
  }
  return out;
}

// Apply a pulled snapshot to localStorage. Writes are direct via save()
// so React state hydrates from storage on next mount; for components
// already mounted, the caller should refresh by reading load() again or
// by triggering a re-render via the optional onApplied callback. We
// intentionally DO NOT clobber per-device prefs.
export function applySnapshot(data) {
  if (!data || typeof data !== 'object') return false;
  let appliedCount = 0;
  for (const k of SYNC_KEYS) {
    if (data[k] !== undefined && data[k] !== null) {
      save(k, data[k]);
      appliedCount++;
    }
  }
  save(LAST_PULL_KEY, new Date().toISOString());
  return appliedCount;
}

// Push wrapper: caller provides an `apiCall` that hits the backend with
// admin auth (the existing attendanceApiCall works perfectly — it routes
// to the cloud Render backend, not localhost-first like the scanner).
export async function pushSnapshot(apiCall, currentUser) {
  const snapshot = collectSnapshot();
  const res = await apiCall('/api/sync/snapshot', { method: 'POST', currentUser, body: { data: snapshot } });
  if (res.ok) {
    save(LAST_PUSH_KEY, res.data?.snapshotAt || new Date().toISOString());
  }
  return res;
}

export async function pullSnapshot(apiCall, currentUser) {
  const res = await apiCall('/api/sync/snapshot', { method: 'GET', currentUser });
  if (res.ok && res.data?.data) {
    const applied = applySnapshot(res.data.data);
    return { ...res, applied };
  }
  return res;
}

export async function fetchSyncStatus(apiCall, currentUser) {
  const res = await apiCall('/api/sync/status', { method: 'GET', currentUser });
  return res;
}

// Debounce: batches rapid edits (a save() after every keystroke during
// an invoice form session) into one push.
let pushTimer = null;
let pendingArgs = null;
export function schedulePush(apiCall, currentUser, delayMs = 2500) {
  pendingArgs = { apiCall, currentUser };
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    const { apiCall: a, currentUser: u } = pendingArgs || {};
    pendingArgs = null;
    if (a && u) pushSnapshot(a, u).catch(() => {});
  }, delayMs);
}
export function cancelPendingPush() {
  if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
  pendingArgs = null;
}
