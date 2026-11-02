import { expect, test } from 'bun:test';

import { AREA, VIEW_AREA } from './area.ts';
import { MAX_NAME, latinOnly } from './boards.ts';
import { areaIndex, pointInRing, ringInArea } from './geometry.ts';
import { unpackCity } from './format.ts';
import { unpackWalk } from './plates.ts';
import { bikesIn } from './props.ts';
import { StreetIndex } from './streets.ts';

// Guards the committed city file: it must decode, match the area and stay plausible.
test('public/data/city.bin decodes into a plausible Leuven', async () => {
  const response = await fetch(new URL('../../public/data/city.bin', import.meta.url));
  const city = await unpackCity(new Uint8Array(await response.arrayBuffer()));

  expect(city.area).toEqual([...AREA]);
  expect(city.bounds).toEqual(VIEW_AREA);
  expect(city.buildings.length).toBeGreaterThan(1000);
  expect(city.buildings.every((b) => ringInArea(b.ring, AREA))).toBe(true);
  expect(city.buildings.every((b) => b.height >= 2.5 && b.height <= 90)).toBe(true);
  expect(city.buildings.some((b) => b.tier === 'hero')).toBe(true);
  expect(city.roads.length).toBeGreaterThan(50);
  // Road detail: carriageways of every kind, lane lines and crossings.
  const kinds = new Set(city.carriageways.map((c) => c.kind));
  expect([...kinds].toSorted()).toEqual(['cycleway', 'main', 'paving', 'sett', 'street']);
  expect(city.markings.filter((m) => m.kind === 'dashed').length).toBeGreaterThan(50);
  expect(city.markings.filter((m) => m.kind === 'zebra').length).toBeGreaterThan(50);
  expect(city.water.length).toBeGreaterThan(0);
  expect(city.woods.length + city.pitches.length + city.parking.length).toBeGreaterThan(0);
  expect(city.trees.length / 2).toBeGreaterThan(100);
  // The street sign reads OSM's names: the square at the origin, a street off it.
  expect(city.streetNames).toContain('Naamsestraat');
  expect(city.streets.length).toBeGreaterThan(500);
  // Racks hold as many bikes as Leuven parks at them: the station's packed, quiet streets a third.
  const racks = city.props.filter((p) => p.kind === 'bikes');
  const bikes = racks.reduce((sum, p) => sum + bikesIn(p), 0);
  expect(bikes).toBeGreaterThan(3000);
  expect(bikes).toBeLessThan(4500);
  expect(racks.every((p) => p.fill! >= 0 && p.fill! <= 1)).toBe(true);
  const streets = new StreetIndex(city);
  expect(streets.nameAt(0, 0)).toBe('Grote Markt');
  expect(city.plazaNames.some((n) => city.streetNames[n] === 'Oude Markt')).toBe(true);
  // Shop fronts from OSM's shops, by kind: Leuven has its frituren, and a front on every busy street.
  expect(city.fronts.length).toBeGreaterThanOrEqual(1000);
  expect(city.fronts.filter((f) => f.kind === 'frituur').length).toBeGreaterThanOrEqual(20);
  expect(city.fronts.filter((f) => f.kind === 'pharmacy').length).toBeGreaterThanOrEqual(20);
  expect(city.fronts.some((f) => f.terrace)).toBe(true);
  // The streets traffic drives: the ring, the centre's one-way streets and the cycle tracks.
  expect(city.ways.length).toBeGreaterThan(1500);
  expect(new Set(city.ways.map((w) => w.kind))).toEqual(
    new Set(['main', 'street', 'cycle', 'path']),
  );
  // Measured half-widths: most streets are a few metres wide either side of their line.
  const driven = city.ways.filter((w) => w.kind === 'street' || w.kind === 'main');
  expect(driven.filter((w) => w.halfWidth >= 2 && w.halfWidth <= 12).length).toBeGreaterThan(
    driven.length * 0.6,
  );
  // No way runs through a house: every point of every way is outside every footprint.
  const inHouse = (x: number, z: number) =>
    city.buildings.some((b) => Math.abs(b.ring[0]! - x) < 80 && pointInRing(b.ring, x, z));
  const sample = city.ways.filter((_, i) => i % 7 === 0);
  expect(sample.some((w) => inHouse(w.line[0]!, w.line[1]!))).toBe(false);
  expect(city.ways.filter((w) => w.oneway).length).toBeGreaterThan(300);
  expect(city.ways.some((w) => w.bikesBoth)).toBe(true);
});

const load = async (name: string) =>
  new Uint8Array(
    await (await fetch(new URL(`../../public/data/${name}`, import.meta.url))).arrayBuffer(),
  );
const inArea = (p: { x: number; z: number }) => areaIndex(AREA, p.x, p.z) >= 0;

// Guards the committed walk file: its plates hang in the area and name the city's streets.
test('public/data/walk.bin decodes into plates that belong to city.bin', async () => {
  const [city, walk] = await Promise.all([
    load('city.bin').then(unpackCity),
    load('walk.bin').then(unpackWalk),
  ]);
  expect(walk.houses.length).toBeGreaterThan(5000);
  expect(walk.streets.length).toBeGreaterThan(500);
  expect(walk.houses.every(inArea)).toBe(true);
  expect(walk.streets.every(inArea)).toBe(true);
  expect(walk.streets.every((s) => s.name < city.streetNames.length)).toBe(true);
  const named = new Set(walk.streets.map((s) => city.streetNames[s.name]));
  expect(named).toContain('Naamsestraat');
  expect(named).toContain('Tiensestraat');
  expect(walk.houses.some((h) => h.text === '1')).toBe(true);
  // A name board on most shop fronts, inside its front and with a name a board can show.
  expect(walk.boards.length).toBeGreaterThan(city.fronts.length * 0.8);
  expect(walk.boards.every(inArea)).toBe(true);
  expect(walk.boards.every((b) => b.width > 0.8 && b.width <= 5)).toBe(true);
  expect(
    walk.boards.every((b) => [...b.name].length <= MAX_NAME && latinOnly(b.name) === b.name),
  ).toBe(true);
});
