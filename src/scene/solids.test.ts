import { expect, test } from 'bun:test';

import type { City, Prop } from '../data/city.ts';
import { signedArea } from '../data/geometry.ts';
import { FLAT_GRID } from '../data/terrain.ts';
import { WalkGrid } from '../data/walkable.ts';
import { MeshBuilder, unindexed } from './mesh-builder.ts';
import { walkSolids } from './solids.ts';
import { CAFE_TABLE } from '../data/shops.ts';
import { terraceParasols } from './terraces.ts';
import { addTree } from './trees.ts';

const SQUARE = new Float32Array([-50, -20, 50, -20, 50, 20, -50, 20]);
const props: Prop[] = [
  { kind: 'lamp', x: 10, z: 30, angle: 0, size: 0 },
  { kind: 'bench', x: 20, z: 30, angle: Math.PI / 2, size: 0 },
  // As the bake writes a monument: with its plinth and material.
  { kind: 'statue', x: 30, z: 30, angle: 0, size: 3, width: 1.2, depth: 1.2, material: 'bronze' },
];
const city: City = {
  area: [{ minX: -100, minZ: -100, maxX: 100, maxZ: 100 }],
  bounds: { minX: -100, minZ: -100, maxX: 100, maxZ: 100 },
  buildings: [],
  roads: [SQUARE],
  carriageways: [],
  markings: [],
  plazas: [SQUARE],
  green: [],
  water: [],
  woods: [],
  pitches: [],
  pitchSurfaces: [],
  fields: [],
  parking: [],
  paths: [],
  rails: [],
  platforms: [],
  railLand: [],
  canopies: [],
  trees: new Float32Array([0, 50, 5, 50]),
  islands: [],
  treeKinds: new Uint8Array(0),
  hedges: [],
  flowerbeds: [],
  treeHeights: new Float32Array([12, 4]),
  props,
  tanks: [],
  bridges: [],
  decks: [],
  ramps: [],
  tunnels: [],
  parapets: [],
  streetNames: ['Oude Markt'],
  streets: [],
  plazaNames: [0],
  terrain: FLAT_GRID,
  fronts: [],
};

/** How far the drawn mesh reaches from (x, z) at its foot, below `y`. */
function reach(mesh: MeshBuilder, x: number, z: number, y: number): number {
  const p = unindexed(mesh.build()).getAttribute('position');
  let far = 0;
  for (let i = 0; i < p.count; i++) {
    if (p.getY(i) <= y) far = Math.max(far, Math.hypot(p.getX(i) - x, p.getZ(i) - z));
  }
  return far;
}

test('every trunk is a post as wide as it is drawn at its foot', () => {
  const { posts } = walkSolids(city);
  for (const i of [0, 1]) {
    const mesh = new MeshBuilder();
    addTree(mesh, city.trees[i * 2]!, city.trees[i * 2 + 1]!, i, city.treeHeights[i]!);
    expect(posts[i * 3 + 2]!).toBeCloseTo(reach(mesh, city.trees[i * 2]!, 50, 0.01), 5);
  }
  expect(posts[2]!).toBeLessThanOrEqual(0.35);
});

test('lamps are posts; benches (their seat), statues and café tables are footprints', () => {
  const { posts, rings } = walkSolids(city);
  // Two trunks and the lamp's post.
  expect(posts).toHaveLength(9);
  expect([posts[6], posts[7]]).toEqual([10, 30]);
  expect(posts[8]!).toBeCloseTo(0.12 * 1.3);
  const [bench, statue, ...feet] = rings;
  // The seat, 1.8 by 0.5 m at 1.3×, without the room for legs in front of it.
  expect(Math.abs(signedArea(bench!))).toBeCloseTo(1.8 * 0.5 * 1.3 * 1.3, 4);
  // A monument stands on its own plinth, at life size.
  expect(Math.abs(signedArea(statue!))).toBeCloseTo(1.2 * 1.2, 4);
  expect(feet.length).toBeGreaterThan(10);
  for (const foot of feet)
    expect(Math.abs(signedArea(foot))).toBeCloseTo((2 * CAFE_TABLE.reach) ** 2, 4);
});

test("a parasol's table and chairs close a square round it, turned with its row", () => {
  // The square turned by 30°, so its rows are too.
  const [c, s] = [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)];
  const turned = SQUARE.map((v, i) =>
    i % 2 ? SQUARE[i - 1]! * s + v * c : v * c - SQUARE[i + 1]! * s,
  );
  const square = { ...city, props: [], trees: new Float32Array(), plazas: [turned] };
  const [p] = terraceParasols(square);
  const foot = walkSolids(square).rings[0]!;
  const r = CAFE_TABLE.reach;
  for (let k = 0; k < 8; k += 2) {
    // Each corner is the reach along and across the row from the parasol.
    const [du, dv] = [
      (foot[k]! - p!.x) * p!.ux + (foot[k + 1]! - p!.z) * p!.uz,
      -(foot[k]! - p!.x) * p!.uz + (foot[k + 1]! - p!.z) * p!.ux,
    ];
    expect(Math.abs(du)).toBeCloseTo(r, 5);
    expect(Math.abs(dv)).toBeCloseTo(r, 5);
  }
});

test("a café's terrace closes the pavement it stands on", () => {
  const cafe = {
    id: 1,
    tier: 'core' as const,
    kind: 'retail' as const,
    roof: 'flat' as const,
    height: 10,
    eave: 10,
    roofColor: null,
    ring: new Float32Array([60, 60, 72, 60, 72, 70, 60, 70]),
    holes: [],
  };
  const front = { building: 0, edge: 0, along: 6, kind: 'cafe' as const, terrace: true };
  // No square, so no parasols: the terrace is the last footprint.
  const solids = (terrace: boolean) =>
    walkSolids({ ...city, plazas: [], buildings: [cafe], fronts: [{ ...front, terrace }] });
  const terrace = solids(true).rings.at(-1)!;
  // A table and two chairs along the wall, out in the street north of it.
  expect(Math.abs(signedArea(terrace))).toBeCloseTo(2.3 * 0.9, 4);
  expect(Math.max(...Array.from(terrace).filter((_, i) => i % 2 === 1))).toBeLessThan(60);
  expect(solids(false).rings.length).toBe(solids(true).rings.length - 1);
  // Without its terrace, two bay trees by its door, met as posts; a second front on the wall
  // leaves the first less room, but enough.
  const posts = (fronts: (typeof front)[]) =>
    walkSolids({ ...city, plazas: [], buildings: [cafe], fronts }).posts.length / 3;
  const base = posts([]);
  expect(posts([{ ...front, terrace: false }]) - base).toBe(2);
  expect(
    posts([
      { ...front, terrace: false },
      { ...front, along: 10, kind: 'shop' as never },
    ]) - base,
  ).toBe(2);
});

test('a walker meets them in the walk grid', () => {
  const grid = new WalkGrid(city, walkSolids(city));
  const out: [number, number] = [0, 0];
  expect(grid.wallOverlap(0, 50.5, 0.45, out)).toBeGreaterThan(0.2);
  expect(grid.wallOverlap(30, 30, 0.45, out)).toBeGreaterThan(0.45);
  expect(grid.walkable(30.1, 30.1)).toBe(false);
  expect(grid.walkable(20, 24)).toBe(true);
});

test('a hedge is walked round, along its whole length', () => {
  const hedge = Float32Array.from([10, 10, 30, 10, 30, 10]);
  const { rings } = walkSolids({ ...city, hedges: [hedge] });
  const ring = rings.find((r) => r[0]! < 20 && r[1]! < 11 && r[1]! > 9)!;
  const xs = Array.from(ring).filter((_, i) => i % 2 === 0);
  const zs = Array.from(ring).filter((_, i) => i % 2 === 1);
  expect(Math.min(...xs)).toBeCloseTo(10);
  expect(Math.max(...xs)).toBeCloseTo(30);
  expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(0.9);
});
