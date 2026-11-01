import { expect, test } from 'bun:test';

import { SLAB_DEPTH, addGround, addSlabInk } from './ground.ts';
import { LineBuilder, MeshBuilder } from './mesh-builder.ts';

const square = new Float32Array([0, 0, 10, 0, 10, 10, 0, 10]);
const layers = {
  roads: [square],
  carriageways: [{ kind: 'sett' as const, ring: square }],
  markings: [],
  plazas: [square],
  green: [square],
  woods: [square],
  pitches: [square],
  parking: [square],
  water: [square],
  bridges: [square],
  railLand: [square],
  paths: [],
};
// An L: a 100 m square with a 50 m square below its left half.
const area = [
  { minX: -50, minZ: -50, maxX: 50, maxZ: 50 },
  { minX: -50, minZ: 50, maxX: 0, maxZ: 100 },
];

const count = (within: (typeof area)[number]) => {
  const mesh = new MeshBuilder();
  addGround(mesh, area, within, layers);
  return mesh.build();
};

test('a cell holding the whole area: slab tops, the outline as earth sides, then the layers', () => {
  const g = count({ minX: -100, minZ: -100, maxX: 100, maxZ: 100 });
  // 2 tops, 7 outline sides (the shared stretch has none), 2 triangles each; 2 per layer.
  expect(g.getAttribute('position').count).toBe(((2 + 7) * 2 + 10 * 2) * 3);
  g.computeBoundingBox();
  expect(g.boundingBox!.min.y).toBe(-SLAB_DEPTH);
  expect(g.boundingBox!.max.y).toBeCloseTo(0.2);
  const normals = g.getAttribute('normal');
  for (let i = 0; i < 2 * 2 * 3; i++) expect(normals.getY(i)).toBe(1);
});

test('a cell only gets the slab and sides that run through it', () => {
  const g = count({ minX: -50, minZ: -50, maxX: 0, maxZ: 0 });
  // One top, the west and north sides; the layers are the caller's to clip.
  expect(g.getAttribute('position').count).toBe(((1 + 2) * 2 + 10 * 2) * 3);
});

test('paths are ribbons of their width, running on past their ends', () => {
  const line = new Float32Array([0, 0, 10, 0, 10, 0, 10, 6]);
  const mesh = new MeshBuilder();
  const within = { minX: -100, minZ: -100, maxX: 100, maxZ: 100 };
  addGround(mesh, area, within, { ...layers, paths: [{ width: 2, paved: true, line }] });
  const g = mesh.build();
  // The zero-length middle segment is skipped: two quads on top of the slab and layers.
  expect(g.getAttribute('position').count).toBe(((2 + 7) * 2 + 10 * 2 + 2 * 2) * 3);
  const p = g.getAttribute('position');
  const xs = Array.from({ length: p.count }, (_, i) =>
    Math.abs(p.getY(i) - 0.12) < 1e-4 ? p.getX(i) : 5,
  );
  expect(Math.min(...xs)).toBeCloseTo(-1);
  expect(Math.max(...xs)).toBeCloseTo(11);
});

test('the road surface carries texture codes, and coarse paint lands on top', () => {
  const mesh = new MeshBuilder();
  const within = { minX: -100, minZ: -100, maxX: 100, maxZ: 100 };
  const zebra = { kind: 'zebra' as const, line: new Float32Array([2, 0, 2, 6]) };
  addGround(mesh, area, within, { ...layers, markings: [zebra] });
  const g = mesh.build({ facade: true });
  const p = g.getAttribute('position');
  const f = g.getAttribute('facade');
  const at = (y: number) =>
    new Set(
      Array.from({ length: p.count }, (_, i) => i)
        .filter((i) => Math.abs(p.getY(i) - y) < 1e-4)
        .map((i) => f.getX(i)),
    );
  expect([...at(0.15)]).toEqual([-3]); // pavement slabs
  expect([...at(0.155)]).toEqual([-2]); // setts on top
  expect(at(0.16).size).toBe(2); // the zebra's patch, both sides of it
  expect(at(0.17).size).toBe(0); // its bars are fine paint, drawn after the buildings
});

test('the slab gets an ink lip along its top and bottom edges and down its corners', () => {
  const lines = new LineBuilder();
  addSlabInk(lines, area, { minX: -100, minZ: -100, maxX: 100, maxZ: 100 });
  // 7 outline edges, a top and a bottom line each, and one vertical down each of the L's 6
  // corners (not where the west side runs on from one rectangle into the next).
  expect(lines.build().getAttribute('position').count / 2).toBe(7 * 2 + 6);
});
