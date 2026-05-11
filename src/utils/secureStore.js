// AES-GCM encrypted localStorage wrapper.
// A random 32-byte master key is generated once per device and stored in
// localStorage. Sensitive values are encrypted with AES-GCM so they are not
// readable as plain JSON if someone opens the browser's storage inspector.
// Note: the master key itself is in localStorage, so this is security-in-depth
// against casual inspection rather than against an attacker with full disk access.

const MASTER_KEY_ID = '_dmg_mk';

async function getMasterKey() {
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto unavailable');
  let keyB64 = localStorage.getItem(MASTER_KEY_ID);
  let rawKey;
  if (keyB64) {
    rawKey = Uint8Array.from(atob(keyB64), c => c.charCodeAt(0));
  } else {
    rawKey = crypto.getRandomValues(new Uint8Array(32));
    localStorage.setItem(MASTER_KEY_ID, btoa(String.fromCharCode(...rawKey)));
  }
  return crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Encrypt and store a JSON-serialisable value. Falls back to plaintext if Web Crypto is unavailable. */
export async function secureSet(key, value) {
  if (!globalThis.crypto?.subtle) {
    localStorage.setItem(key, JSON.stringify(value));
    return;
  }
  try {
    const cryptoKey = await getMasterKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(value));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, plaintext);
    localStorage.setItem(key, JSON.stringify({
      v: 1,
      iv: btoa(String.fromCharCode(...iv)),
      ct: btoa(String.fromCharCode(...new Uint8Array(ciphertext))),
    }));
  } catch {
    localStorage.setItem(key, JSON.stringify(value));
  }
}

/** Read and decrypt a value. Returns defaultValue if key is absent or decryption fails.
 *  Transparently handles unencrypted legacy values (returns them as-is). */
export async function secureGet(key, defaultValue = null) {
  const raw = localStorage.getItem(key);
  if (!raw) return defaultValue;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return defaultValue; }
  // Not an encrypted envelope → legacy unencrypted value, return as-is
  if (!parsed?.v || !parsed?.iv || !parsed?.ct) return parsed ?? defaultValue;
  if (!globalThis.crypto?.subtle) return defaultValue;
  try {
    const cryptoKey = await getMasterKey();
    const iv = Uint8Array.from(atob(parsed.iv), c => c.charCodeAt(0));
    const ct = Uint8Array.from(atob(parsed.ct), c => c.charCodeAt(0));
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, ct);
    return JSON.parse(new TextDecoder().decode(decrypted));
  } catch {
    return defaultValue;
  }
}

export function secureDel(key) {
  localStorage.removeItem(key);
}
