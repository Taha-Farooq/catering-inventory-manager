import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../errors.js', () => ({ reportError: vi.fn() }));
vi.mock('../storageHealth.js', () => ({ notifySaveFailure: vi.fn() }));
vi.mock('../toastContext.jsx', () => ({ showToast: vi.fn() }));

import {
  collectSnapshot, applySnapshot,
  getStoredSyncMode, setSyncMode, isReadOnly,
  detectAutoMode,
  pushSnapshot, pullSnapshot,
} from './mobileSync.js';
import { load, save } from './storage.js';

function memStore() {
  const m = Object.create(null);
  return {
    getItem(k) { return k in m ? m[k] : null; },
    setItem(k, v) { m[k] = String(v); },
    removeItem(k) { delete m[k]; },
    clear() { for (const k of Object.keys(m)) delete m[k]; },
    get length() { return Object.keys(m).length; },
    key(i) { return Object.keys(m)[i] ?? null; },
  };
}

describe('mobileSync', () => {
  beforeEach(() => {
    globalThis.localStorage = memStore();
    if (!globalThis.window) globalThis.window = {};
    // Pretend wide screen by default
    globalThis.window.matchMedia = (q) => ({ matches: q.includes('1024'), media: q });
  });

  it('collects only the whitelisted keys', () => {
    save('items', [{ id: 'i1', name: 'Rice' }]);
    save('customers', [{ id: 'c1', name: 'Alice' }]);
    save('_uiMode', 'simple'); // should NOT be in snapshot
    save('credentials', { admin: 'secret' }); // should NOT be in snapshot

    const snap = collectSnapshot();
    expect(snap.items).toEqual([{ id: 'i1', name: 'Rice' }]);
    expect(snap.customers).toEqual([{ id: 'c1', name: 'Alice' }]);
    expect(Object.keys(snap)).not.toContain('_uiMode');
    expect(Object.keys(snap)).not.toContain('credentials');
  });

  it('applies a snapshot to localStorage', () => {
    applySnapshot({
      items: [{ id: 'i1', name: 'Naan' }],
      customers: [{ id: 'c1', name: 'Bob' }],
      cateringInvoices: [{ id: 'CAT-1', grandTotal: 500 }],
    });
    expect(load('items', [])).toEqual([{ id: 'i1', name: 'Naan' }]);
    expect(load('customers', [])).toEqual([{ id: 'c1', name: 'Bob' }]);
    expect(load('cateringInvoices', [])).toEqual([{ id: 'CAT-1', grandTotal: 500 }]);
    expect(load('_syncLastPull', null)).toBeTruthy();
  });

  it('ignores unknown keys when applying a snapshot', () => {
    applySnapshot({ items: [{ id: 'i1' }], _evilKey: 'should not be saved' });
    expect(load('items', [])).toEqual([{ id: 'i1' }]);
    expect(load('_evilKey', null)).toBeNull();
  });

  it('detects mode by viewport width', () => {
    globalThis.window.matchMedia = (q) => ({ matches: q.includes('1024'), media: q });
    expect(detectAutoMode()).toBe('desktop');
    globalThis.window.matchMedia = () => ({ matches: false });
    expect(detectAutoMode()).toBe('mobile');
  });

  it('round-trips the stored sync mode', () => {
    expect(getStoredSyncMode()).toBe('auto');
    setSyncMode('mobile');
    expect(getStoredSyncMode()).toBe('mobile');
    expect(isReadOnly()).toBe(true);
    setSyncMode('desktop');
    expect(isReadOnly()).toBe(false);
  });

  it('pushSnapshot calls the api and records the timestamp on success', async () => {
    save('items', [{ id: 'i1' }]);
    const api = vi.fn().mockResolvedValue({ ok: true, data: { snapshotAt: '2026-06-11T15:00:00Z' } });
    const r = await pushSnapshot(api, { username: 'admin', role: 'admin', authHash: 'x' });
    expect(r.ok).toBe(true);
    expect(api).toHaveBeenCalledWith('/api/sync/snapshot', expect.objectContaining({
      method: 'POST',
      body: expect.objectContaining({ data: expect.objectContaining({ items: [{ id: 'i1' }] }) }),
    }));
    expect(load('_syncLastPush', null)).toBe('2026-06-11T15:00:00Z');
  });

  it('pullSnapshot applies the returned data and records the timestamp', async () => {
    const api = vi.fn().mockResolvedValue({ ok: true, data: { data: { items: [{ id: 'pulled' }] }, snapshotAt: '2026-06-11T16:00:00Z' } });
    const r = await pullSnapshot(api, { username: 'mom', role: 'admin', authHash: 'x' });
    expect(r.ok).toBe(true);
    expect(r.applied).toBe(1);
    expect(load('items', [])).toEqual([{ id: 'pulled' }]);
    expect(load('_syncLastPull', null)).toBeTruthy();
  });
});
