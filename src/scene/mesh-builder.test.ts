import { expect, test } from 'bun:test';

import type { BufferAttribute } from 'three';

import { LineBuilder, MeshBuilder, geometryBytes, linearVertexColors } from './mesh-builder.ts';

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

const bytes = (a: { array: ArrayLike<number> & { BYTES_PER_ELEMENT: number } }) =>
  a.array.length * a.array.BYTES_PER_ELEMENT;

test("a vertex is 24 bytes: colours as the palette's sRGB bytes, normals as signed bytes", () => {
  const mesh = new MeshBuilder();
  mesh.triangle([0, 0, 0], [1, 0, 0], [0, 0, 1], 0x8040c0, [0, 1, 0], 7);
  const g = mesh.build({ facade: true });
  const color = g.getAttribute('color');
  expect([color.getX(2), color.getY(2), color.getZ(2)].map((c) => Math.round(c * 255))).toEqual([
    0x80, 0x40, 0xc0,
  ]);
  expect(g.getAttribute('normal').getY(0)).toBe(1);
  const sizes = Object.values(g.attributes).map((a) =>
    'data' in a ? bytes(a.data as never) : bytes(a as never),
  );
  expect(sizes.reduce((s, b) => s + b, 0) / 3).toBe(24);
  expect(geometryBytes(g)).toBe(24 * 3);
  expect(geometryBytes(new LineBuilder().build())).toBe(0);
});

test("vertex shaders turn the sRGB colours linear, as three's Color.setHex does", () => {
  const shader = linearVertexColors('#include <color_vertex>\nvoid main() {}');
  expect(shader).toStartWith('#include <color_vertex>');
  expect(shader).toContain('0.0773993808');
  expect(shader).toContain('vec3(2.4)');
});

test('arrays are let go once the GPU has them', () => {
  const mesh = new MeshBuilder();
  mesh.triangle([0, 0, 0], [1, 0, 0], [0, 0, 1], 0, [0, 1, 0]);
  const g = mesh.build({ facade: true });
  const position = g.getAttribute('position') as BufferAttribute;
  const count = position.count;
  position.onUploadCallback();
  expect(position.array).toBeNull();
  expect(position.count).toBe(count);
  const lines = new LineBuilder();
  lines.segment([0, 0, 0], [1, 1, 1]);
  const points = lines.build().getAttribute('position') as BufferAttribute;
  points.onUploadCallback();
  expect(points.array).toBeNull();
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

test('lines count their segments', () => {
  const lines = new LineBuilder();
  lines.segment([0, 0, 0], [1, 0, 0]);
  lines.segment([0, 0, 0], [0, 1, 0]);
  expect(lines.segments).toBe(2);
});
