import { expect, test } from 'bun:test';

import { MeshBuilder, unindexed } from './mesh-builder.ts';
import { TREE_KINDS } from '../data/city.ts';
import type { TreeKind } from '../data/city.ts';
import { deltaE, toOklab } from '../data/colour.ts';
import { trunkRadius } from '../data/trees.ts';
import { TREE } from './palette.ts';
import { MODEL_HEIGHT, PUFF, TREE_TRIANGLES, addPuffs, addTree, crownColor } from './trees.ts';

test('a tree is a slim trunk and a low-poly crown, all facing outward', () => {
  const mesh = new MeshBuilder();
  addTree(mesh, 100, -50, 7);
  const g = unindexed(mesh.build());
  expect(TREE_TRIANGLES).toBe(4 * 2 + 20);
  expect(g.getAttribute('position').count).toBe(TREE_TRIANGLES * 3);
  g.computeBoundingBox();
  const b = g.boundingBox!;
  expect(b.min.y).toBeCloseTo(0);
  expect((b.min.x + b.max.x) / 2).toBeCloseTo(100, 0);
  expect((b.min.z + b.max.z) / 2).toBeCloseTo(-50, 0);
  // The crown's top faces point up, the trunk's sides point sideways.
  const normals = g.getAttribute('normal');
  expect(
    Math.max(...Array.from({ length: normals.count }, (_, i) => normals.getY(i))),
  ).toBeGreaterThan(0.5);
});

/** Height of the tree a seed grows. */
function size(seed: number, height = 0): number {
  const mesh = new MeshBuilder();
  addTree(mesh, 0, 0, seed, height);
  const g = unindexed(mesh.build());
  g.computeBoundingBox();
  return g.boundingBox!.max.y;
}

test('the seed varies size and tint, the same seed gives the same tree', () => {
  expect(size(3)).toBe(size(3));
  expect(new Set([0, 1, 2, 3, 4, 5, 6, 7].map(size)).size).toBeGreaterThan(1);
});

test('a surveyed tree grows to its height, within what the model can stretch to', () => {
  expect(size(1, 13.6)).toBeCloseTo(13.6, 0);
  expect(size(1, 1)).toBeCloseTo(MODEL_HEIGHT * 0.7, 1);
  expect(size(1, 60)).toBeCloseTo(MODEL_HEIGHT * 2.8, 1);
});

test('a tree can be written in parts, trunk and crown apart', () => {
  const [trunk, crown] = [['trunk'], ['crown']].map((parts) => {
    const mesh = new MeshBuilder();
    addTree(mesh, 0, 0, 2, 0, parts as ['trunk'] | ['crown']);
    return unindexed(mesh.build()).getAttribute('position').count / 3;
  });
  expect(trunk).toBe(8);
  expect(crown).toBe(20);
});

test('every tree has its own green near the crown colour, older ones darker', () => {
  const crowns = Array.from({ length: 300 }, (_, seed) => crownColor(seed, 10));
  const greens = crowns.filter((c) => deltaE(c, TREE.crown) < 0.08);
  expect(new Set(greens).size).toBeGreaterThan(30);
  expect(toOklab(crownColor(5, 25))[0]).toBeLessThan(toOklab(crownColor(5, 7))[0]);
  // Every one of them green, small trees too: a pink crown read as a mistake.
  expect(greens.length).toBe(crowns.length);
  const small = Array.from({ length: 300 }, (_, seed) => crownColor(seed, 4));
  expect(small.every((c) => deltaE(c, TREE.crown) < 0.08)).toBe(true);
});

test('a trunk is never drawn wider than street furniture keeps clear of', () => {
  for (const height of [3, 7, 12, 25, 60]) {
    for (let seed = 0; seed < 20; seed++) {
      const mesh = new MeshBuilder();
      addTree(mesh, 0, 0, seed, height);
      const position = unindexed(mesh.build()).getAttribute('position');
      for (let i = 0; i < position.count; i++) {
        if (position.getY(i) > 0.01) continue; // the trunk's foot, its widest
        expect(Math.hypot(position.getX(i), position.getZ(i))).toBeLessThanOrEqual(
          trunkRadius(height) + 1e-6, // float32 positions
        );
      }
    }
  }
});

const puffs = (seed: number, height: number) => {
  const [spots, colors]: [number[], number[]] = [[], []];
  addPuffs(spots, colors, 10, 3, -20, seed, height);
  return { spots, colors, count: spots.length / PUFF.stride };
};

test('up close a crown is puffs of leaves: a dark ball inside, more on a bigger tree', () => {
  const small = puffs(5, 7);
  const big = puffs(5, 24);
  expect(big.count).toBeGreaterThan(small.count);
  expect(small.count).toBeGreaterThanOrEqual(PUFF.min + 1);
  expect(big.count).toBeLessThanOrEqual(PUFF.max + 1);
  expect(small.colors.length).toBe(small.count * 4);
  // The core is the first, darker than the leaves round it, and every puff is up in the air.
  const luma = (i: number) =>
    small.colors[i * 4]! + small.colors[i * 4 + 1]! + small.colors[i * 4 + 2]!;
  for (let i = 1; i < small.count; i++) expect(luma(i)).toBeGreaterThan(luma(0));
  for (let i = 0; i < big.count; i++) expect(big.spots[i * 4 + 1]!).toBeGreaterThan(3);
  // The same seed gives the same tree.
  expect(puffs(5, 7).spots).toEqual(small.spots);
  expect(puffs(6, 7).spots).not.toEqual(small.spots);
});

const shapeOf = (kind: TreeKind) => {
  const [spots, colors]: [number[], number[]] = [[], []];
  addPuffs(spots, colors, 0, 0, 0, 3, 18, kind);
  let [wide, high] = [0, 0];
  for (let i = 1; i < spots.length / 4; i++) {
    wide = Math.max(wide, Math.hypot(spots[i * 4]!, spots[i * 4 + 2]!));
    high = Math.max(high, spots[i * 4 + 1]!);
  }
  return { ratio: high / wide, leaf: colors.slice(4, 8) };
};

test('a tree takes the shape and colour of what OSM says it is', () => {
  const broad = shapeOf('broad');
  expect(shapeOf('column').ratio).toBeGreaterThan(broad.ratio * 1.2);
  const [cr, cg, cb] = shapeOf('conifer').leaf;
  expect(cb! / cg!).toBeGreaterThan(broad.leaf[2]! / broad.leaf[1]!);
  expect(cr! + cg! + cb!).toBeLessThan(broad.leaf[0]! + broad.leaf[1]! + broad.leaf[2]!);
  // Left out, a tree is broad, and the same seed always gives the same one.
  const [a1, a2]: [number[], number[]] = [[], []];
  addPuffs(a1, a2, 0, 0, 0, 3, 18);
  const [b1, b2]: [number[], number[]] = [[], []];
  addPuffs(b1, b2, 0, 0, 0, 3, 18, 'broad');
  expect(a1).toEqual(b1);
});

test('every crown is a green, whatever the tree', () => {
  for (const kind of TREE_KINDS) {
    for (const seed of [1, 2, 3, 5, 8, 13]) {
      for (const height of [4, 12, 22]) {
        const [spots, colors]: [number[], number[]] = [[], []];
        addPuffs(spots, colors, 0, 0, 0, seed, height, kind);
        for (let i = 0; i < colors.length; i += 4) {
          expect(colors[i + 1]!).toBeGreaterThan(colors[i]!);
          expect(colors[i + 1]!).toBeGreaterThan(colors[i + 2]!);
        }
      }
    }
  }
});
