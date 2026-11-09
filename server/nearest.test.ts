import { describe, expect, test } from 'bun:test';

import { nearestFirst } from './nearest.ts';

const arrays = (values: number[]) => ({
  ids: Int32Array.from(values),
  distances: Float64Array.from(values),
});
const firstK = (ids: Int32Array, k: number) => [...ids.subarray(0, k)].toSorted((a, b) => a - b);

describe('nearestFirst', () => {
  test('brings the k smallest to the front, in both arrays', () => {
    const values = [9, 3, 7, 1, 8, 2, 6, 4, 5, 0];
    const { ids, distances } = arrays(values);
    nearestFirst(ids, distances, values.length, 3);
    expect(firstK(ids, 3)).toEqual([0, 1, 2]);
    expect([...ids].toSorted((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect([...distances]).toEqual([...ids].map(Number));
  });

  test('copes with ties and random crowds', () => {
    for (let round = 0; round < 50; round++) {
      const values = Array.from({ length: 200 }, () => Math.floor(Math.random() * 20));
      const sorted = values.toSorted((a, b) => a - b);
      const { ids, distances } = arrays(values);
      nearestFirst(ids, distances, values.length, 32);
      expect(firstK(ids, 32)).toEqual(sorted.slice(0, 32));
    }
  });

  test('only looks at the first count entries', () => {
    const { ids, distances } = arrays([5, 4, 3, 2, 1, 0]);
    nearestFirst(ids, distances, 4, 2);
    expect([...ids.subarray(4)]).toEqual([1, 0]);
    expect(firstK(ids, 2)).toEqual([2, 3]);
  });

  test('leaves the list alone when everything or nothing is wanted', () => {
    const { ids, distances } = arrays([3, 1, 2]);
    nearestFirst(ids, distances, 3, 3);
    nearestFirst(ids, distances, 3, 0);
    expect([...ids]).toEqual([3, 1, 2]);
  });
});
