import { expect, test } from 'bun:test';

import type { City, Prop } from '../data/city.ts';
import { signedArea } from '../data/geometry.ts';
import { FLAT_GRID } from '../data/terrain.ts';
import { WalkGrid } from '../data/walkable.ts';
import { MeshBuilder, unindexed } from './mesh-builder.ts';
import { walkSolids } from './solids.ts';
import { PARASOL_FOOT, addParasol, terraceParasols } from './terraces.ts';
import { LineBuilder } from './mesh-builder.ts';
import { addTree } from './trees.ts';

const SQUARE = new Float32Array([-50, -20, 50, -20, 50, 20, -50, 20]);
const props: Prop[] = [
  { kind: 'lamp', x: 10, z: 30, angle: 0, size: 0 },
  { kind: 'bench', x: 20, z: 30, angle: Math.PI / 2, size: 0 },
  { kind: 'statue', x: 30, z: 30, angle: 0, size: 3 },
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
  parking: [],
  paths: [],
  rails: [],
  platforms: [],
  railLand: [],
  canopies: [],
  trees: new Float32Array([0, 50, 5, 50]),
  treeHeights: new Float32Array([12, 4]),
  props,
  tanks: [],
  bridges: [],
  parapets: [],
  streetNames: ['Oude Markt'],
  streets: [],
  plazaNames: [0],
  terrain: FLAT_GRID,
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

test('lamps are posts; benches (their seat), statues and parasol feet are footprints', () => {
  const { posts, rings } = walkSolids(city);
  // Two trunks and the lamp's post.
  expect(posts).toHaveLength(9);
  expect([posts[6], posts[7]]).toEqual([10, 30]);
  expect(posts[8]!).toBeCloseTo(0.12 * 1.3);
  const [bench, statue, ...feet] = rings;
  // The seat, 1.8 by 0.5 m at 1.3×, without the room for legs in front of it.
  expect(Math.abs(signedArea(bench!))).toBeCloseTo(1.8 * 0.5 * 1.3 * 1.3, 4);
  expect(Math.abs(signedArea(statue!))).toBeCloseTo(1.2 * 1.2 * 1.3 * 1.3, 4);
  expect(feet.length).toBeGreaterThan(10);
  for (const foot of feet)
    expect(Math.abs(signedArea(foot))).toBeCloseTo((2 * PARASOL_FOOT) ** 2, 4);
});

test('a parasol foot is where it is drawn, turned with its row', () => {
  // The square turned by 30°, so its rows are too.
  const [c, s] = [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)];
  const turned = SQUARE.map((v, i) =>
    i % 2 ? SQUARE[i - 1]! * s + v * c : v * c - SQUARE[i + 1]! * s,
  );
  const square = { ...city, props: [], trees: new Float32Array(), plazas: [turned] };
  const [parasol] = terraceParasols(square);
  const mesh = new MeshBuilder();
  addParasol(mesh, new LineBuilder(), parasol!);
  const p = unindexed(mesh.build()).getAttribute('position');
  const drawn = Array.from({ length: p.count }, (_, i) => [p.getX(i), p.getY(i), p.getZ(i)])
    .filter(([, y]) => y === 0)
    .map(([x, , z]) => [x!, z!]);
  const foot = walkSolids(square).rings[0]!;
  for (let k = 0; k < 8; k += 2) {
    const near = drawn.some(([x, z]) => Math.hypot(x! - foot[k]!, z! - foot[k + 1]!) < 1e-4);
    expect(near).toBe(true);
  }
});

test('a walker meets them in the walk grid', () => {
  const grid = new WalkGrid(city, walkSolids(city));
  const out: [number, number] = [0, 0];
  expect(grid.wallOverlap(0, 50.5, 0.45, out)).toBeGreaterThan(0.2);
  expect(grid.wallOverlap(30, 30, 0.45, out)).toBeGreaterThan(0.45);
  expect(grid.walkable(30.1, 30.1)).toBe(false);
  expect(grid.walkable(20, 24)).toBe(true);
});
