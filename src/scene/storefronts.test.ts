import { expect, test } from 'bun:test';

import type { Building, ShopFront } from '../data/city.ts';
import { discInFootprint } from '../data/props.ts';
import { frontPoint, terraceFootprint } from '../data/shops.ts';
import type { ShopKind } from '../data/shop-kinds.ts';
import { AWNING } from './facade-codes.ts';
import { MeshBuilder } from './mesh-builder.ts';
import { addAwning, addSign, addStorefronts, addTerrace, groundFloor } from './storefronts.ts';

// A 12 m front along z = 0, facing north (-z), its building behind it.
const ring = new Float32Array([0, 0, 12, 0, 12, 10, 0, 10]);
const building: Building = {
  id: 1,
  tier: 'core',
  kind: 'retail',
  roof: 'flat',
  height: 12,
  eave: 12,
  roofColor: null,
  ring,
  holes: [],
};
const front = (kind: ShopKind, along = 6, terrace = false): ShopFront => ({
  building: 0,
  edge: 0,
  along,
  kind,
  terrace,
});
const point = frontPoint(ring, front('cafe'));
const kit = { awning: AWNING, footing: () => 2, wallTop: () => 12, ground: () => 2.5 };

const built = (draw: (mesh: MeshBuilder) => void) => {
  const mesh = new MeshBuilder();
  draw(mesh);
  const g = mesh.build({ facade: true });
  const [p, f] = [g.getAttribute('position'), g.getAttribute('facade')];
  return {
    count: p.count,
    points: Array.from({ length: p.count }, (_, i) => [p.getX(i), p.getY(i), p.getZ(i)]),
    codes: new Set(Array.from({ length: f.count }, (_, i) => f.getX(i))),
  };
};

test('the ground floor is as tall as the shader draws it', () => {
  expect(groundFloor(12)).toBe(3);
  expect(groundFloor(5)).toBe(2.8);
  expect(groundFloor(30)).toBeCloseTo(3.33);
});

test('an awning is 14 vertices over the front, out of the walker’s way, coded for stripes', () => {
  const { count, points, codes } = built((m) => addAwning(m, point, 'frituur', 12, 2, AWNING));
  expect(count).toBe(14);
  expect(codes).toEqual(new Set([AWNING]));
  for (const [x, y, z] of points) {
    expect(x).toBeGreaterThanOrEqual(4 - 1e-6);
    expect(x).toBeLessThanOrEqual(8 + 1e-6);
    expect(z).toBeLessThanOrEqual(0); // out in the street
    expect(y).toBeGreaterThanOrEqual(2.6 - 1e-6);
  }
});

test('signs: a board, a token through it, a cross, a cone of fries', () => {
  const f = { x: 10, z: 0, fx: 0, fz: -1, scale: 1 };
  const sizes = (['bank', 'cafe', 'bar', 'bakery', 'icecream', 'pharmacy', 'frituur'] as const).map(
    (kind) => built((m) => addSign(m, f, kind, 12)).count,
  );
  expect(sizes).toEqual([40, 60, 60, 60, 60, 60, 95]);
  // Square to the wall, hung out over the street above head height.
  const { points } = built((m) => addSign(m, f, 'frituur', 12));
  for (const [, y, z] of points) {
    expect(z).toBeLessThanOrEqual(1e-6);
    expect(y).toBeGreaterThan(2.5);
  }
});

test('a terrace is drawn inside the footprint the walk grid closes', () => {
  const { count, points } = built((m) => addTerrace(m, point, 'cafe'));
  expect(count).toBe(148);
  const foot = terraceFootprint(point);
  for (const [x, , z] of points) expect(discInFootprint(foot, x!, z!, 1e-6)).toBe(true);
});

test("a cell's fronts: awnings stop short of each other and the corners, signs hang beside", () => {
  const fronts = [
    { building, front: front('bakery', 3) },
    { building, front: front('cafe', 7, true) },
    { building, front: front('service', 11.6) },
  ];
  const awnings = new MeshBuilder();
  const { count, points } = built((m) => addStorefronts(m, awnings, fronts, kit));
  // Bakery and café awnings; their signs and the café's terrace; the service front has no room.
  expect(awnings.build().getAttribute('position').count).toBe(14 * 2);
  expect(count).toBe(60 + 60 + 148);
  const ys = points.map(([, y]) => y!);
  // Awnings and signs stand on the building's footing, the terrace on the ground.
  expect(Math.min(...ys)).toBeCloseTo(2.5);
  const mesh = new MeshBuilder();
  mesh.lift = 7;
  addStorefronts(mesh, awnings, fronts, kit);
  expect([mesh.lift, awnings.lift]).toEqual([7, 0]);
});
