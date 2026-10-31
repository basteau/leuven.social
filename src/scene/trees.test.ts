import { expect, test } from 'bun:test';

import { MeshBuilder } from './mesh-builder.ts';
import { TREE_TRIANGLES, addTree } from './trees.ts';

test('a tree is a slim trunk and a low-poly crown, all facing outward', () => {
  const mesh = new MeshBuilder();
  addTree(mesh, 100, -50, 7);
  const g = mesh.build();
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
function size(seed: number): number {
  const mesh = new MeshBuilder();
  addTree(mesh, 0, 0, seed);
  const g = mesh.build();
  g.computeBoundingBox();
  return g.boundingBox!.max.y;
}

test('the seed varies size and tint, the same seed gives the same tree', () => {
  expect(size(3)).toBe(size(3));
  expect(new Set([0, 1, 2, 3, 4, 5, 6, 7].map(size)).size).toBeGreaterThan(1);
});
