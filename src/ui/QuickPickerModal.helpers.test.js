// Pure-logic checks for the quick-picker merge behavior. The component
// itself owns React state; we re-implement the merge here to lock in
// the contract: existing entries bump, new entries append, qty + unit
// from the picker are honored.

import { describe, it, expect } from 'vitest';

function mergePicksIntoList(shoppingList, entries, uidFn = () => 'gen') {
  let next = [...shoppingList];
  let added = 0, bumped = 0;
  for (const { item, qty, unit } of entries) {
    const sellerList = Array.isArray(item.sellers) ? item.sellers : [];
    const sel = sellerList[0] || { name: '', price: null };
    const idx = next.findIndex(s => s.itemId === item.id && s.selectedSeller === sel.name);
    if (idx >= 0) {
      next[idx] = { ...next[idx], quantity: (Number(next[idx].quantity) || 0) + qty, unit };
      bumped++;
    } else {
      next.push({ id: uidFn(), itemId: item.id, itemName: item.name, unit, upc: item.upc || '', selectedSeller: sel.name, price: sel.price, quantity: qty, sellers: sellerList });
      added++;
    }
  }
  return { next, added, bumped };
}

const rice = { id: 'i1', name: 'Basmati rice', unit: 'lb', sellers: [{ name: 'Restaurant Depot', price: 28 }] };
const naan = { id: 'i2', name: 'Naan', unit: 'each', sellers: [{ name: 'Bakery', price: 0.5 }] };
const lentils = { id: 'i3', name: 'Lentils', unit: 'lb', sellers: [] };

describe('QuickPicker merge', () => {
  it('appends new entries with chosen qty + unit', () => {
    const { next, added, bumped } = mergePicksIntoList([], [
      { item: rice, qty: 25, unit: 'lb' },
      { item: naan, qty: 100, unit: 'each' },
    ]);
    expect(added).toBe(2);
    expect(bumped).toBe(0);
    expect(next).toHaveLength(2);
    expect(next[0].itemName).toBe('Basmati rice');
    expect(next[0].quantity).toBe(25);
    expect(next[0].price).toBe(28); // first seller's price carried over
    expect(next[1].quantity).toBe(100);
  });

  it('bumps the quantity on an existing entry instead of double-adding', () => {
    const existing = [{ id: 'e1', itemId: 'i1', itemName: 'Basmati rice', unit: 'lb', selectedSeller: 'Restaurant Depot', price: 28, quantity: 10, sellers: rice.sellers }];
    const { next, added, bumped } = mergePicksIntoList(existing, [{ item: rice, qty: 5, unit: 'lb' }]);
    expect(added).toBe(0);
    expect(bumped).toBe(1);
    expect(next).toHaveLength(1);
    expect(next[0].quantity).toBe(15);
  });

  it('handles items with no sellers without crashing', () => {
    const { next, added } = mergePicksIntoList([], [{ item: lentils, qty: 3, unit: 'lb' }]);
    expect(added).toBe(1);
    expect(next[0].selectedSeller).toBe('');
    expect(next[0].price).toBeNull();
    expect(next[0].sellers).toEqual([]);
  });

  it('treats a different-seller pick as a new entry, not a bump', () => {
    const existing = [{ id: 'e1', itemId: 'i1', itemName: 'Basmati rice', unit: 'lb', selectedSeller: 'Costco', price: 26, quantity: 10, sellers: rice.sellers }];
    const { next, added, bumped } = mergePicksIntoList(existing, [{ item: rice, qty: 5, unit: 'lb' }]);
    // rice's first seller in this fixture is 'Restaurant Depot' — that
    // doesn't match the existing 'Costco' line, so it appends.
    expect(added).toBe(1);
    expect(bumped).toBe(0);
    expect(next).toHaveLength(2);
  });
});
