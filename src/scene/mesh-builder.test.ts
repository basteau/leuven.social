import { expect, test } from 'bun:test';

import { MeshBuilder } from './mesh-builder.ts';

test('grows past its initial capacity without losing vertices', () => {
  const mesh = new MeshBuilder();
  const triangles = 20_000; // 60k vertices: several doublings
  for (let i = 0; i < triangles; i++) {
    mesh.triangle([i, 0, 0], [i + 1, 0, 0], [i, 0, 1], 0xff0000, [0, 1, 0]);
  }
  const g = mesh.build();
  const position = g.getAttribute('position');
  expect(position.count).toBe(triangles * 3);
  expect(position.getX(position.count - 3)).toBe(triangles - 1);
  expect(g.getAttribute('normal').getY(position.count - 1)).toBe(1);
  expect(g.getAttribute('facade')).toBeUndefined();
});

test('skips degenerate triangles', () => {
  const mesh = new MeshBuilder();
  mesh.triangle([0, 0, 0], [1, 0, 0], [2, 0, 0], 0, [0, 1, 0]);
  expect(mesh.build().getAttribute('position').count).toBe(0);
});

test('carries a facade value per vertex, and keeps it with its vertex when a triangle flips', () => {
  const mesh = new MeshBuilder();
  // Clockwise from above, so it flips to face up: the second and third vertices swap.
  mesh.quad([0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1], 0, [0, 1, 0], [-1, -2, -3, -4]);
  mesh.triangle([0, 0, 0], [1, 0, 0], [0, 1, 0], 0, [0, 0, 1], 5);
  const g = mesh.build({ facade: true });
  const p = g.getAttribute('position');
  const f = g.getAttribute('facade');
  const at = (x: number, z: number) =>
    Array.from({ length: 6 }, (_, i) => i).filter((i) => p.getX(i) === x && p.getZ(i) === z);
  for (const [x, z, code] of [
    [0, 0, -1],
    [1, 0, -2],
    [1, 1, -3],
    [0, 1, -4],
  ] as const) {
    for (const i of at(x, z)) expect(f.getX(i)).toBe(code);
  }
  expect(g.getAttribute('normal').getY(0)).toBe(1);
  // Flipped: stored as a, c, b.
  expect([p.getX(1), p.getZ(1)]).toEqual([1, 1]);
  expect([f.getX(6), f.getX(7), f.getX(8)]).toEqual([5, 5, 5]);
});
