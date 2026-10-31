import { expect, test } from 'bun:test';

import { SLAB_DEPTH, addGround } from './ground.ts';
import { MeshBuilder } from './mesh-builder.ts';

const square = new Float32Array([0, 0, 10, 0, 10, 10, 0, 10]);
const layers = { roads: [square], plazas: [square], green: [square], water: [square], paths: [] };
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
  expect(g.getAttribute('position').count).toBe(((2 + 7) * 2 + 4 * 2) * 3);
  g.computeBoundingBox();
  expect(g.boundingBox!.min.y).toBe(-SLAB_DEPTH);
  expect(g.boundingBox!.max.y).toBeCloseTo(0.2);
  const normals = g.getAttribute('normal');
  for (let i = 0; i < 2 * 2 * 3; i++) expect(normals.getY(i)).toBe(1);
});

test('a cell only gets the slab and sides that run through it', () => {
  const g = count({ minX: -50, minZ: -50, maxX: 0, maxZ: 0 });
  // One top, the west and north sides; the layers are the caller's to clip.
  expect(g.getAttribute('position').count).toBe(((1 + 2) * 2 + 4 * 2) * 3);
});

test('paths are ribbons of their width, running on past their ends', () => {
  const line = new Float32Array([0, 0, 10, 0, 10, 0, 10, 6]);
  const mesh = new MeshBuilder();
  const within = { minX: -100, minZ: -100, maxX: 100, maxZ: 100 };
  addGround(mesh, area, within, { ...layers, paths: [{ width: 2, paved: true, line }] });
  const g = mesh.build();
  // The zero-length middle segment is skipped: two quads on top of the slab and layers.
  expect(g.getAttribute('position').count).toBe(((2 + 7) * 2 + 4 * 2 + 2 * 2) * 3);
  const p = g.getAttribute('position');
  const xs = Array.from({ length: p.count }, (_, i) =>
    Math.abs(p.getY(i) - 0.12) < 1e-4 ? p.getX(i) : 5,
  );
  expect(Math.min(...xs)).toBeCloseTo(-1);
  expect(Math.max(...xs)).toBeCloseTo(11);
});
