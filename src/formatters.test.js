import { describe, it, expect } from 'vitest';
import {
  fmt$,
  fmtBytes,
  fmtDate,
  safeQty,
  sellerKey,
  normalizeApiBase,
  parseUrlSafe,
  isLoopbackHost,
  trimText,
  migrateShoppingList,
  uniqSuggestions,
  safePrice,
} from './formatters.js';

describe('formatters', () => {
  describe('fmt$', () => {
    it('formats USD with commas', () => {
      expect(fmt$(1234.5)).toBe('$1,234.50');
      expect(fmt$(0)).toBe('$0.00');
    });
    it('treats invalid as zero', () => {
      expect(fmt$('oops')).toBe('$0.00');
    });
  });

  describe('fmtBytes', () => {
    it('returns empty for non-finite', () => {
      expect(fmtBytes(NaN)).toBe('');
      expect(fmtBytes(null)).toBe('');
    });
    it('shows B / KB / MB', () => {
      expect(fmtBytes(500)).toMatch(/500 B/);
      expect(fmtBytes(2048)).toContain('KB');
      expect(fmtBytes(2097152)).toContain('MB');
    });
  });

  describe('fmtDate', () => {
    it('returns empty for falsy', () => {
      expect(fmtDate('')).toBe('');
      expect(fmtDate(null)).toBe('');
    });
    it('formats ISO date string', () => {
      const s = fmtDate('2024-06-15');
      expect(s.length).toBeGreaterThan(0);
      expect(s).toMatch(/2024/);
    });
  });

  describe('safeQty', () => {
    it('parses non-negative numbers', () => {
      expect(safeQty('3.5')).toBe(3.5);
      expect(safeQty(0)).toBe(0);
    });
    it('returns 0 for negative or NaN', () => {
      expect(safeQty(-1)).toBe(0);
      expect(safeQty('x')).toBe(0);
    });
  });

  describe('sellerKey', () => {
    it('lowercases and trims', () => {
      expect(sellerKey('  Acme Foods  ')).toBe('acme foods');
    });
  });

  describe('normalizeApiBase', () => {
    it('trims trailing slashes', () => {
      expect(normalizeApiBase('https://api.example.com/')).toBe('https://api.example.com');
      expect(normalizeApiBase('  http://localhost:3000///  ')).toBe('http://localhost:3000');
    });
  });

  describe('parseUrlSafe', () => {
    it('parses valid URLs', () => {
      const u = parseUrlSafe('https://x.com/path');
      expect(u?.hostname).toBe('x.com');
    });
    it('returns null for invalid', () => {
      expect(parseUrlSafe('not a url')).toBeNull();
    });
  });

  describe('isLoopbackHost', () => {
    it('recognizes loopback hostnames', () => {
      expect(isLoopbackHost('localhost')).toBe(true);
      expect(isLoopbackHost('127.0.0.1')).toBe(true);
      expect(isLoopbackHost('::1')).toBe(true);
      expect(isLoopbackHost('example.com')).toBe(false);
    });
  });

  describe('trimText', () => {
    it('truncates long strings', () => {
      const long = 'a'.repeat(100);
      expect(trimText(long, 10)).toBe('aaaaaaaaaa...(truncated)');
    });
  });

  describe('migrateShoppingList', () => {
    it('returns empty for non-array', () => {
      expect(migrateShoppingList(null)).toEqual([]);
      expect(migrateShoppingList({})).toEqual([]);
    });
    it('filters and maps entries', () => {
      const out = migrateShoppingList([
        { id: '1', itemName: 'Egg', quantity: 2 },
        null,
        { id: '2' },
      ]);
      expect(out).toHaveLength(1);
      expect(out[0].itemName).toBe('Egg');
      expect(out[0].quantity).toBe(2);
      expect(out[0].sellers).toEqual([]);
    });
  });

  describe('uniqSuggestions', () => {
    it('dedupes case-insensitively sorted', () => {
      expect(uniqSuggestions('b', 'a', 'a', '  b  ', '')).toEqual(['a', 'b']);
    });
  });

  describe('safePrice', () => {
    it('parses valid prices', () => {
      expect(safePrice('12.99')).toBe(12.99);
      expect(safePrice(0)).toBe(0);
    });
    it('returns null for empty or invalid', () => {
      expect(safePrice('')).toBeNull();
      expect(safePrice(null)).toBeNull();
      expect(safePrice(-1)).toBeNull();
    });
  });
});
