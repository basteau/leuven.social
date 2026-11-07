import { expect, test } from 'bun:test';

import { AREA, LANDMARK_FOOTPRINTS, VIEW_AREA } from './area.ts';
import { MAX_NAME, latinOnly } from './boards.ts';
import { areaIndex, pointAlong, pointInRing, ringInArea } from './geometry.ts';
import { unpackCity } from './format.ts';
import { unpackWalk } from './plates.ts';
import { bikesIn } from './props.ts';
import { parseRooms, roomProblems } from './rooms.ts';
import { StreetIndex } from './streets.ts';
import { PAVEMENT, pavementOf } from './traffic.ts';
import type { Side } from './city.ts';

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
  expect([...kinds].toSorted()).toEqual(['cycleway', 'main', 'pedestrian', 'street']);
  // Every surface the data knows, somewhere: Leuven has its setts, its paving and its dirt tracks.
  const surfaces = new Set(
    [...city.carriageways, ...city.paths, ...city.ways].map((s) => s.surface),
  );
  for (const s of ['asphalt', 'sett', 'paving', 'gravel', 'earth'] as const)
    expect(surfaces.has(s)).toBe(true);
  expect(city.carriageways.some((c) => c.surface === 'earth' || c.surface === 'gravel')).toBe(true);
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
    new Set(['main', 'street', 'cycle', 'pedestrian', 'path']),
  );
  // Measured sides: most streets are a few metres of open ground either side of their line,
  // most of them with a kerb inside it, and a pavement beyond the kerb on most of those.
  const driven = city.ways.filter((w) => w.kind === 'street' || w.kind === 'main');
  expect(driven.filter((w) => wide(w.right) && wide(w.left)).length).toBeGreaterThan(
    driven.length * 0.6,
  );
  const kerbed = driven.filter((w) => w.right.kerb > 0 && w.left.kerb > 0);
  expect(kerbed.length).toBeGreaterThan(driven.length * 0.6);
  expect(kerbed.every((w) => w.right.kerb <= w.right.edge && w.left.kerb <= w.left.edge)).toBe(
    true,
  );
  expect(
    kerbed.filter((w) => pavementOf(w.right) >= PAVEMENT || pavementOf(w.left) >= PAVEMENT).length,
  ).toBeGreaterThan(kerbed.length * 0.6);
  // A pedestrian street is one; a path's sides are a metre of its own.
  expect(city.ways.filter((w) => w.kind === 'pedestrian').length).toBeGreaterThan(20);
  expect(city.ways.filter((w) => w.kind === 'path').every((w) => w.right.edge === 1)).toBe(true);
  // No way runs through a house: all but a handful of the ways' middles (a covered passage, a
  // courtyard's gate; 11 of 9,200) are outside every footprint, and no end sits in one by more
  // than the metre the bake cuts to.
  const inHouse = (x: number, z: number) =>
    city.buildings.some((b) => Math.abs(b.ring[0]! - x) < 80 && pointInRing(b.ring, x, z));
  const middles = city.ways.filter((w) =>
    inHouse(...(pointAlong(w.line, 0.5).slice(0, 2) as [number, number])),
  );
  expect(middles.length).toBeLessThan(city.ways.length * 0.005);
  expect(city.ways.filter((w) => w.oneway).length).toBeGreaterThan(300);
  expect(city.ways.some((w) => w.bikesBoth)).toBe(true);
});

/** A side with a few metres of open ground. */
const wide = (s: Side) => s.edge >= 2 && s.edge <= 12;

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

// The rooms are authored against the bake: a rebake that moves or reshapes a landmark, or an edit
// that puts a wall out of its building, fails here rather than at the door.
test('public/data/rooms.json fits the landmarks in city.bin', async () => {
  const city = await unpackCity(
    new Uint8Array(
      await (await fetch(new URL('../../public/data/city.bin', import.meta.url))).arrayBuffer(),
    ),
  );
  const json: unknown = await (
    await fetch(new URL('../../public/data/rooms.json', import.meta.url))
  ).json();
  const rooms = parseRooms(json);
  expect(rooms.length).toBeGreaterThan(0);
  expect(new Set(rooms.map((r) => r.id)).size).toBe(rooms.length);
  for (const room of rooms) {
    const b = city.buildings.find((x) => x.id === room.oidn);
    const building = b && { id: b.id, ring: b.ring, landmark: LANDMARK_FOOTPRINTS.includes(b.id) };
    expect(roomProblems(room, building)).toEqual([]);
  }
  expect(rooms.some((r) => r.floors.length > 1)).toBe(true);
});
