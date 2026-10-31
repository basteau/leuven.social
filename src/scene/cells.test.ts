import { expect, test } from 'bun:test';

import type { Building, City } from '../data/city.ts';
import { partyWalls } from './buildings.ts';
import { CELL_SIZE, along, buildCell, partition } from './cells.ts';

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
  carriageways: [{ kind: 'street', ring: box(S - 50, 100, 100, 10) }],
  markings: [
    // Lane lines across the seam, and a crossing that straddles it.
    { kind: 'dashed', line: new Float32Array([S - 30, 105, S + 30, 105]) },
    { kind: 'solid', line: new Float32Array([S - 30, 108, S + 30, 108]) },
    { kind: 'zebra', line: new Float32Array([S - 1, 100, S + 1, 110]) },
  ],
  plazas: [],
  green: [box(10, 200, 20, 20)],
  water: [],
  // A path from one cell into the other.
  paths: [{ width: 2, paved: true, line: new Float32Array([S - 20, 50, S + 20, 50]) }],
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
  expect(east.ground.carriageways.map((r) => r.kind)).toEqual(['street']);
  // Lane lines are cut at the seam, each piece knowing where along the line it starts; a
  // crossing stays whole where it starts.
  expect(west.ground.markings.map((m) => [m.kind, Array.from(m.line), m.from])).toEqual([
    ['dashed', [S - 30, 105, S, 105], 0],
    ['solid', [S - 30, 108, S, 108], 0],
    ['zebra', [S - 1, 100, S + 1, 110], undefined],
  ]);
  expect(east.ground.markings.map((m) => [m.kind, Array.from(m.line), m.from])).toEqual([
    ['dashed', [S, 105, S + 30, 105], 30],
    ['solid', [S, 108, S + 30, 108], 30],
  ]);
  expect(west.ground.green[0]).toEqual(city.green[0]!);
});

test('a cell builds into one mesh and one set of outlines', () => {
  const [west] = partition(city);
  const { mesh, lines, groundVertices, fineVertices } = buildCell(
    west!,
    city.area,
    partyWalls(city.buildings),
  );
  const g = mesh.build({ facade: true });
  const p = g.getAttribute('position');
  // Fine paint comes last: the lane line's dash and the zebra's bars, just over the road.
  expect(fineVertices).toBeLessThan(p.count);
  for (let i = fineVertices; i < p.count; i++) expect(p.getY(i)).toBeCloseTo(0.17);
  // The ground comes first: everything after it stands above the squares.
  expect(groundVertices).toBeGreaterThan(0);
  for (let i = 0; i < groundVertices; i++) expect(p.getY(i)).toBeLessThanOrEqual(0.2);
  expect(
    Math.max(
      ...Array.from({ length: p.count - groundVertices }, (_, i) => p.getY(groundVertices + i)),
    ),
  ).toBeGreaterThan(5);
  g.computeBoundingBox();
  expect(g.boundingBox!.min.y).toBeLessThan(0); // the slab
  expect(g.boundingBox!.max.y).toBeGreaterThanOrEqual(10); // the houses
  expect(lines.build().getAttribute('position').count).toBeGreaterThan(0);
});

test('along: how far a point on a line lies from its start', () => {
  const line = [0, 0, 10, 0, 10, 10];
  expect(along(line, 0, 0)).toBe(0);
  expect(along(line, 4, 0)).toBe(4);
  expect(along(line, 10, 6)).toBe(16);
  expect(along([0, 0, 0, 0, 5, 0], 3, 0)).toBe(3);
});
