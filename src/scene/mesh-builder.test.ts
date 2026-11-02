import { expect, test } from 'bun:test';

import type { BufferAttribute } from 'three';

import { Terrain } from '../data/terrain.ts';
import {
  LIFT_UNIT,
  LineBuilder,
  MeshBuilder,
  corners,
  geometryBytes,
  linearVertexColors,
  unindexed,
} from './mesh-builder.ts';

const UP = [0, 1, 0] as const;

test('grows past its initial capacity without losing vertices', () => {
  const mesh = new MeshBuilder();
  const triangles = 30_000; // 90k vertices: several doublings, and past 16-bit indices
  for (let i = 0; i < triangles; i++) {
    mesh.triangle([i, 0, 0], [i + 1, 0, 0], [i, 0, 1], 0xff0000, UP);
  }
  expect(mesh.indices).toBe(triangles * 3);
  const g = mesh.build();
  expect(g.index!.array).toBeInstanceOf(Uint32Array);
  const position = unindexed(g).getAttribute('position');
  expect(position.count).toBe(triangles * 3);
  expect(position.getX(position.count - 3)).toBe(triangles - 1);
  expect(g.getAttribute('normal').getY(g.getAttribute('position').count - 1)).toBe(1);
  expect(g.getAttribute('facade')).toBeUndefined();
});

/** The index array of outlines with this many points. */
function sized(vertices: number) {
  const lines = new LineBuilder();
  for (let i = 0; i < vertices / 2; i++) lines.segment([i, 0, 0], [i, 1, 0]);
  return lines.build().index!.array;
}

test('indices are 16-bit while they fit, leaving out the restart index 65535', () => {
  expect(sized(65_534)).toBeInstanceOf(Uint16Array);
  expect(sized(65_536)).toBeInstanceOf(Uint32Array);
});

test('skips degenerate triangles', () => {
  const mesh = new MeshBuilder();
  mesh.triangle([0, 0, 0], [1, 0, 0], [2, 0, 0], 0, UP);
  mesh.quad([0, 0, 0], [1, 0, 0], [2, 0, 0], [0, 0, 1], 0, UP);
  const g = mesh.build();
  expect(corners(g)).toBe(3);
  expect(g.getAttribute('position').count).toBe(3);
});

test('a flat quad is four vertices and two triangles', () => {
  const mesh = new MeshBuilder();
  mesh.quad([0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1], 0, UP);
  const g = mesh.build();
  expect(g.getAttribute('position').count).toBe(4);
  expect(Array.from(g.index!.array)).toEqual([0, 2, 1, 0, 3, 2]); // flipped to face up
});

test('a folded quad keeps a vertex per triangle corner, so each half keeps its normal', () => {
  const mesh = new MeshBuilder();
  mesh.quad([0, 0, 0], [1, 0, 0], [1, 1, 1], [0, 0, 1], 0, UP);
  const g = mesh.build();
  expect(g.getAttribute('position').count).toBe(6);
  const normal = unindexed(g).getAttribute('normal');
  expect(normal.getX(0)).not.toBeCloseTo(normal.getX(3));
});

test('a polygon shares one vertex per corner where its triangles agree on the normal', () => {
  const mesh = new MeshBuilder();
  const ring = [
    [0, 0, 0],
    [2, 0, 0],
    [2, 0, 2],
    [0, 0, 2],
  ] as const;
  mesh.polygon(
    ring,
    [
      [0, 1, 2],
      [0, 2, 3],
      [0, 1, 1], // degenerate: dropped
    ],
    0x123456,
    UP,
    -3,
  );
  // A tent: two faces meeting along a ridge, each with its own copy of the ridge's corners.
  const tent = [
    [0, 0, 0],
    [2, 0, 0],
    [2, 1, 1],
    [0, 1, 1],
    [2, 0, 2],
    [0, 0, 2],
  ] as const;
  mesh.polygon(
    tent,
    [
      [0, 1, 2],
      [0, 2, 3],
      [3, 2, 4],
      [3, 4, 5],
    ],
    0,
    UP,
  );
  expect(mesh.indices).toBe(6 * 3);
  const g = mesh.build({ facade: true });
  expect(g.getAttribute('position').count).toBe(4 + 8);
  const soup = unindexed(g);
  const normal = soup.getAttribute('normal');
  for (let i = 0; i < 6; i++) expect(normal.getY(i)).toBe(1);
  expect(soup.getAttribute('facade').getX(0)).toBe(-3);
});

test('outlines share the points where their segments meet', () => {
  const lines = new LineBuilder();
  const square = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 0, 1],
    [0, 0, 1],
  ] as const;
  for (let i = 0; i < 4; i++) lines.segment(square[i]!, square[(i + 1) % 4]!);
  lines.segment([0.1, 0, 0], [0.1 + 1e-9, 0, 0]); // the same float apart, so one point
  expect(lines.segments).toBe(5);
  const g = lines.build();
  expect(g.getAttribute('position').count).toBe(5);
  expect(corners(g)).toBe(10);
  const position = unindexed(g).getAttribute('position');
  expect([position.getX(7), position.getZ(7)]).toEqual([0, 0]);
});

test('geometries come with the bounds three would compute, without another pass', () => {
  const mesh = new MeshBuilder();
  mesh.quad([0.1, 0, 0], [3, 0, 0], [3, 2.7, -4], [0.1, 2.7, -4], 0x336699, [0, 0, 1]);
  const lines = new LineBuilder();
  for (let i = 0; i < 5000; i++) lines.segment([i, 0, 0.3], [i, 5, -0.3]); // past its capacity
  for (const g of [mesh.build(), lines.build(), new MeshBuilder().build()]) {
    const { boundingBox, boundingSphere } = g;
    g.computeBoundingBox();
    g.computeBoundingSphere();
    expect(boundingBox).toEqual(g.boundingBox!);
    expect(boundingSphere!.center).toEqual(g.boundingSphere!.center);
    expect(boundingSphere!.radius).toBeGreaterThanOrEqual(g.boundingSphere!.radius);
    expect(unindexed(g).boundingBox).toBe(boundingBox);
  }
  expect(lines.build().getAttribute('position').count).toBe(10_000);
});

const bytes = (a: { array: ArrayLike<number> & { BYTES_PER_ELEMENT: number } }) =>
  a.array.length * a.array.BYTES_PER_ELEMENT;

test("a vertex is 24 bytes: colours as the palette's sRGB bytes, normals as signed bytes", () => {
  const mesh = new MeshBuilder();
  mesh.triangle([0, 0, 0], [1, 0, 0], [0, 0, 1], 0x8040c0, UP, 7);
  const g = mesh.build({ facade: true });
  const color = g.getAttribute('color');
  expect([color.getX(2), color.getY(2), color.getZ(2)].map((c) => Math.round(c * 255))).toEqual([
    0x80, 0x40, 0xc0,
  ]);
  expect(g.getAttribute('normal').getY(0)).toBe(1);
  // The lift rides in the normals' spare byte: a buffer counts once.
  const buffers = new Set(Object.values(g.attributes).map((a) => ('data' in a ? a.data : a)));
  const sizes = [...buffers].map((b) => bytes(b as never));
  expect(sizes.reduce((s, b) => s + b, 0) / 3).toBe(24);
  // Plus two bytes an index.
  expect(geometryBytes(g)).toBe(24 * 3 + 2 * 3);
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
  mesh.triangle([0, 0, 0], [1, 0, 0], [0, 0, 1], 0, UP);
  const g = mesh.build({ facade: true });
  const position = g.getAttribute('position') as BufferAttribute;
  const count = position.count;
  position.onUploadCallback();
  expect(position.array).toBeNull();
  expect(position.count).toBe(count);
  g.index!.onUploadCallback();
  expect(g.index!.array).toBeNull();
  expect(corners(g)).toBe(3);
  const lines = new LineBuilder();
  lines.segment([0, 0, 0], [1, 1, 1]);
  const points = lines.build().getAttribute('position') as BufferAttribute;
  points.onUploadCallback();
  expect(points.array).toBeNull();
  // Kept, for a mesh a lost GPU context would need to upload again.
  const kept = mesh.build({ facade: true, keep: true });
  for (const a of [kept.index!, ...Object.values(kept.attributes)]) {
    const buffer = 'data' in a ? a.data : a;
    buffer.onUploadCallback();
    expect(buffer.array).not.toBeNull();
  }
});

test('carries a facade value per vertex, and keeps it with its vertex when a triangle flips', () => {
  const mesh = new MeshBuilder();
  // Clockwise from above, so it flips to face up: the second and third corners swap.
  mesh.quad([0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1], 0, UP, [-1, -2, -3, -4]);
  mesh.triangle([0, 0, 0], [1, 0, 0], [0, 1, 0], 0, [0, 0, 1], 5);
  const g = unindexed(mesh.build({ facade: true }));
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
  // Flipped: drawn as a, c, b.
  expect([p.getX(1), p.getZ(1)]).toEqual([1, 1]);
  expect([f.getX(6), f.getX(7), f.getX(8)]).toEqual([5, 5, 5]);
});

test('lines count their segments', () => {
  const lines = new LineBuilder();
  lines.segment([0, 0, 0], [1, 0, 0]);
  lines.segment([0, 0, 0], [0, 1, 0]);
  expect(lines.segments).toBe(2);
});

// A slope up to the east with a bump in the middle, in 10 m squares.
const hill = new Terrain({
  step: 10,
  minX: -10,
  minZ: -10,
  cols: 3,
  rows: 3,
  heights: Float32Array.of(0, 1, 2, 0, 4, 2, 0, 1, 2),
});

/** Every vertex's height over the terrain under it. */
function overGround(geometry: ReturnType<MeshBuilder['build']>): number[] {
  const p = geometry.getAttribute('position');
  return Array.from({ length: p.count }, (_, i) => p.getY(i) - hill.height(p.getX(i), p.getZ(i)));
}

test('draped, a flat polygon lies on the terrain, its cut points shared, lit as level', () => {
  const mesh = new MeshBuilder();
  mesh.drape = hill;
  mesh.lift = 5; // ignored while draping
  const ring = [-7, -7, 7, -7, 7, 7, -7, 7];
  const points = [0, 1, 2, 3].map((i) => [ring[i * 2]!, 0.1, ring[i * 2 + 1]!] as const);
  mesh.polygon(points, [], 0x808080, UP, -2);
  const g = mesh.build({ facade: true });
  for (const y of overGround(g)) expect(y).toBeCloseTo(0.1, 5);
  const normal = g.getAttribute('normal');
  for (let i = 0; i < normal.count; i++) expect(normal.getY(i)).toBe(1);
  // Eight pieces, but one vertex per point: 4 corners, 8 cut on the edges, 1 node inside.
  expect(g.getAttribute('position').count).toBe(13);
  expect(g.index!.count / 3).toBeGreaterThanOrEqual(8);
  expect(g.getAttribute('lift').getX(0)).toBe(0);
  // The pieces cover the square once: their areas add up to its own.
  const soup = unindexed(g).getAttribute('position');
  let area = 0;
  for (let i = 0; i < soup.count; i += 3) {
    const [ax, az, bx, bz, cx, cz] = [0, 1, 2].flatMap((k) => [soup.getX(i + k), soup.getZ(i + k)]);
    area += Math.abs((bx! - ax!) * (cz! - az!) - (cx! - ax!) * (bz! - az!)) / 2;
  }
  expect(area).toBeCloseTo(14 * 14);
});

test('draped, quads with a value per corner carry it to the cuts, and walls stay upright', () => {
  const mesh = new MeshBuilder();
  mesh.drape = hill;
  mesh.quad([-5, 0.2, -1], [5, 0.2, -1], [5, 0.2, 1], [-5, 0.2, 1], 0, UP, [-10, -20, -20, -10]);
  const flat = mesh.build({ facade: true });
  for (const y of overGround(flat)) expect(y).toBeCloseTo(0.2, 5);
  const p = flat.getAttribute('position');
  const facade = flat.getAttribute('facade');
  // The value ran from -10 at x = -5 to -20 at x = 5.
  for (let i = 0; i < p.count; i++) expect(facade.getX(i)).toBeCloseTo(-15 - p.getX(i));

  const walls = new MeshBuilder();
  walls.drape = hill;
  walls.quad([-5, 0, -2], [5, 0, -2], [5, 1, -2], [-5, 1, -2], 0, [0, 0, -1]);
  const wall = walls.build();
  const n = wall.getAttribute('normal');
  for (let i = 0; i < n.count; i++) expect([n.getX(i), n.getY(i), n.getZ(i)]).toEqual([0, 0, -1]);
  // Its foot follows the ground, its top a metre over it.
  for (const y of overGround(wall)) expect([0, 1]).toContain(Math.round(y * 1e4) / 1e4);
});

test('draped triangles are cut too', () => {
  const mesh = new MeshBuilder();
  mesh.drape = hill;
  mesh.triangle([-5, 0, -5], [5, 0, -5], [5, 0, 5], 0, UP);
  mesh.triangle([-5, 0, 5], [5, 0, 5], [-5, 0, -5], 0, UP, [0, 0, 0]);
  const g = mesh.build();
  expect(g.index!.count / 3).toBeGreaterThan(2);
  for (const y of overGround(g)) expect(y).toBeCloseTo(0, 5);
});

test('lifted, everything rises by one height, which the lift attribute holds in units', () => {
  const mesh = new MeshBuilder();
  mesh.lift = 3.5;
  mesh.triangle([0, 0, 0], [1, 0, 0], [0, 2, 0], 0, [0, 0, 1], 6);
  expect(mesh.lift).toBe(3.5);
  const g = mesh.build({ facade: true });
  expect(
    Array.from(g.getAttribute('position').array as Float32Array).filter((_, i) => i % 3 === 1),
  ).toEqual([3.5, 3.5, 5.5]);
  expect(g.getAttribute('lift').getX(2)).toBe(3.5 / LIFT_UNIT);
  // Far past what a byte holds, it stops at the byte's end.
  mesh.lift = -1000;
  mesh.triangle([0, 0, 0], [1, 0, 0], [0, 2, 0], 0, [0, 0, 1], 6);
  expect(mesh.build({ facade: true }).getAttribute('lift').getX(3)).toBe(-128);
  // A house at its exact ground counts its storeys from a whole unit under it.
  const house = new MeshBuilder();
  house.lift = 3.7;
  house.foot = 3.5;
  house.triangle([0, 0, 0], [1, 0, 0], [0, 2, 0], 0, [0, 0, 1], 6);
  const h = house.build({ facade: true });
  expect(h.getAttribute('position').getY(0)).toBeCloseTo(3.7, 6);
  expect(h.getAttribute('lift').getX(0)).toBe(3.5 / LIFT_UNIT);
});

test('outlines drape over the terrain, or rise by one height', () => {
  const lines = new LineBuilder();
  lines.drape = hill;
  lines.lift = 5; // ignored while draping
  lines.segment([-8, 0.2, -1], [8, 0.2, -1]);
  const g = lines.build();
  const p = g.getAttribute('position');
  // Cut at x = -1 (the diagonal) and x = 0: three segments, four points.
  expect(p.count).toBe(4);
  expect(g.index!.count).toBe(6);
  for (let i = 0; i < p.count; i++) {
    expect(p.getY(i) - hill.height(p.getX(i), p.getZ(i))).toBeCloseTo(0.2, 5);
  }
  const lifted = new LineBuilder();
  lifted.lift = 2;
  lifted.segment([0, 0, 0], [0, 1, 0]);
  expect(Array.from(lifted.build().getAttribute('position').array)).toEqual([0, 2, 0, 0, 3, 0]);
});
