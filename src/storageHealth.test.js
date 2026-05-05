import { describe, it, expect, beforeEach } from 'vitest';
import {
  findCorruptStorageKeys,
  probeLocalStorage,
  removeStorageKeys,
  STORAGE_SCAN_KEYS,
} from './storageHealth.js';

function createMemoryLocalStorage() {
  const store = Object.create(null);
  return {
    getItem(k) {
      return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null;
    },
    setItem(k, v) {
      store[k] = String(v);
    },
    removeItem(k) {
      delete store[k];
    },
    clear() {
      for (const k of Object.keys(store)) delete store[k];
    },
    get length() {
      return Object.keys(store).length;
    },
    key(i) {
      const keys = Object.keys(store);
      return keys[i] ?? null;
    },
  };
}

describe('storageHealth', () => {
  beforeEach(() => {
    globalThis.localStorage = createMemoryLocalStorage();
  });

  describe('probeLocalStorage', () => {
    it('returns ok when read/write works', () => {
      const r = probeLocalStorage();
      expect(r.ok).toBe(true);
      expect(r.readable).toBe(true);
      expect(r.writable).toBe(true);
    });
  });

  describe('findCorruptStorageKeys', () => {
    it('returns empty when all JSON valid', () => {
      globalThis.localStorage.setItem('items', '[]');
      globalThis.localStorage.setItem('credentials', '{"x":1}');
      expect(findCorruptStorageKeys()).toEqual([]);
    });

    it('detects invalid JSON for known keys', () => {
      globalThis.localStorage.setItem('items', '{not json');
      expect(findCorruptStorageKeys()).toContain('items');
    });

    it('scans unknown keys with invalid JSON', () => {
      globalThis.localStorage.setItem('customKey', 'oops');
      expect(findCorruptStorageKeys()).toContain('customKey');
    });

    it('ignores empty string values', () => {
      globalThis.localStorage.setItem('items', '');
      expect(findCorruptStorageKeys()).not.toContain('items');
    });
  });

  describe('removeStorageKeys', () => {
    it('removes listed keys', () => {
      globalThis.localStorage.setItem('a', '1');
      globalThis.localStorage.setItem('b', '2');
      removeStorageKeys(['a']);
      expect(globalThis.localStorage.getItem('a')).toBeNull();
      expect(globalThis.localStorage.getItem('b')).toBe('2');
    });
  });

  it('STORAGE_SCAN_KEYS includes core data keys', () => {
    expect(STORAGE_SCAN_KEYS).toContain('items');
    expect(STORAGE_SCAN_KEYS).toContain('credentials');
  });
});
