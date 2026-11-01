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

test('geometries come with the bounds three would compute, without another pass', () => {
  const mesh = new MeshBuilder();
  mesh.quad([0.1, 0, 0], [3, 0, 0], [3, 2.7, -4], [0.1, 2.7, -4], 0x336699, [0, 0, 1]);
  const lines = new LineBuilder();
  for (let i = 0; i < 2000; i++) lines.segment([i, 0, 0.3], [i, 5, -0.3]); // past its capacity
  for (const g of [mesh.build(), lines.build(), new MeshBuilder().build()]) {
    const { boundingBox, boundingSphere } = g;
    g.computeBoundingBox();
    g.computeBoundingSphere();
    expect(boundingBox).toEqual(g.boundingBox!);
    expect(boundingSphere!.center).toEqual(g.boundingSphere!.center);
    expect(boundingSphere!.radius).toBeGreaterThanOrEqual(g.boundingSphere!.radius);
  }
  expect(lines.build().getAttribute('position').count).toBe(4000);
});

test('colours are written in linear RGB, as three converts sRGB hex', () => {
  const mesh = new MeshBuilder();
  mesh.triangle([0, 0, 0], [1, 0, 0], [0, 0, 1], 0x808080, [0, 1, 0]);
  mesh.triangle([0, 0, 0], [1, 0, 0], [0, 0, 1], 0x808080, [0, 1, 0]);
  const color = mesh.build().getAttribute('color');
  expect(color.getX(0)).toBeCloseTo(0.2158605, 6);
  expect(color.getX(5)).toBe(color.getX(0));
});
