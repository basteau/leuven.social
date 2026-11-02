import { expect, test } from 'bun:test';

import { MinHeap } from './heap.ts';

test('pops items in key order, grows past its first size, and is empty at -1', () => {
  const heap = new MinHeap();
  expect(heap.pop()).toBe(-1);
  const keys = Array.from({ length: 3000 }, (_, i) => ((i * 7919) % 1009) / 7);
  for (const [i, key] of keys.entries()) heap.push(i, key);
  expect(heap.size).toBe(3000);
  let last = -Infinity;
  for (let n = 0; n < keys.length; n++) {
    const item = heap.pop();
    expect(keys[item]).toBeGreaterThanOrEqual(last);
    last = keys[item]!;
  }
  expect(heap.pop()).toBe(-1);
  heap.push(1, 2);
  heap.push(2, 1);
  heap.clear();
  expect(heap.size).toBe(0);
  expect(heap.pop()).toBe(-1);
});
