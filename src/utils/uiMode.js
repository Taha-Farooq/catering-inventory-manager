// Simple ↔ Power UI mode (Chunk 3 of the security+UX release).
// "Simple" hides error codes, technical jargon, and rarely-used controls so a
// non-technical user (mom) isn't faced with three buttons when one would do.
// "Power" shows everything — escape hatch when she's hunting for a setting or
// when an admin is investigating an issue.

import { UI_MODE_KEY, UI_MODE_SIMPLE, UI_MODE_POWER, DEFAULT_UI_MODE } from '../constants.js';

export function getUiMode() {
  try {
    const v = localStorage.getItem(UI_MODE_KEY);
    return v === UI_MODE_POWER || v === UI_MODE_SIMPLE ? v : DEFAULT_UI_MODE;
  } catch {
    return DEFAULT_UI_MODE;
  }
}

export function setUiMode(mode) {
  const normalized = mode === UI_MODE_POWER ? UI_MODE_POWER : UI_MODE_SIMPLE;
  try { localStorage.setItem(UI_MODE_KEY, normalized); } catch {}
  applyBodyClass(normalized);
  return normalized;
}

export function isSimpleMode() {
  return getUiMode() === UI_MODE_SIMPLE;
}

export function applyBodyClass(mode = getUiMode()) {
  if (typeof document === 'undefined') return;
  document.body.classList.toggle('ui-simple', mode === UI_MODE_SIMPLE);
  document.body.classList.toggle('ui-power', mode === UI_MODE_POWER);
}

// Strip [DMG-Exxx] / (DMG-Exxx) / bare DMG-Exxx codes from a user-facing
// string when in simple mode. The codes are still logged via reportError().
const DMG_CODE_RE = /\s*[\[\(]?DMG-E\d{3}[\]\)]?\s*/g;
export function cleanUserMessage(msg) {
  if (typeof msg !== 'string') return msg;
  if (!isSimpleMode()) return msg;
  return msg.replace(DMG_CODE_RE, ' ').replace(/\s+/g, ' ').trim();
}
