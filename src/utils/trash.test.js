import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../errors.js', () => ({ reportError: vi.fn() }));
vi.mock('../storageHealth.js', () => ({ notifySaveFailure: vi.fn() }));
vi.mock('../toastContext.jsx', () => ({ showToast: vi.fn() }));

import { moveToTrash, listTrash, restoreFromTrash, purgeTrash } from './trash.js';
import { load, save } from './storage.js';

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

describe('trash (recently deleted)', () => {
  beforeEach(() => {
    globalThis.localStorage = createMemoryLocalStorage();
    if (!globalThis.crypto?.randomUUID) {
      globalThis.crypto = { randomUUID: () => Math.random().toString(36).slice(2) };
    }
  });

  it('moves a record to trash and lists it newest-first', () => {
    moveToTrash('cateringInvoices', 'CAT-1 — Acme Corp', { id: 'CAT-1', customerName: 'Acme Corp' });
    moveToTrash('customers', 'Jane Doe', { id: 'c1', name: 'Jane Doe' });
    const items = listTrash();
    expect(items).toHaveLength(2);
    expect(items[0].label).toBe('Jane Doe'); // newest first
    expect(items[1].kind).toBe('cateringInvoices');
  });

  it('restores a record into its original collection and removes it from trash', () => {
    save('cateringInvoices', [{ id: 'CAT-2' }]);
    moveToTrash('cateringInvoices', 'CAT-1', { id: 'CAT-1', grandTotal: 500 });
    const entry = listTrash()[0];
    const restored = restoreFromTrash(entry.trashId);
    expect(restored.id).toBe('CAT-1');
    expect(load('cateringInvoices', []).map(x => x.id)).toEqual(['CAT-2', 'CAT-1']);
    expect(listTrash()).toHaveLength(0);
  });

  it('suffixes the id when restoring over an existing record instead of clobbering', () => {
    save('customers', [{ id: 'c1', name: 'New Jane' }]);
    moveToTrash('customers', 'Old Jane', { id: 'c1', name: 'Old Jane' });
    const restored = restoreFromTrash(listTrash()[0].trashId);
    expect(restored.id).toBe('c1-restored');
    expect(load('customers', [])).toHaveLength(2);
  });

  it('purges a single entry permanently', () => {
    moveToTrash('customers', 'A', { id: 'a' });
    moveToTrash('customers', 'B', { id: 'b' });
    purgeTrash(listTrash()[0].trashId);
    expect(listTrash()).toHaveLength(1);
    expect(listTrash()[0].label).toBe('A');
  });

  it('hides entries past the 30-day retention window', () => {
    moveToTrash('customers', 'Old', { id: 'old' });
    const raw = load('_recentlyDeleted', []);
    raw[0].deletedAt = new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString();
    save('_recentlyDeleted', raw);
    expect(listTrash()).toHaveLength(0);
  });

  it('returns null when restoring a nonexistent entry', () => {
    expect(restoreFromTrash('nope')).toBeNull();
  });
});
