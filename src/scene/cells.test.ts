import { expect, test } from 'bun:test';

import type { Building, City } from '../data/city.ts';
import { partyWalls } from './buildings.ts';
import { CELL_SIZE, along, buildCell, groundRange, partition } from './cells.ts';
import { drawnGround } from './drawn-ground.ts';
import { buildFurniture, propBase } from './furniture.ts';
import { LAYER_Y, slabBottom } from './ground.ts';
import { MeshBuilder, unindexed } from './mesh-builder.ts';
import { LANDMARK_MODELS } from './landmark-models.ts';
import { PARKED } from './props.ts';
import { FLAT, FLAT_GRID, Terrain } from '../data/terrain.ts';

const S = CELL_SIZE;
const kit = {
  MeshBuilder,
  awning: 3000,
  terrain: FLAT,
  footing: () => 0,
  wallTop: (b: Building) => b.eave,
  ground: () => 0,
  layers: LAYER_Y,
};
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
  // The second house starts in the first cell and overhangs into the second.
  buildings: [house(1, box(10, 10, 8, 8)), house(2, box(S - 4, 10, 8, 8))],
  roads: [box(S - 50, 100, 100, 10)],
  carriageways: [{ kind: 'street', surface: 'asphalt', ring: box(S - 50, 100, 100, 10) }],
  markings: [
    // Lane lines across the seam, and a crossing that straddles it.
    { kind: 'dashed', line: new Float32Array([S - 30, 105, S + 30, 105]) },
    { kind: 'solid', line: new Float32Array([S - 30, 108, S + 30, 108]) },
    { kind: 'zebra', line: new Float32Array([S - 1, 100, S + 1, 110]) },
  ],
  plazas: [],
  green: [box(10, 200, 20, 20)],
  water: [],
  woods: [],
  // A tennis park across the seam, its courts' lines whole in the cell of their centre.
  pitches: [box(S - 10, 230, 40, 36)],
  pitchSurfaces: ['clay'],
  fields: [{ sport: 'tennis', x: S + 10, z: 248, angle: 0, length: 36, width: 40, count: 2 }],
  parking: [],
  // A path from one cell into the other.
  paths: [{ width: 2, surface: 'paving', line: new Float32Array([S - 20, 50, S + 20, 50]) }],
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
  railLand: [box(S - 100, 140, 200, 30)],
  // A two-bay platform roof straddling the seam: each bay goes to the cell of its centre.
  canopies: [box(S - 51, 150, 102, 12)],
  trees: new Float32Array([20, 300, S + 20, 300]),
  treeHeights: new Float32Array([9, 0]),
  // A bench in each cell, and the Totem in the second.
  props: [
    { kind: 'bench', x: 30, z: 30, angle: 0, size: 0 },
    { kind: 'bench', x: S + 30, z: 30, angle: 0, size: 0 },
    { kind: 'needle', x: S + 60, z: 60, angle: 0, size: 23 },
  ],
  tanks: [{ height: 15, ring: box(S + 100, 100, 6, 6) }],
  bridges: [],
  parapets: [new Float32Array([40, 120, 40, 130])],
  streetNames: [],
  streets: [],
  plazaNames: [],
  terrain: FLAT_GRID,
  fronts: [],
  ways: [],
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
  expect(east.tanks).toHaveLength(1);
  expect(west.parapets).toHaveLength(1);
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
  // Tracks are cut like paths; masts and platforms go where they stand.
  expect(Array.from(west.rails[0]!.line)).toEqual([S - 100, 150, S, 150]);
  expect(east.rails[0]!).toMatchObject({ kind: 'main', electrified: true });
  expect(west.masts.length + east.masts.length).toBe(3);
  expect(west.platforms).toHaveLength(1);
  expect(Math.min(...east.platforms[0]!.filter((_, i) => i % 2 === 0))).toBe(S);
  expect([west.ground.railLand.length, east.ground.railLand.length]).toEqual([1, 1]);
  expect([west.canopies.length, east.canopies.length]).toEqual([1, 1]);
  // Pitches are cut like the ground, keeping their surface; a field's lines stay whole.
  expect([...west.ground.pitches, ...east.ground.pitches].map((p) => p.surface)).toEqual([
    'clay',
    'clay',
  ]);
  expect([west.ground.fields.length, east.ground.fields.length]).toEqual([0, 1]);
});

test("a field's lines are fine paint, on the pitch", () => {
  const [, east] = partition(city);
  const { mesh, fineVertices } = buildCell(east!, city.area, partyWalls(city.buildings));
  const p = unindexed(mesh.build()).getAttribute('position');
  const ys = Array.from({ length: p.count - fineVertices }, (_, i) => p.getY(fineVertices + i));
  // Two courts of ten lines past the road's paint.
  expect(ys.filter((y) => Math.abs(y - 0.07) < 1e-6)).toHaveLength(2 * 10 * 6);
});

test('a cell builds into one mesh and one set of outlines', () => {
  const [west] = partition(city);
  const { mesh, lines, fineVertices, detail } = buildCell(
    west!,
    city.area,
    partyWalls(city.buildings),
  );
  // The rails of the track's one segment in this cell, then its masts, lead the outlines.
  expect(detail.rails).toBe(2);
  expect(detail.masts - detail.rails).toBe(2 * west!.masts.length);
  const g = unindexed(mesh.build({ facade: true }));
  const p = g.getAttribute('position');
  // Fine paint comes last: the lane line's dash and the zebra's bars, just over the road.
  expect(fineVertices).toBeLessThan(p.count);
  for (let i = fineVertices; i < p.count; i++) expect(p.getY(i)).toBeCloseTo(0.17);
  g.computeBoundingBox();
  expect(g.boundingBox!.min.y).toBeLessThan(0); // the slab
  expect(g.boundingBox!.max.y).toBeGreaterThanOrEqual(10); // the houses
  expect(unindexed(lines.build()).getAttribute('position').count).toBeGreaterThan(0);
});

test('the ground and the trunks come first, so the shadow pass can start after them', () => {
  const [west] = partition(city);
  const { mesh, trunksFrom, shadowFrom, fineVertices } = buildCell(
    west!,
    city.area,
    partyWalls(city.buildings),
  );
  const position = unindexed(mesh.build()).getAttribute('position');
  // Everything before the mark lies on or under the ground, or is a trunk (3 m at most).
  let low = -Infinity;
  for (let i = 0; i < shadowFrom; i++) low = Math.max(low, position.getY(i));
  expect(low).toBeLessThan(5);
  // Everything after it, up to the fine road paint, stands up: the houses and the crowns.
  let high = Infinity;
  for (let i = shadowFrom; i < fineVertices; i += 3) {
    high = Math.min(high, Math.max(position.getY(i), position.getY(i + 1), position.getY(i + 2)));
  }
  expect(high).toBeGreaterThan(0.5);
  expect(shadowFrom).toBeGreaterThan(0);
  // The trunks sit between the ground and the rest: 8 triangles a tree.
  expect(shadowFrom - trunksFrom).toBe((west!.trees.length / 4) * 8 * 3);
});

const height = (m: MeshBuilder) => {
  const g = unindexed(m.build());
  g.computeBoundingBox();
  return g.boundingBox!.max.y;
};

test('props are built apart from the cell: small ones up close, tall ones at every zoom', () => {
  const [west, east] = partition(city);
  const walls = partyWalls(city.buildings);
  const e = buildCell(east!, city.area, walls);
  expect(height(buildFurniture(west!, kit).near)).toBeLessThan(2); // a bench
  expect(buildFurniture(west!, kit).tall).toBeNull();
  const { near, tall } = buildFurniture(east!, kit);
  expect(height(near)).toBeLessThan(2); // only the bench
  expect(height(tall!)).toBeGreaterThan(20); // the needle
  expect(height(e.mesh)).toBeLessThan(20);
});

test("the lamps' glow is built with the furniture, only where a cell has a lamp", () => {
  const [west] = partition(city);
  expect(buildFurniture(west!, kit).glow).toBeNull();
  const lamp = {
    kind: 'lamp',
    x: west!.bounds.minX + 20,
    z: west!.bounds.minZ + 20,
    angle: 0,
    size: 0,
  } as const;
  const lit = buildFurniture({ ...west!, props: [...west!.props, lamp] }, kit);
  expect(lit.glow).not.toBeNull();
  expect(height(lit.glow!)).toBeGreaterThan(4);
});

test('each parked bike stands on the ground drawn under its wheels: a slope, a pavement, a square', () => {
  const [west] = partition(city);
  const rack = { kind: 'bikes' as const, x: 30, z: 40, angle: 0.3, size: 12, fill: 0.5 };
  // Rising 7 m over 100 m to the east; the first rack half on a pavement, half on a square
  // whose edge runs between its bikes' middles and front wheels, the second on bare ground.
  const slope = new Terrain({ ...FLAT_GRID, step: 100, heights: Float32Array.of(0, 7, 0, 7) });
  const cell = {
    ...west!,
    props: [...west!.props, rack, { ...rack, x: 60, fill: 0.25 }],
    ground: {
      ...west!.ground,
      roads: [box(20, 30, 20, 20)],
      plazas: [Float32Array.of(30.6, 30, 40, 30, 40, 50, 30.6, 50)],
    },
  };
  const drawn = drawnGround(slope, cell, LAYER_Y);
  expect(drawn.layer(25, 40)).toBe(LAYER_Y.roads);
  expect(drawn.layer(35, 40)).toBe(LAYER_Y.plazas);
  expect(drawn.layer(60, 40)).toBe(0);
  const { near: mesh, bikes } = buildFurniture(cell, { ...kit, terrain: slope });
  expect(bikes).toHaveLength((6 + 3) * PARKED.stride);
  const g = mesh.build();
  const [index, position] = [g.index!, g.getAttribute('position')];
  let [onSquare, onPavement] = [0, 0];
  for (let i = 0; i < bikes.length; i += PARKED.stride) {
    const [from, to] = [bikes[i + PARKED.from]!, bikes[i + PARKED.to]!];
    expect((to - from) / 3).toBeGreaterThanOrEqual(41);
    expect(to).toBeLessThanOrEqual(index.count);
    const [x, z, heading] = [
      bikes[i + PARKED.x]!,
      bikes[i + PARKED.z]!,
      bikes[i + PARKED.heading]!,
    ];
    // In each half of the bike, rear and front, the point near its middle plane nearest the drawn
    // ground is on it: a tyre. Off that plane, the kickstand's foot may dip a few millimetres
    // into a slope across it, as the bike stands level across.
    const [lowest, nearest] = [
      [Infinity, Infinity],
      [Infinity, Infinity],
    ];
    const at: [number, number][] = [
      [0, 0],
      [0, 0],
    ];
    const [cos, sin] = [Math.cos(heading), Math.sin(heading)];
    for (let k = from; k < to; k++) {
      const v = index.getX(k);
      const [px, py, pz] = [position.getX(v), position.getY(v), position.getZ(v)];
      const half = (px - x) * cos + (pz - z) * sin > 0 ? 1 : 0;
      const over = py - drawn.height(px, pz);
      expect(over).toBeGreaterThan(-0.01);
      if (Math.abs((pz - z) * cos - (px - x) * sin) > 0.1) continue;
      if (over < nearest[half]!) [nearest[half], lowest[half], at[half]] = [over, py, [px, pz]];
    }
    for (const half of [0, 1]) {
      expect(nearest[half]).toBeCloseTo(0, 3);
      const [px, pz] = at[half]!;
      if (drawn.layer(px, pz) === LAYER_Y.plazas) onSquare++;
      if (drawn.layer(px, pz) === LAYER_Y.roads) onPavement++;
    }
    // Its note is where its middle stands, between its wheels.
    const y = bikes[i + PARKED.y]!;
    expect(y).toBeGreaterThanOrEqual(Math.min(...lowest) - 1e-3);
    expect(y).toBeLessThanOrEqual(Math.max(...lowest) + 1e-3);
  }
  expect(onSquare).toBeGreaterThan(0);
  expect(onPavement).toBeGreaterThan(0);
});

test('the drawn ground is the highest layer at a point: a path, a pitch, a cell’s edge', () => {
  const [west] = partition(city);
  const drawn = drawnGround(FLAT, west!, LAYER_Y);
  expect(drawn.layer(S - 10, 50)).toBe(LAYER_Y.paths);
  // A path runs on by half its width past its end, as drawn; the cell's edge is looked up inside.
  expect(drawn.layer(S - 20.9, 50)).toBe(LAYER_Y.paths);
  expect(drawn.layer(S - 21.1, 50)).toBe(0);
  expect(drawn.layer(S + 5, 50)).toBe(LAYER_Y.paths);
  expect(drawn.layer(S - 5, 240)).toBe(LAYER_Y.pitch);
  expect(drawn.layer(S - 10, 105)).toBe(LAYER_Y.carriageways);
  expect(drawn.layer(20, 210)).toBe(LAYER_Y.green);
  expect(drawn.height(20, 210)).toBeCloseTo(LAYER_Y.green);
});

test('along: how far a point on a line lies from its start', () => {
  const line = [0, 0, 10, 0, 10, 10];
  expect(along(line, 0, 0)).toBe(0);
  expect(along(line, 4, 0)).toBe(4);
  expect(along(line, 10, 6)).toBe(16);
  expect(along([0, 0, 0, 0, 5, 0], 3, 0)).toBe(3);
});

test('on the terrain, the ground drapes, houses stand at their ground, props on the ground', () => {
  // Rising a metre every 10 m to the east, across both cells.
  const slope = new Terrain({
    step: 50,
    minX: 0,
    minZ: 0,
    cols: (2 * S) / 50 + 1,
    rows: S / 50 + 1,
    heights: Float32Array.from(
      { length: ((2 * S) / 50 + 1) * (S / 50 + 1) },
      (_, k) => (k % ((2 * S) / 50 + 1)) * 5,
    ),
  });
  const [west, east] = partition(city, [{ x: S + 5, z: 5, ux: 1, uz: 0, color: 0xffffff }]);
  const walls = partyWalls(city.buildings, (b) => slope.base(b.ring));
  const { mesh, trunksFrom } = buildCell(west!, city.area, walls, slope);
  // A parasol and a tank stand over the ground east, high up the slope.
  const e = buildCell(east!, city.area, walls, slope).mesh.build();
  e.computeBoundingBox();
  expect(e.boundingBox!.max.y).toBeGreaterThan(slope.height(S + 100, 100) + 15 - 1e-3);
  const p = unindexed(mesh.build()).getAttribute('position');
  // The ground, up to the trunks, lies on the slope (or hangs down to the slab's underside).
  let lowest = Infinity;
  for (let i = 0; i < trunksFrom; i++) {
    const over = p.getY(i) - slope.height(p.getX(i), p.getZ(i));
    lowest = Math.min(lowest, p.getY(i));
    // Track beds are the highest, a little over the squares.
    if (p.getY(i) > slabBottom(slope) + 1e-3) expect(Math.abs(over - 0.15)).toBeLessThan(0.16);
  }
  expect(lowest).toBeCloseTo(slabBottom(slope));
  // The first house, x 10 to 18, stands at 1 m, its 10 m roof at 11.
  const first = Array.from({ length: p.count }, (_, i) => i).filter(
    (i) => p.getX(i) >= 10 && p.getX(i) <= 18 && p.getZ(i) >= 10 && p.getZ(i) <= 18,
  );
  expect(Math.max(...first.map((i) => p.getY(i)))).toBeCloseTo(11);
  const props = buildFurniture(east!, { ...kit, terrain: slope }).near.build();
  props.computeBoundingBox();
  expect(props.boundingBox!.min.y).toBeGreaterThan(slope.height(S, 0) - 1);
});

test('a cell guesses its height from its own ground, down to the slab at the edge', () => {
  const slope = new Terrain({
    step: S,
    minX: 0,
    minZ: 0,
    cols: 3,
    rows: 2,
    heights: Float32Array.of(0, 10, 20, 0, 10, 20),
  });
  const wide = [{ minX: -S, minZ: -S, maxX: 3 * S, maxZ: 2 * S }];
  const [west, east] = partition(city);
  expect(groundRange(west!, wide, slope, 0)).toEqual([0, 10]);
  expect(groundRange(east!, wide, slope, 10)).toEqual([0, 20]);
  // The area's edge runs through: the slab hangs to its flat underside.
  expect(groundRange(west!, city.area, slope, 0)).toEqual([slabBottom(slope), 10]);
});

test('a prop stands on the lowest ground under its footprint', () => {
  // Rising 0.1 m a metre to the east.
  const slope = new Terrain({
    step: 100,
    minX: -100,
    minZ: -100,
    cols: 3,
    rows: 3,
    heights: Float32Array.of(-10, 0, 10, -10, 0, 10, -10, 0, 10),
  });
  const plinth = { kind: 'statue' as const, x: 20, z: 0, angle: 0, size: 4, width: 4, depth: 2 };
  const base = propBase(slope, plinth);
  // A little under the ground at its middle: its west edge is lower.
  expect(base).toBeLessThan(slope.height(20, 0));
  expect(base).toBeGreaterThan(slope.height(20, 0) - 0.5);
  expect(propBase(FLAT, plinth)).toBe(0);
});

test('a hero landmark’s range in its cell is noted, so a room can draw it as nothing', () => {
  const [id] = [...LANDMARK_MODELS.keys()];
  const town: City = {
    ...city,
    buildings: [{ ...house(id!, box(30, 30, 20, 20)), tier: 'hero' }, house(3, box(10, 10, 8, 8))],
  };
  const [cell] = partition(town);
  const built = buildCell(cell!, town.area, partyWalls(town.buildings));
  const range = built.landmarks.get(id!)!;
  expect(built.landmarks.size).toBe(1);
  expect(range.to).toBeGreaterThan(range.from);
  expect(range.lineTo).toBeGreaterThan(range.lineFrom);
  expect(range.from).toBeGreaterThanOrEqual(built.shadowFrom);
  expect(range.to).toBeLessThanOrEqual(built.fineVertices);
});
