import { expect, test } from 'bun:test';

import { bridgeHoles } from '../data/landcover.ts';
import { Terrain } from '../data/terrain.ts';
import { SLAB_DEPTH, addGround, addSlabInk, slabBottom } from './ground.ts';
import { LineBuilder, MeshBuilder, unindexed } from './mesh-builder.ts';

const square = new Float32Array([0, 0, 10, 0, 10, 10, 0, 10]);
const layers = {
  roads: [square],
  carriageways: [{ kind: 'street' as const, surface: 'sett' as const, ring: square }],
  markings: [],
  plazas: [square],
  green: [square],
  woods: [square],
  pitches: [{ surface: 'grass' as const, ring: square }],
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
  return unindexed(mesh.build());
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
  addGround(mesh, area, within, { ...layers, paths: [{ width: 2, surface: 'paving', line }] });
  const g = unindexed(mesh.build());
  // The zero-length middle segment is skipped: two quads on top of the slab and layers.
  expect(g.getAttribute('position').count).toBe(((2 + 7) * 2 + 10 * 2 + 2 * 2) * 3);
  const p = g.getAttribute('position');
  const xs = Array.from({ length: p.count }, (_, i) =>
    Math.abs(p.getY(i) - 0.153) < 1e-4 ? p.getX(i) : 5,
  );
  expect(Math.min(...xs)).toBeCloseTo(-1);
  expect(Math.max(...xs)).toBeCloseTo(11);
});

test('the road surface carries texture codes, and coarse paint lands on top', () => {
  const mesh = new MeshBuilder();
  const within = { minX: -100, minZ: -100, maxX: 100, maxZ: 100 };
  const zebra = { kind: 'zebra' as const, line: new Float32Array([2, 0, 2, 6]) };
  addGround(mesh, area, within, { ...layers, markings: [zebra] });
  const g = unindexed(mesh.build({ facade: true }));
  const p = g.getAttribute('position');
  const f = g.getAttribute('facade');
  const at = (y: number) =>
    new Set(
      Array.from({ length: p.count }, (_, i) => i)
        .filter((i) => Math.abs(p.getY(i) - y) < 1e-4)
        .map((i) => f.getX(i)),
    );
  expect([...at(0.15)]).toEqual([-3]); // pavement slabs
  expect([...at(0.156)]).toEqual([-2]); // setts on top
  expect(at(0.16).size).toBe(2); // the zebra's patch, both sides of it
  expect(at(0.17).size).toBe(0); // its bars are fine paint, drawn after the buildings
});

const empty = {
  roads: [],
  carriageways: [],
  plazas: [],
  green: [],
  woods: [],
  pitches: [],
  parking: [],
  water: [],
  bridges: [],
  railLand: [],
};
const everywhere = { minX: -100, minZ: -100, maxX: 200, maxZ: 200 };

test('generic land lies under specific land: railway land, green, woods, pitches, car parks', () => {
  const order = [
    'railLand',
    'green',
    'woods',
    'track',
    'pitch',
    'parking',
    'water',
    'roads',
    'plazas',
  ] as const;
  const heights = order.map((key) => {
    const mesh = new MeshBuilder();
    // A running track (tartan) lies under the pitches mapped on its infield.
    const pitch = (surface: 'tartan' | 'clay') => ({ pitches: [{ surface, ring: square }] });
    const layer =
      key === 'track' ? pitch('tartan') : key === 'pitch' ? pitch('clay') : { [key]: [square] };
    addGround(mesh, [], everywhere, { ...layers, ...empty, pitches: [], ...layer });
    const g = unindexed(mesh.build());
    if (key === 'pitch') expect(g.getAttribute('color').getX(0)).not.toBe(0);
    return g.getAttribute('position').getY(0);
  });
  expect(heights).toEqual(heights.toSorted((a, b) => a - b));
  expect(new Set(heights).size).toBe(order.length);
});

const sq = (x: number, z: number, s: number) => [x, z, x + s, z, x + s, z + s, x, z + s];
const cw = (r: number[]) => r.flatMap((_, i) => (i % 2 ? [] : [r.at(-i - 2)!, r.at(-i - 1)!]));

test('a ring with its holes bridged in triangulates as the polygon with holes', () => {
  const holes = [cw(sq(10, 10, 20)), cw(sq(60, 60, 10)), cw(sq(60, 10, 20))];
  const ring = new Float32Array(bridgeHoles(sq(0, 0, 100), holes));
  const mesh = new MeshBuilder();
  addGround(mesh, [], everywhere, { ...layers, ...empty, green: [ring] });
  const p = unindexed(mesh.build()).getAttribute('position');
  let covered = 0;
  for (let i = 0; i < p.count; i += 3) {
    const [ax, az, bx, bz, cx, cz] = [0, 1, 2].flatMap((k) => [p.getX(i + k), p.getZ(i + k)]);
    covered += Math.abs((bx! - ax!) * (cz! - az!) - (cx! - ax!) * (bz! - az!)) / 2;
  }
  expect(covered).toBeCloseTo(10000 - 400 - 100 - 400, 3);
});

test('the slab gets an ink lip along its top and bottom edges and down its corners', () => {
  const lines = new LineBuilder();
  addSlabInk(lines, area, { minX: -100, minZ: -100, maxX: 100, maxZ: 100 });
  // 7 outline edges, a top and a bottom line each, and one vertical down each of the L's 6
  // corners (not where the west side runs on from one rectangle into the next).
  expect(unindexed(lines.build()).getAttribute('position').count / 2).toBe(7 * 2 + 6);
});

const slope = new Terrain({
  step: 10,
  minX: -60,
  minZ: -60,
  cols: 13,
  rows: 17,
  // Rising 0.1 m a metre to the east.
  heights: Float32Array.from({ length: 13 * 17 }, (_, k) => (k % 13) - 6),
});

test('on the terrain, layers drape over it and the sides hang to a flat underside', () => {
  const mesh = new MeshBuilder();
  mesh.drape = slope;
  addGround(mesh, area, { minX: -100, minZ: -100, maxX: 100, maxZ: 100 }, layers);
  const p = mesh.build().getAttribute('position');
  const bottom = slabBottom(slope);
  expect(bottom).toBe(-6 - SLAB_DEPTH);
  for (let i = 0; i < p.count; i++) {
    const over = p.getY(i) - slope.height(p.getX(i), p.getZ(i));
    // On the ground, a layer's few centimetres over it, or the underside.
    if (Math.abs(p.getY(i) - bottom) > 1e-4) expect(over).toBeGreaterThan(-1e-4);
    if (Math.abs(p.getY(i) - bottom) > 1e-4) expect(over).toBeLessThan(0.2 + 1e-4);
  }
  expect(mesh.drape).toBe(slope);
  expect(slabBottom(null)).toBe(-SLAB_DEPTH);
});

test('on the terrain, the slab ink lies on it, its bottom line flat', () => {
  const lines = new LineBuilder();
  lines.drape = slope;
  addSlabInk(lines, area, { minX: -100, minZ: -100, maxX: 100, maxZ: 100 });
  const p = lines.build().getAttribute('position');
  const ys = Array.from(
    { length: p.count },
    (_, i) => p.getY(i) - slope.height(p.getX(i), p.getZ(i)),
  );
  const lip = ys.filter((y) => Math.abs(y - 0.2) < 1e-4).length;
  const flat = Array.from({ length: p.count }, (_, i) => p.getY(i)).filter(
    (y) => y === slabBottom(slope),
  );
  expect(lip + flat.length).toBe(p.count);
  // The north and south edges cross the terrain's lines: more points along the lip.
  expect(lip).toBeGreaterThan(flat.length);
  expect(lines.drape).toBe(slope);
});
