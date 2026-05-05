/**
 * Boot-time browser capability checks (Slice 6). Pure helpers — testable without DOM.
 */

/**
 * @param {object} [env] Defaults to `globalThis` (browser `window`).
 * @returns {{ code: string, message: string }[]}
 */
export function getBootCapabilityWarnings(env = typeof globalThis !== 'undefined' ? globalThis : {}) {
  const warnings = [];
  const loc = env.location || {};
  const protocol = typeof loc.protocol === 'string' ? loc.protocol : '';
  const hostname = typeof loc.hostname === 'string' ? loc.hostname : '';
  const cryptoRef = env.crypto;

  const isLoopback =
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1';

  if (!cryptoRef?.subtle) {
    const insecureRemote = protocol === 'http:' && !isLoopback;
    warnings.push({
      code: insecureRemote ? 'DMG-E051' : 'DMG-E050',
      message: insecureRemote
        ? 'Password hashing needs a secure (HTTPS) site or localhost (DMG-E051).'
        : 'This browser is missing Web Crypto. Try Chrome, Edge, or Firefox (DMG-E050).',
    });
  }

  if (typeof env.structuredClone !== 'function') {
    warnings.push({
      code: 'DMG-E050',
      message:
        'Structured cloning API is missing — export/import and some saves may fail. Use a current Chrome, Edge, or Firefox (DMG-E050).',
    });
  }

  return warnings;
}
