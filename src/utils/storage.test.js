import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../errors.js', () => ({ reportError: vi.fn() }));
vi.mock('../storageHealth.js', () => ({ notifySaveFailure: vi.fn() }));
vi.mock('../toastContext.jsx', () => ({ showToast: vi.fn() }));

import { load, save, uid, today } from './storage.js';

function createMemoryLocalStorage() {
  const store = Object.create(null);
  return {
    getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); },
    removeItem(k) { delete store[k]; },
    clear() { for (const k of Object.keys(store)) delete store[k]; },
    get length() { return Object.keys(store).length; },
    key(i) { return Object.keys(store)[i] ?? null; },
  };
}

describe('storage utils', () => {
  beforeEach(() => {
    globalThis.localStorage = createMemoryLocalStorage();
    vi.clearAllMocks();
  });

  describe('load', () => {
    it('returns default when key absent', () => {
      expect(load('missing', [])).toEqual([]);
      expect(load('missing', null)).toBeNull();
    });

    it('parses valid JSON', () => {
      globalThis.localStorage.setItem('items', '[1,2,3]');
      expect(load('items', [])).toEqual([1, 2, 3]);
    });

    it('returns default for invalid JSON', () => {
      globalThis.localStorage.setItem('items', '{bad json');
      expect(load('items', 'fallback')).toBe('fallback');
    });

    it('returns default for empty string', () => {
      globalThis.localStorage.setItem('items', '');
      expect(load('items', 42)).toBe(42);
    });
  });

  describe('save', () => {
    it('stores JSON and returns true', () => {
      const result = save('items', [1, 2]);
      expect(result).toBe(true);
      expect(JSON.parse(globalThis.localStorage.getItem('items'))).toEqual([1, 2]);
    });

    it('returns false and shows toast on quota error', async () => {
      const { showToast } = await import('../toastContext.jsx');
      const { reportError } = await import('../errors.js');
      globalThis.localStorage.setItem = () => { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; };
      const result = save('items', []);
      expect(result).toBe(false);
      expect(reportError).toHaveBeenCalledWith('DMG-E011', expect.any(Object));
      expect(showToast).toHaveBeenCalledWith(expect.stringContaining('DMG-E011'), 'error');
    });

    it('returns false and shows DMG-E010 on generic save error', async () => {
      const { reportError } = await import('../errors.js');
      globalThis.localStorage.setItem = () => { throw new Error('disk full'); };
      const result = save('items', []);
      expect(result).toBe(false);
      expect(reportError).toHaveBeenCalledWith('DMG-E010', expect.any(Object));
    });
  });

  describe('uid', () => {
    it('returns a UUID v4 string', () => {
      const id = uid();
      expect(typeof id).toBe('string');
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });

    it('generates unique values', () => {
      expect(uid()).not.toBe(uid());
    });
  });

  describe('today', () => {
    it('returns a YYYY-MM-DD string', () => {
      expect(today()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('matches current date', () => {
      const expected = new Date().toISOString().split('T')[0];
      expect(today()).toBe(expected);
    });
  });
});
