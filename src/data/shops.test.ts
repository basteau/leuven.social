import { expect, test } from 'bun:test';

import type { Building, ShopFront } from './city.ts';
import { Facades } from './facades.ts';
import { Shapes, propFootprint } from './props.ts';
import {
  fitTerraces,
  frontPoint,
  markShopFronts,
  placeFronts,
  placePoints,
  terraceFootprint,
} from './shops.ts';
import type { TerraceSurroundings } from './shops.ts';

const rect = (x: number, z: number, w: number, d: number) =>
  new Float32Array([x, z, x + w, z, x + w, z + d, x, z + d]);
// Two houses side by side on the south side of a street running along z = -10, one far off and
// one behind the first, hidden from the street.
const rings = [rect(0, 0, 6, 10), rect(6, 0, 6, 10), rect(30, 0, 6, 10), rect(0, 30, 6, 10)];
const streets = new Map([[0, [-50, -10, 50, -10]]]);
const input = {
  facades: new Facades(rings),
  streets,
  names: new Map([['Naamsestraat', 0]]),
  squares: new Map(),
  open: () => false,
  skip: new Set([2]),
};
const house = (i: number, kind: Building['kind'] = 'house'): Building => ({
  id: i,
  tier: 'core',
  kind,
  roof: 'auto',
  height: 10,
  eave: 8,
  roofColor: null,
  ring: rings[i]!,
  holes: [],
});

test('a front stands on its wall, facing out of the building', () => {
  const p = frontPoint(rings[0]!, { edge: 0, along: 2 });
  expect(p).toEqual({ x: 2, z: 0, ux: 1, uz: 0, nx: 0, nz: -1, length: 6 });
  // The last edge closes the ring.
  expect(frontPoint(rings[0]!, { edge: 3, along: 4 })).toMatchObject({ x: 0, z: 6, nx: -1 });
});

test('each shop gets the wall facing its street, its building the most telling front', () => {
  const street = { 'addr:street': 'Naamsestraat' };
  const { fronts, placed, skipped } = placeFronts(
    [
      { x: 3, z: 2, tags: { amenity: 'fast_food', cuisine: 'friture', ...street } },
      // The same frituur, mapped again as its building.
      { x: 3.5, z: 5, tags: { amenity: 'fast_food', name: 'Frituur Tivoli' } },
      { x: 9, z: 5, tags: { shop: 'hairdresser', 'addr:street': 'Nowhere' } },
      { x: 8, z: 5, tags: { shop: 'bakery', outdoor_seating: 'yes' } },
      { x: 100, z: 100, tags: { shop: 'gift' } },
      { x: 33, z: 5, tags: { shop: 'gift' } },
      { x: 3, z: 35, tags: { amenity: 'bar' } },
      { x: 4, z: 4, tags: { amenity: 'bench' } },
    ],
    input,
  );
  expect(fronts).toEqual([
    { building: 0, edge: 0, along: 3, kind: 'frituur', terrace: false },
    { building: 1, edge: 0, along: 2, kind: 'bakery', terrace: true },
    { building: 1, edge: 0, along: 3, kind: 'hairdresser', terrace: false },
  ]);
  expect(placed).toEqual({ 'facing its street': 3 });
  expect(skipped).toEqual({
    'mapped twice': 1,
    'no footprint': 1,
    landmark: 1,
    'no wall facing the street': 1,
  });
});

test('a public place shows once on its building, from its point or its building', () => {
  const { fronts, skipped } = placeFronts(
    [
      { x: 3, z: 2, tags: { amenity: 'university', name: 'Faculty' } },
      { x: 4, z: 3, tags: { amenity: 'university', name: 'Its institute' } },
      // Read off the building, on another wall's side: the same place.
      { x: 3, z: 9, tags: {}, kind: 'university', building: 0 },
      { x: 9, z: 9, tags: {}, kind: 'hotel', building: 1 },
    ],
    input,
  );
  expect(fronts.map((f) => [f.building, f.kind])).toEqual([
    [0, 'university'],
    [1, 'hotel'],
  ]);
  expect(skipped).toEqual({ 'mapped twice': 2 });
});

test('placePoints finds places by their building or the site they stand on', () => {
  const big = (x: number) => rect(x, 0, 10, 10);
  const points = placePoints(
    [
      { ring: big(0), kind: 'other', tag: 'school' },
      { ring: big(20), kind: 'other', tag: 'yes' },
      { ring: big(40), kind: 'house', tag: 'house' },
      // Too small, and a shed, on the campus all the same.
      { ring: rect(22, 12, 4, 4), kind: 'other', tag: 'yes' },
      { ring: rect(24, 20, 10, 10), kind: 'shed', tag: 'shed' },
    ],
    [{ kind: 'university', ring: rect(15, -5, 40, 40) }],
  );
  expect(points).toEqual([
    { x: 5, z: 5, tags: {}, kind: 'school', building: 0 },
    { x: 25, z: 5, tags: {}, kind: 'university', building: 1 },
    { x: 45, z: 5, tags: {}, kind: 'university', building: 2 },
  ]);
});

test('a building with a front shows its main one and becomes a shop, unless a church', () => {
  const buildings = [house(0), house(1, 'church'), house(2)];
  const fronts: ShopFront[] = [
    { building: 0, edge: 0, along: 2, kind: 'cafe', terrace: false },
    { building: 0, edge: 0, along: 4, kind: 'shop', terrace: false },
    { building: 1, edge: 0, along: 2, kind: 'bar', terrace: false },
    // A school's sign by its door leaves its building a house.
    { building: 2, edge: 0, along: 2, kind: 'school', terrace: false },
  ];
  expect(markShopFronts(buildings, fronts)).toBe(1);
  expect(buildings.map((b) => [b.kind, b.front?.kind])).toEqual([
    ['retail', 'cafe'],
    ['church', 'bar'],
    ['house', undefined],
  ]);
});

/** Ground round the houses: a carriageway from z = -20 up to `kerb`, and what's on it. */
function surroundings(kerb: number, more: Partial<TerraceSurroundings> = {}): TerraceSurroundings {
  const roads = new Shapes();
  roads.ring(rect(-50, -20, 100, 20 + kerb));
  const solid = new Shapes();
  for (const ring of rings) solid.ring(ring);
  return { roads, solid, water: new Shapes(), props: [], trunks: [], ...more };
}
const cafe = (): ShopFront => ({ building: 0, edge: 0, along: 3, kind: 'cafe', terrace: true });

test('a terrace stands where the pavement leaves room to walk past it', () => {
  const wide = [cafe()];
  expect(fitTerraces(wide, rings, surroundings(-6))).toBe(1);
  expect(wide[0]).toMatchObject({ along: 3, terrace: true });
  const narrow = [cafe()];
  expect(fitTerraces(narrow, rings, surroundings(-2.5))).toBe(0);
  expect(narrow[0]!.terrace).toBe(false);
  // Its footprint is what the scene draws and the walk grid closes.
  expect(terraceFootprint(frontPoint(rings[0]!, wide[0]!))).toMatchObject({
    x: 3,
    z: -0.75,
    fz: -1,
    v0: -0.45,
    v1: 0.45,
  });
});

test('a terrace slides along its wall round a lamp, and gives way to a trunk', () => {
  const lamp = propFootprint({ kind: 'lamp', x: 2, z: -0.8, angle: 0, size: 0 });
  const slid = [cafe()];
  expect(fitTerraces(slid, rings, surroundings(-6, { props: [lamp] }))).toBe(1);
  expect(slid[0]!.along).toBe(3.75);
  const shaded = [cafe(), { ...cafe(), building: 1 }];
  const trunks = [[3, -0.8, 0.3] as const, [9, -0.8, 2] as const];
  expect(fitTerraces(shaded, rings, surroundings(-6, { trunks }))).toBe(0);
  // Two terraces never overlap, and a front without one keeps none.
  const pair = [cafe(), { ...cafe(), along: 4 }, { ...cafe(), terrace: false }];
  expect(fitTerraces(pair, rings, surroundings(-6))).toBe(1);
});
