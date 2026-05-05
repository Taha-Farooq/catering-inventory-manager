import { describe, it, expect } from 'vitest';
import { getBootCapabilityWarnings } from './browserCaps.js';

describe('getBootCapabilityWarnings', () => {
  it('returns empty when crypto.subtle and structuredClone exist', () => {
    const env = {
      location: { protocol: 'https:', hostname: 'example.com' },
      crypto: { subtle: {} },
      structuredClone: (x) => JSON.parse(JSON.stringify(x)),
    };
    expect(getBootCapabilityWarnings(env)).toEqual([]);
  });

  it('flags DMG-E051 when no subtle on insecure remote HTTP', () => {
    const env = {
      location: { protocol: 'http:', hostname: 'example.com' },
      crypto: {},
      structuredClone: () => {},
    };
    const w = getBootCapabilityWarnings(env);
    expect(w.some((x) => x.code === 'DMG-E051')).toBe(true);
  });

  it('flags DMG-E050 when no subtle on HTTPS', () => {
    const env = {
      location: { protocol: 'https:', hostname: 'example.com' },
      crypto: {},
      structuredClone: () => {},
    };
    expect(getBootCapabilityWarnings(env).some((x) => x.code === 'DMG-E050')).toBe(true);
  });

  it('allows HTTP localhost without subtle for E051 (still E050 for missing crypto)', () => {
    const env = {
      location: { protocol: 'http:', hostname: 'localhost' },
      crypto: {},
      structuredClone: () => {},
    };
    const w = getBootCapabilityWarnings(env);
    expect(w.some((x) => x.code === 'DMG-E051')).toBe(false);
    expect(w.some((x) => x.code === 'DMG-E050')).toBe(true);
  });

  it('flags missing structuredClone', () => {
    const env = {
      location: { protocol: 'https:', hostname: 'x.com' },
      crypto: { subtle: {} },
    };
    const w = getBootCapabilityWarnings(env);
    expect(w.length).toBe(1);
    expect(w[0].code).toBe('DMG-E050');
    expect(w[0].message).toContain('Structured cloning');
  });
});
