import { expect, test } from 'bun:test';

import { DEFAULT_TREE_HEIGHT, mergeTrees } from './trees.ts';

test('a mapped tree takes the height of the crown above it, and the crown is not doubled', () => {
  const merged = mergeTrees(
    [0, 0, 50, 50],
    [
      [1, 1, 15],
      [3, -3, 9],
      [100, 100, 20],
    ],
  );
  expect(merged.positions).toEqual([0, 0, 50, 50, 3, -3, 100, 100]);
  expect(merged.heights).toEqual([15, DEFAULT_TREE_HEIGHT, 9, 20]);
});

test('each crown is claimed by at most one mapped tree', () => {
  const merged = mergeTrees([0, 0, 0.5, 0], [[0.2, 0, 12]]);
  expect(merged.heights).toEqual([12, DEFAULT_TREE_HEIGHT]);
  expect(merged.positions).toHaveLength(4);
});
