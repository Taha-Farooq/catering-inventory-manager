import { describe, it, expect, beforeEach } from 'vitest';
import { cleanUserMessage, getUiMode, setUiMode, isSimpleMode } from './uiMode.js';
import { UI_MODE_KEY, UI_MODE_SIMPLE, UI_MODE_POWER } from '../constants.js';

// Minimal localStorage stub for the node-environment vitest run.
beforeEach(() => {
  const store = {};
  globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; },
  };
  globalThis.document = { body: { classList: { toggle: () => {} } } };
});

describe('getUiMode / setUiMode', () => {
  it('defaults to simple when nothing is stored', () => {
    expect(getUiMode()).toBe(UI_MODE_SIMPLE);
    expect(isSimpleMode()).toBe(true);
  });

  it('persists a chosen mode', () => {
    setUiMode(UI_MODE_POWER);
    expect(getUiMode()).toBe(UI_MODE_POWER);
    expect(isSimpleMode()).toBe(false);
  });

  it('rejects unknown modes and falls back to simple', () => {
    localStorage.setItem(UI_MODE_KEY, 'rainbow');
    expect(getUiMode()).toBe(UI_MODE_SIMPLE);
  });
});

describe('cleanUserMessage', () => {
  it('strips [DMG-Exxx] brackets in simple mode', () => {
    setUiMode(UI_MODE_SIMPLE);
    expect(cleanUserMessage('Login failed. [DMG-E020]'))
      .toBe('Login failed.');
  });

  it('strips (DMG-Exxx) parens in simple mode', () => {
    setUiMode(UI_MODE_SIMPLE);
    expect(cleanUserMessage('Network error (DMG-E021). Try again.'))
      .toBe('Network error . Try again.');
  });

  it('strips bare DMG-Exxx in simple mode', () => {
    setUiMode(UI_MODE_SIMPLE);
    expect(cleanUserMessage('Storage error DMG-E011 — please export.'))
      .toBe('Storage error — please export.');
  });

  it('leaves DMG codes intact in power mode', () => {
    setUiMode(UI_MODE_POWER);
    const msg = 'Login failed. [DMG-E020]';
    expect(cleanUserMessage(msg)).toBe(msg);
  });

  it('passes non-string values through unchanged', () => {
    setUiMode(UI_MODE_SIMPLE);
    expect(cleanUserMessage(null)).toBe(null);
    expect(cleanUserMessage(42)).toBe(42);
    expect(cleanUserMessage(undefined)).toBe(undefined);
  });

  it('handles strings with no DMG codes cleanly', () => {
    setUiMode(UI_MODE_SIMPLE);
    expect(cleanUserMessage('Hello world.')).toBe('Hello world.');
  });
});
