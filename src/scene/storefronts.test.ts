import { expect, test } from 'bun:test';

import type { Building, ShopFront } from '../data/city.ts';
import { discInFootprint } from '../data/props.ts';
import { frontPoint, terraceFootprint } from '../data/shops.ts';
import type { ShopKind } from '../data/shop-kinds.ts';
import { AWNING } from './facade-codes.ts';
import { MeshBuilder } from './mesh-builder.ts';
import { CAFE_TABLE } from '../data/shops.ts';
import {
  addAwning,
  addCafeTable,
  addDoorPlant,
  addGuest,
  addBoard,
  addSign,
  addStorefronts,
  addTerrace,
  groundFloor,
} from './storefronts.ts';

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
const kit = { awning: AWNING, footing: () => 2, wallTop: () => 12 };
const ground = () => 2.5;

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

test('a café table on a square: chairs round it, some taken, all inside the reach kept clear', () => {
  const tables = Array.from({ length: 12 }, (_, seed) =>
    built((m) => addCafeTable(m, 0, 0, 1, 0, 2 + (seed % 3), 0xd2553f, seed, false)),
  );
  // The top, then 56 vertices a chair and 156 a guest with their glass.
  const guests = tables.map(({ count }, seed) => (count - 20 - 56 * (2 + (seed % 3))) / 156);
  for (const n of guests) expect(Number.isInteger(n)).toBe(true);
  // Some tables busier than others.
  expect(Math.max(...guests)).toBeGreaterThan(Math.min(...guests));
  for (const { points } of tables) {
    for (const [x, , z] of points) {
      expect(Math.max(Math.abs(x!), Math.abs(z!))).toBeLessThanOrEqual(CAFE_TABLE.reach + 1e-6);
    }
  }
  // A guest sits on the seat, head and hair over the chair's back.
  const guest = built((m) => addGuest(m, { x: 0, z: 0, fx: 0, fz: 1, scale: 1 }, 3));
  expect(guest.count).toBe(116);
  expect(Math.max(...guest.points.map(([, y]) => y!))).toBeCloseTo(1.69);
});

test('a bar without a terrace gets its sign and a bay tree each side of its door', () => {
  const bar = built((m) =>
    addStorefronts(m, new MeshBuilder(), [{ building, front: front('bar') }], kit, ground),
  );
  expect(bar.count).toBe(76 + 2 * 50);
});

test('a bay tree by the door: a pot and a cone of leaves', () => {
  const plant = built((m) => addDoorPlant(m, { x: 0, z: 0, fx: 0, fz: 1, scale: 1 }, 1));
  expect(plant.count).toBe(16 + 4 + 24 + 6);
  expect(Math.max(...plant.points.map(([, y]) => y!))).toBeCloseTo(1.6);
});

test('signs: a board, a token through it, a cross, a cone of fries', () => {
  const f = { x: 10, z: 0, fx: 0, fz: -1, scale: 1 };
  const sizes = (['bank', 'cafe', 'bar', 'bakery', 'icecream', 'pharmacy', 'frituur'] as const).map(
    (kind) => built((m) => addSign(m, f, kind, 12)).count,
  );
  expect(sizes).toEqual([56, 76, 76, 76, 76, 60, 95]);
  // Square to the wall, hung out over the street above head height.
  const { points } = built((m) => addSign(m, f, 'frituur', 12));
  for (const [, y, z] of points) {
    expect(z).toBeLessThanOrEqual(1e-6);
    expect(y).toBeGreaterThan(2.5);
  }
});

test('a terrace is drawn inside the footprint the walk grid closes', () => {
  const { count, points } = built((m) => addTerrace(m, point, 'cafe'));
  // A table with two chairs and a guest with a glass, in wicker or the café's colour.
  expect(count).toBe(304);
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
  const { count, points } = built((m) => addStorefronts(m, awnings, fronts, kit, ground));
  // Bakery and café awnings; their signs and the café's terrace; the service front has no room.
  expect(awnings.build().getAttribute('position').count).toBe(14 * 2);
  expect(count).toBe(260);
  const ys = points.map(([, y]) => y!);
  // The terrace stands on the ground as drawn, the signs over it where it's above the footing.
  expect(Math.min(...ys)).toBeCloseTo(2.5);
  const signAt = (y: number) =>
    Math.min(
      ...built((m) =>
        addStorefronts(m, new MeshBuilder(), fronts.slice(0, 1), kit, () => y),
      ).points.map(([, py]) => py!),
    );
  // On the footing (2) downhill of it; 0.5 m higher over a street 2.5 m up.
  expect(signAt(2.5) - signAt(0)).toBeCloseTo(0.5);
  expect(signAt(1) - signAt(0)).toBeCloseTo(0);
  const mesh = new MeshBuilder();
  mesh.lift = 7;
  addStorefronts(mesh, awnings, fronts, kit, ground);
  expect([mesh.lift, awnings.lift]).toEqual([7, 0]);
});

test('terraces vary by seed, and every layout stays inside its footprint', () => {
  const foot = terraceFootprint(point);
  const counts = new Set<number>();
  for (const kind of ['cafe', 'bar', 'restaurant'] as const) {
    for (let seed = 0; seed < 40; seed++) {
      const { count, points } = built((m) => addTerrace(m, point, kind, seed));
      counts.add(count);
      for (const [x, , z] of points) expect(discInFootprint(foot, x!, z!, 1e-6)).toBe(true);
    }
  }
  expect(counts.size).toBeGreaterThan(3);
});

test('a restaurant hangs a plate and cutlery sign; a menu board stands wordless on the pavement', () => {
  const f = { x: 10, z: 0, fx: 0, fz: -1, scale: 1 };
  expect(built((m) => addSign(m, f, 'restaurant', 12)).count).toBeGreaterThan(80);
  const board = built((m) => addBoard(m, f));
  expect(Math.max(...board.points.map(([, y]) => y!))).toBeLessThan(1.1);
});
