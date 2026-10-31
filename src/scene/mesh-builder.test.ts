import { expect, test } from 'bun:test';

import { LineBuilder, MeshBuilder } from './mesh-builder.ts';

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

test('a facade value per corner follows its corner when a triangle is flipped', () => {
  const mesh = new MeshBuilder();
  // Wound clockwise from above, so it flips to face up: b and c swap places.
  mesh.quad([0, 0, 0], [0, 0, 1], [1, 0, 1], [1, 0, 0], 0, [0, 1, 0], [-1, -2, -3, -4]);
  const g = mesh.build({ facade: true });
  const [position, facade] = [g.getAttribute('position'), g.getAttribute('facade')];
  const at = (x: number, z: number) =>
    Array.from({ length: position.count }, (_, i) => i)
      .filter((i) => position.getX(i) === x && position.getZ(i) === z)
      .map((i) => facade.getX(i));
  expect(at(0, 0)).toEqual([-1, -1]);
  expect(at(0, 1)).toEqual([-2]);
  expect(at(1, 1)).toEqual([-3, -3]);
  expect(at(1, 0)).toEqual([-4]);
  expect(g.getAttribute('normal').getY(0)).toBe(1);
});

test('lines count their segments', () => {
  const lines = new LineBuilder();
  lines.segment([0, 0, 0], [1, 0, 0]);
  lines.segment([0, 0, 0], [0, 1, 0]);
  expect(lines.segments).toBe(2);
});
