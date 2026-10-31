import { expect, test } from 'bun:test';

import type { Building, City } from '../data/city.ts';
import { partyWalls } from './buildings.ts';
import { CELL_SIZE, buildCell, partition } from './cells.ts';

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
  // An electrified track across both cells, and a platform beside it across the seam.
  rails: [
    {
      kind: 'main',
      bridge: false,
      electrified: true,
      line: new Float32Array([S - 100, 150, S + 100, 150]),
    },
  ],
  platforms: [box(S - 90, 154, 120, 6)],
  trees: new Float32Array([20, 300, S + 20, 300]),
  treeHeights: new Float32Array([9, 0]),
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
  // Ground across the seam is cut in two; ground inside one cell is passed through.
  expect(west.ground.roads).toHaveLength(1);
  expect(east.ground.roads).toHaveLength(1);
  expect(Math.max(...east.ground.roads[0]!.filter((_, i) => i % 2 === 0))).toBe(S + 50);
  expect(west.ground.green[0]).toEqual(city.green[0]!);
  // Tracks are cut like paths; masts and platforms go where they stand.
  expect(Array.from(west.rails[0]!.line)).toEqual([S - 100, 150, S, 150]);
  expect(east.rails[0]!).toMatchObject({ kind: 'main', electrified: true });
  expect(west.masts.length + east.masts.length).toBe(3);
  expect(west.platforms).toHaveLength(1);
  expect(Math.min(...east.platforms[0]!.filter((_, i) => i % 2 === 0))).toBe(S);
});

test('a cell builds into one mesh and one set of outlines', () => {
  const [west] = partition(city);
  const { mesh, lines, detail } = buildCell(west!, city.area, partyWalls(city.buildings));
  // The rails of the track's one segment in this cell, then its masts, lead the outlines.
  expect(detail.rails).toBe(2);
  expect(detail.masts - detail.rails).toBe(2 * west!.masts.length);
  const g = mesh.build({ facade: true });
  g.computeBoundingBox();
  expect(g.boundingBox!.min.y).toBeLessThan(0); // the slab
  expect(g.boundingBox!.max.y).toBeGreaterThanOrEqual(10); // the houses
  expect(lines.build().getAttribute('position').count).toBeGreaterThan(0);
});
