/**
 * localStorage health for DMG-E010 / E011 / E012.
 */

import { LOGO_OVERRIDES_KEY, BIZ_CONTACT_KEY } from './constants.js';

export const STORAGE_SCAN_KEYS = [
  'items',
  'shoppingList',
  'purchaseInvoices',
  'transferInvoices',
  'payrollInvoices',
  'cateringInvoices',
  'customers',
  '_dailyFinanceEntries',
  'priceHistory',
  'credentials',
  '_session',
  '_lastBiz',
  '_userPermissions',
  '_kioskLock',
  '_activityLog',
  '_profiles',
  '_seq',
  '_rememberedCheckinLogin',
  '_adminResetApiBase',
  '_adminResetCodeHash',
  '_failureLog',
  '_menuItems',
  '_menuRecipes',
  'settings',
  LOGO_OVERRIDES_KEY,
  BIZ_CONTACT_KEY,
];

export function probeLocalStorage() {
  let readable = false;
  let writable = false;
  try {
    const k = '__dmg_ls_probe_' + Date.now();
    localStorage.setItem(k, '1');
    readable = localStorage.getItem(k) === '1';
    localStorage.removeItem(k);
    writable = true;
  } catch {
    return {
      ok: false,
      readable: false,
      writable: false,
    };
  }
  return {
    ok: readable && writable,
    readable,
    writable,
  };
}

export async function estimateStorageUsage() {
  try {
    if (!navigator.storage?.estimate) return { quotaBytes: null, usageBytes: null, usageRatio: null };
    const est = await navigator.storage.estimate();
    const quotaBytes = typeof est.quota === 'number' ? est.quota : null;
    const usageBytes = typeof est.usage === 'number' ? est.usage : null;
    const usageRatio =
      quotaBytes && quotaBytes > 0 && usageBytes != null ? usageBytes / quotaBytes : null;
    return { quotaBytes, usageBytes, usageRatio };
  } catch {
    return { quotaBytes: null, usageBytes: null, usageRatio: null };
  }
}

/** Keys that exist but contain invalid JSON (DMG-E012). */
export function findCorruptStorageKeys(extraKeys = []) {
  const seen = new Set([...STORAGE_SCAN_KEYS, ...extraKeys]);
  const keys = [...seen];
  const corrupt = [];
  for (const key of keys) {
    try {
      const v = localStorage.getItem(key);
      if (v === null || v === '') continue;
      JSON.parse(v);
    } catch {
      corrupt.push(key);
    }
  }
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || seen.has(key)) continue;
      try {
        const v = localStorage.getItem(key);
        if (v === null || v === '') continue;
        JSON.parse(v);
      } catch {
        corrupt.push(key);
      }
    }
  } catch {
    /* ignore */
  }
  return [...new Set(corrupt)];
}

export function removeStorageKeys(keys) {
  for (const key of keys) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  }
}

let saveFailNotifier = () => {};
export function setSaveFailNotifier(fn) {
  saveFailNotifier = typeof fn === 'function' ? fn : () => {};
}

export function notifySaveFailure(payload) {
  try {
    saveFailNotifier(payload);
  } catch {
    /* ignore */
  }
}
