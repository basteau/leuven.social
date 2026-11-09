import { expect, test } from 'bun:test';

import {
  DEFAULT_TREE_HEIGHT,
  MAX_TRUNK,
  clearCrowns,
  mergeTrees,
  treeScale,
  trunkRadius,
  treeKindOf,
} from './trees.ts';

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

test('trees grow within the limits of the model, their trunks at most 35 cm round', () => {
  expect(treeScale(1)).toBe(0.7);
  expect(treeScale(100)).toBe(2.8);
  expect(trunkRadius(100)).toBe(MAX_TRUNK);
  expect(MAX_TRUNK).toBe(0.35);
  for (const h of [1, 7, 12, 30]) expect(trunkRadius(h)).toBeLessThanOrEqual(MAX_TRUNK);
});

test('LiDAR crowns give way to what is mapped; mapped trees stay', () => {
  const trees = { positions: [0, 0, 10, 0, 20, 0], heights: [7, 12, 15], kinds: [1, 0, 0] };
  // Something mapped stands round x = 0 and x = 10: only the crown there goes.
  expect(clearCrowns(trees, 1, (x) => x < 15)).toEqual({
    positions: [0, 0, 20, 0],
    heights: [7, 15],
    kinds: [1, 0],
  });
  expect(clearCrowns(trees, 1, () => false)).toEqual(trees);
});

test('a tree is what OSM says it is, and broad where it says nothing', () => {
  expect(treeKindOf({})).toBe('broad');
  expect(treeKindOf({ leaf_type: 'broadleaved' })).toBe('broad');
  expect(treeKindOf({ leaf_type: 'needleleaved' })).toBe('conifer');
  expect(treeKindOf({ genus: 'Pinus' })).toBe('conifer');
  expect(treeKindOf({ 'species:nl': 'Levensboom (Reuze-)' })).toBe('conifer');
  expect(treeKindOf({ genus: 'Populus' })).toBe('column');
  expect(treeKindOf({ genus: 'Salix' })).toBe('willow');
  expect(treeKindOf({ 'species:nl': 'Wilg' })).toBe('willow');
  // A copper beech is no colour of its own: every crown on the map is a green.
  expect(treeKindOf({ species: 'Fagus sylvatica atropunicea' })).toBe('broad');
});
