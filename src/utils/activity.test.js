import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../errors.js', () => ({ reportError: vi.fn() }));
vi.mock('../storageHealth.js', () => ({ notifySaveFailure: vi.fn() }));
vi.mock('../toastContext.jsx', () => ({ showToast: vi.fn() }));

import { logActivity } from './activity.js';

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

describe('logActivity', () => {
  beforeEach(() => {
    globalThis.localStorage = createMemoryLocalStorage();
  });

  it('does nothing when no session exists', () => {
    logActivity('test_action');
    expect(globalThis.localStorage.getItem('_activityLog')).toBeNull();
  });

  it('writes an entry to _activityLog when session exists', () => {
    globalThis.localStorage.setItem('_session', JSON.stringify({ username: 'alice' }));
    logActivity('create_invoice', 'INV-001');
    const log = JSON.parse(globalThis.localStorage.getItem('_activityLog'));
    expect(log).toHaveLength(1);
    expect(log[0].username).toBe('alice');
    expect(log[0].action).toBe('create_invoice');
    expect(log[0].details).toBe('INV-001');
    expect(log[0].id).toBeTruthy();
    expect(log[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('appends to an existing log', () => {
    globalThis.localStorage.setItem('_session', JSON.stringify({ username: 'bob' }));
    logActivity('action_one');
    logActivity('action_two');
    const log = JSON.parse(globalThis.localStorage.getItem('_activityLog'));
    expect(log).toHaveLength(2);
    expect(log[0].action).toBe('action_one');
    expect(log[1].action).toBe('action_two');
  });

  it('defaults details to empty string', () => {
    globalThis.localStorage.setItem('_session', JSON.stringify({ username: 'alice' }));
    logActivity('login');
    const log = JSON.parse(globalThis.localStorage.getItem('_activityLog'));
    expect(log[0].details).toBe('');
  });

  it('trims log to 2000 entries', () => {
    globalThis.localStorage.setItem('_session', JSON.stringify({ username: 'alice' }));
    const existing = Array.from({ length: 2000 }, (_, i) => ({ id: String(i), action: 'x', username: 'alice', details: '', timestamp: '' }));
    globalThis.localStorage.setItem('_activityLog', JSON.stringify(existing));
    logActivity('overflow');
    const log = JSON.parse(globalThis.localStorage.getItem('_activityLog'));
    expect(log).toHaveLength(2000);
    expect(log[log.length - 1].action).toBe('overflow');
  });

  it('generates unique entry IDs', () => {
    globalThis.localStorage.setItem('_session', JSON.stringify({ username: 'alice' }));
    logActivity('a1');
    logActivity('a2');
    const log = JSON.parse(globalThis.localStorage.getItem('_activityLog'));
    expect(log[0].id).not.toBe(log[1].id);
  });

  it('writes to log for unknown action types', () => {
    globalThis.localStorage.setItem('_session', JSON.stringify({ username: 'alice' }));
    logActivity('totally_unknown_action_xyz', 'some detail');
    const log = JSON.parse(globalThis.localStorage.getItem('_activityLog'));
    expect(log).toHaveLength(1);
    expect(log[0].action).toBe('totally_unknown_action_xyz');
    expect(log[0].details).toBe('some detail');
  });
});
