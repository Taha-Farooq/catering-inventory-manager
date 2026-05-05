/**
 * Pure formatting and small string helpers shared by the app (tests live in formatters.test.js).
 */

export const fmt$ = (n) =>
  '$' +
  (parseFloat(n) || 0)
    .toFixed(2)
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');

export function fmtBytes(n) {
  if (n == null || !Number.isFinite(n)) return '';
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export function fmtDate(d) {
  if (!d) return '';
  try {
    return new Date(d + 'T00:00:00').toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return d;
  }
}

export function safeQty(v) {
  const n = parseFloat(v);
  return !isNaN(n) && n >= 0 ? n : 0;
}

export function sellerKey(n) {
  return String(n ?? '')
    .trim()
    .toLowerCase();
}

export function normalizeApiBase(url) {
  return String(url || '')
    .trim()
    .replace(/\/+$/, '');
}

export function parseUrlSafe(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

export function isLoopbackHost(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

export function trimText(v, max = 1000) {
  const s = String(v ?? '');
  return s.length > max ? s.slice(0, max) + '...(truncated)' : s;
}

/**
 * Normalizes legacy shopping list rows from localStorage backups.
 */
export function migrateShoppingList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e) => e && typeof e === 'object' && e.id && (e.itemId || e.itemName))
    .map((e) => ({
      ...e,
      itemName: e.itemName != null ? String(e.itemName) : '',
      itemId: e.itemId != null ? e.itemId : '',
      unit: e.unit != null ? String(e.unit) : '',
      upc: e.upc != null ? String(e.upc) : '',
      selectedSeller: e.selectedSeller != null ? String(e.selectedSeller) : '',
      quantity: e.quantity !== undefined && e.quantity !== '' ? e.quantity : 1,
      sellers: Array.isArray(e.sellers) ? e.sellers : [],
      notes: e.notes != null ? String(e.notes) : '',
    }));
}

/** Dedupe + sort for datalist / autocomplete */
export function uniqSuggestions(...vals) {
  const set = new Set();
  for (const v of vals) {
    if (v == null || v === '') continue;
    const s = String(v).trim();
    if (s) set.add(s);
  }
  return [...set].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

export function safePrice(v) {
  if (v === '' || v == null) return null;
  const n = parseFloat(v);
  return !isNaN(n) && n >= 0 ? n : null;
}

/** Keep only non-empty string URLs for known keys (+ transfer). */
export function normalizeLogoOverrides(raw, businessKeys = ['degrill', 'parathas', 'dera']) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const k of businessKeys) {
    const v = raw[k];
    if (typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  const t = raw.transfer ?? raw.pp_transfer;
  if (typeof t === 'string' && t.trim()) out.transfer = t.trim();
  return out;
}

/**
 * Resolve relative asset URLs for `<img src>` (print windows, GitHub Pages subpaths).
 * `baseHref` should be the directory URL of the current HTML document (see `documentBaseHref` in App).
 */
export function resolveAssetUrl(src, baseHref = '') {
  const s = String(src ?? '').trim();
  if (!s) return '';
  if (/^(?:https?:|data:|blob:)/i.test(s)) return s;
  try {
    const base =
      typeof baseHref === 'string' && baseHref.trim()
        ? baseHref.trim()
        : typeof globalThis !== 'undefined' && globalThis.location?.href
          ? globalThis.location.href
          : '';
    if (!base) return s;
    return new URL(s, base).href;
  } catch {
    return s;
  }
}
