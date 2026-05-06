import { reportError } from '../errors.js';
import { notifySaveFailure } from '../storageHealth.js';
import { showToast } from '../toastContext.jsx';

export function load(key, def) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : def; }
  catch { return def; }
}

export function save(key, val) {
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

export const uid = () => crypto.randomUUID();
export const today = () => new Date().toISOString().split('T')[0];
