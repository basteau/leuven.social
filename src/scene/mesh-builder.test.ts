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
