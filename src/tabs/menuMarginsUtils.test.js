import { describe, it, expect } from 'vitest';

// Replicates toBase from MenuMarginsLab.jsx
function toBase(qty, unit) {
  const q = Number(qty || 0);
  const u = String(unit || 'each').toLowerCase();
  const mult = ({ each:1, oz:1, lb:16, g:0.035274, kg:35.274, ml:0.033814, l:33.814 })[u] || 1;
  return q * mult;
}

// Replicates calcMenuMetrics margin math
function calcMargin(price, cost) {
  const profitNow = price - cost;
  const marginNow = price > 0 ? (profitNow / price * 100) : 0;
  return { profitNow, marginNow };
}

// Replicates recommended price calc from calcMenuMetrics
function calcRecommendedPrice(costNow, targetMarginPct) {
  return costNow > 0 ? (costNow / (1 - (targetMarginPct / 100))) : 0;
}

// Replicates itemLatestCost selection (min seller price)
function getItemLatestCost(sellers) {
  const prices = (sellers || []).map(s => {
    const n = parseFloat(s.price);
    return n >= 0 ? n : null;
  }).filter(v => v !== null);
  if (!prices.length) return null;
  return Math.min(...prices);
}

describe('toBase — unit conversion', () => {
  it('each → 1 (no conversion)', () => {
    expect(toBase(5, 'each')).toBe(5);
  });

  it('oz → 1 (base unit)', () => {
    expect(toBase(8, 'oz')).toBe(8);
  });

  it('lb → 16 oz', () => {
    expect(toBase(2, 'lb')).toBe(32);
  });

  it('kg → 35.274 oz', () => {
    expect(toBase(1, 'kg')).toBeCloseTo(35.274);
  });

  it('g → 0.035274 oz', () => {
    expect(toBase(100, 'g')).toBeCloseTo(3.5274);
  });

  it('l → 33.814 oz-equiv', () => {
    expect(toBase(1, 'l')).toBeCloseTo(33.814);
  });

  it('ml → small fraction', () => {
    expect(toBase(1000, 'ml')).toBeCloseTo(33.814);
  });

  it('unknown unit defaults to multiplier 1', () => {
    expect(toBase(5, 'cups')).toBe(5);
  });

  it('zero quantity returns 0', () => {
    expect(toBase(0, 'lb')).toBe(0);
  });

  it('null/undefined quantity treated as 0', () => {
    expect(toBase(null, 'lb')).toBe(0);
    expect(toBase(undefined, 'lb')).toBe(0);
  });

  it('null/undefined unit treated as each', () => {
    expect(toBase(3, null)).toBe(3);
    expect(toBase(3, undefined)).toBe(3);
  });

  it('case-insensitive unit matching', () => {
    expect(toBase(1, 'LB')).toBe(16);
    expect(toBase(1, 'KG')).toBeCloseTo(35.274);
  });
});

describe('calcMargin', () => {
  it('50% margin when cost is half of price', () => {
    const { marginNow } = calcMargin(100, 50);
    expect(marginNow).toBe(50);
  });

  it('0% margin when cost equals price', () => {
    const { marginNow, profitNow } = calcMargin(100, 100);
    expect(marginNow).toBe(0);
    expect(profitNow).toBe(0);
  });

  it('negative margin when cost exceeds price', () => {
    const { marginNow } = calcMargin(100, 120);
    expect(marginNow).toBe(-20);
  });

  it('returns 0% margin when price is 0 (avoid division by zero)', () => {
    const { marginNow } = calcMargin(0, 50);
    expect(marginNow).toBe(0);
  });

  it('100% margin when cost is 0', () => {
    const { marginNow } = calcMargin(100, 0);
    expect(marginNow).toBe(100);
  });
});

describe('calcRecommendedPrice', () => {
  it('returns cost / (1 - targetMargin/100)', () => {
    // At 50% target: price = cost / 0.5 = 2× cost
    expect(calcRecommendedPrice(50, 50)).toBeCloseTo(100);
  });

  it('at 33.33% margin: price ≈ 1.5× cost', () => {
    // 30 / (1 - 0.3333) ≈ 45.00
    expect(calcRecommendedPrice(30, 33.33)).toBeCloseTo(45, 0);
  });

  it('returns 0 when cost is 0 (no recipe cost data)', () => {
    expect(calcRecommendedPrice(0, 50)).toBe(0);
  });

  it('very high target margin pushes price up sharply', () => {
    expect(calcRecommendedPrice(10, 90)).toBeCloseTo(100);
  });
});

describe('getItemLatestCost', () => {
  it('returns minimum price across sellers', () => {
    const sellers = [{ price: '5' }, { price: '3' }, { price: '8' }];
    expect(getItemLatestCost(sellers)).toBe(3);
  });

  it('returns null when no sellers', () => {
    expect(getItemLatestCost([])).toBeNull();
    expect(getItemLatestCost(null)).toBeNull();
  });

  it('ignores sellers with no price', () => {
    const sellers = [{ price: null }, { price: '7' }];
    expect(getItemLatestCost(sellers)).toBe(7);
  });

  it('returns null when all prices are invalid', () => {
    const sellers = [{ price: 'n/a' }, { price: null }];
    expect(getItemLatestCost(sellers)).toBeNull();
  });

  it('handles numeric price (not string)', () => {
    expect(getItemLatestCost([{ price: 12.5 }])).toBe(12.5);
  });
});
