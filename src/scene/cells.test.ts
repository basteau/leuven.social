import { expect, test } from 'bun:test';

import type { Building, City } from '../data/city.ts';
import { partyWalls } from './buildings.ts';
import { CELL_SIZE, buildCell, partition } from './cells.ts';
import type { MeshBuilder } from './mesh-builder.ts';

const S = CELL_SIZE;
const box = (x: number, z: number, w: number, d: number) =>
  new Float32Array([x, z, x + w, z, x + w, z + d, x, z + d]);
const house = (id: number, ring: Float32Array): Building => ({
  id,
  tier: 'core',
  kind: 'house',
  roof: 'flat',
  height: 10,
  eave: 10,
  roofColor: null,
  ring,
  holes: [],
});

// Two cells side by side: [0, S) and [S, 2S) along x, one row deep.
const city: City = {
  area: [{ minX: 0, minZ: 0, maxX: 2 * S, maxZ: S }],
  bounds: { minX: 0, minZ: 0, maxX: 2 * S, maxZ: S },
  labels: [],
  // The second house starts in the first cell and overhangs into the second.
  buildings: [house(1, box(10, 10, 8, 8)), house(2, box(S - 4, 10, 8, 8))],
  roads: [box(S - 50, 100, 100, 10)],
  plazas: [],
  green: [box(10, 200, 20, 20)],
  water: [],
  // A path from one cell into the other.
  paths: [{ width: 2, paved: true, line: new Float32Array([S - 20, 50, S + 20, 50]) }],
  trees: new Float32Array([20, 300, S + 20, 300]),
  treeHeights: new Float32Array([9, 0]),
  // A bench in each cell, and the Totem in the second.
  props: [
    { kind: 'bench', x: 30, z: 30, angle: 0, size: 0 },
    { kind: 'bench', x: S + 30, z: 30, angle: 0, size: 0 },
    { kind: 'needle', x: S + 60, z: 60, angle: 0, size: 23 },
  ],
};

test('the area is cut into cells, and each thing goes to one', () => {
  const cells = partition(city, [{ x: S + 5, z: 5, ux: 1, uz: 0, color: 0xffffff }]);
  expect(cells.map((c) => c.bounds.minX)).toEqual([0, S]);
  const [west, east] = cells as [(typeof cells)[0], (typeof cells)[0]];
  // Whole buildings, by their first corner.
  expect(west.buildings.map((b) => b.id)).toEqual([1, 2]);
  expect(east.buildings).toEqual([]);
  // Trees keep their index as a seed, so they look the same whatever cell they land in.
  expect(west.trees).toEqual([20, 300, 0, 9]);
  expect(east.trees).toEqual([S + 20, 300, 1, 0]);
  // Paths are cut at the seam too.
  expect(Array.from(west.ground.paths[0]!.line)).toEqual([S - 20, 50, S, 50]);
  expect(Array.from(east.ground.paths[0]!.line)).toEqual([S, 50, S + 20, 50]);
  expect(east.parasols).toHaveLength(1);
  expect(west.props.map((p) => p.kind)).toEqual(['bench']);
  expect(east.props.map((p) => p.kind)).toEqual(['bench', 'needle']);
  // Ground across the seam is cut in two; ground inside one cell is passed through.
  expect(west.ground.roads).toHaveLength(1);
  expect(east.ground.roads).toHaveLength(1);
  expect(Math.max(...east.ground.roads[0]!.filter((_, i) => i % 2 === 0))).toBe(S + 50);
  expect(west.ground.green[0]).toEqual(city.green[0]!);
});

test('a cell builds into one mesh and one set of outlines', () => {
  const [west] = partition(city);
  const { mesh, lines } = buildCell(west!, city.area, partyWalls(city.buildings));
  const g = mesh.build({ facade: true });
  g.computeBoundingBox();
  expect(g.boundingBox!.min.y).toBeLessThan(0); // the slab
  expect(g.boundingBox!.max.y).toBeGreaterThanOrEqual(10); // the houses
  expect(lines.build().getAttribute('position').count).toBeGreaterThan(0);
});

const height = (m: MeshBuilder) => {
  const g = m.build();
  g.computeBoundingBox();
  return g.boundingBox!.max.y;
};

test('small props get a mesh of their own, tall ones join the cell', () => {
  const [west, east] = partition(city);
  const walls = partyWalls(city.buildings);
  const w = buildCell(west!, city.area, walls);
  const e = buildCell(east!, city.area, walls);
  expect(height(w.props)).toBeLessThan(2); // a bench
  expect(height(e.props)).toBeLessThan(2); // only the bench: the needle is in the main mesh
  expect(height(e.mesh)).toBeGreaterThan(20);
});
