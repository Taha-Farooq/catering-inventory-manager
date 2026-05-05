/**
 * Central error reporting for DMG-Exxx codes (Slice 2 foundation).
 * Never log passwords or raw credentials.
 */

const LOG_KEY = '_dmgErrorLog';
const MAX_ENTRIES = 12;

export function reportError(code, context = {}) {
  const entry = {
    code,
    t: Date.now(),
    ...context,
  };
  try {
    const prev = JSON.parse(sessionStorage.getItem(LOG_KEY) || '[]');
    prev.push(entry);
    sessionStorage.setItem(LOG_KEY, JSON.stringify(prev.slice(-MAX_ENTRIES)));
  } catch {
    /* ignore quota / private mode */
  }
  if (typeof console !== 'undefined' && console.error) {
    console.error(`[${code}]`, context.message || context);
  }
  return entry;
}

export function readErrorLog() {
  try {
    return JSON.parse(sessionStorage.getItem(LOG_KEY) || '[]');
  } catch {
    return [];
  }
}

export function clearErrorLog() {
  try {
    sessionStorage.removeItem(LOG_KEY);
  } catch {
    /* ignore */
  }
}

export async function copyDiagnostics(extra = {}) {
  const build =
    typeof __APP_BUILD__ !== 'undefined' ? __APP_BUILD__ : 'unknown';
  let storageOk = false;
  try {
    const k = '__dmg_probe_' + Date.now();
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    storageOk = true;
  } catch {
    storageOk = false;
  }
  const payload = {
    build,
    storageAvailable: storageOk,
    recentErrors: readErrorLog(),
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    href: typeof location !== 'undefined' ? location.href : '',
    ...extra,
  };
  const text = JSON.stringify(payload, null, 2);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  return text;
}
