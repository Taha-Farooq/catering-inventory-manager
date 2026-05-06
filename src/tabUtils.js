/**
 * Shared utilities for extracted tab components.
 * Import `load` and `logActivity` from here rather than duplicating them.
 * Pass `save` as a prop from App.jsx (it has error-handling tied to showToast/reportError).
 */

export function load(key, def) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : def;
  } catch {
    return def;
  }
}

export function logActivity(action, details = '') {
  try {
    const v = localStorage.getItem('_session');
    const session = v ? JSON.parse(v) : null;
    if (!session) return;
    const uid = () => crypto.randomUUID();
    const entry = { id: uid(), username: session.username, action, details, timestamp: new Date().toISOString() };
    const logKey = '_activityLog';
    const log = load(logKey, []);
    log.push(entry);
    if (log.length > 2000) log.splice(0, log.length - 2000);
    localStorage.setItem(logKey, JSON.stringify(log));
  } catch { /* ignore */ }
}

export function getProfile(username) {
  const profiles = load('_profiles', {});
  return profiles[username] || {
    displayName: username === 'admin' ? 'Administrator' : 'Staff User',
    icon: username === 'admin' ? '👤' : '👨‍🍳',
  };
}

export const today = () => new Date().toISOString().split('T')[0];

export function logFailure({ area = 'unknown', action = 'unknown', error = null, extra = {} }) {
  try {
    const v = localStorage.getItem('_session');
    const session = v ? JSON.parse(v) : null;
    const detail = !error
      ? 'Unknown error'
      : typeof error === 'string'
        ? error
        : error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);
    const entry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      area, action,
      error: detail.slice(0, 2000),
      extra,
      page: typeof window !== 'undefined' ? window.location.href : '',
      username: session?.username || 'anonymous',
    };
    const logs = load('_failureLog', []);
    logs.push(entry);
    if (logs.length > 500) logs.splice(0, logs.length - 500);
    localStorage.setItem('_failureLog', JSON.stringify(logs));
  } catch { /* ignore */ }
}
