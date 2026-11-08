import { describe, expect, test } from 'bun:test';

import { nearestFirst } from './nearest.ts';

const byValue = (v: number) => v;

describe('nearestFirst', () => {
  test('brings the k smallest to the front', () => {
    const items = [9, 3, 7, 1, 8, 2, 6, 4, 5, 0];
    nearestFirst(items, items.length, 3, byValue);
    expect(items.slice(0, 3).toSorted((a, b) => a - b)).toEqual([0, 1, 2]);
    expect(items.toSorted((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test('copes with ties and random crowds', () => {
    for (let round = 0; round < 50; round++) {
      const items = Array.from({ length: 200 }, () => Math.floor(Math.random() * 20));
      const sorted = items.toSorted((a, b) => a - b);
      nearestFirst(items, items.length, 32, byValue);
      expect(items.slice(0, 32).toSorted((a, b) => a - b)).toEqual(sorted.slice(0, 32));
    }
  });

  test('only looks at the first count items', () => {
    const items = [5, 4, 3, 2, 1, 0];
    nearestFirst(items, 4, 2, byValue);
    expect(items.slice(4)).toEqual([1, 0]);
    expect(items.slice(0, 2).toSorted((a, b) => a - b)).toEqual([2, 3]);
  });

  test('leaves the list alone when everything or nothing is wanted', () => {
    const items = [3, 1, 2];
    nearestFirst(items, 3, 3, byValue);
    nearestFirst(items, 3, 0, byValue);
    expect(items).toEqual([3, 1, 2]);
  });
});
