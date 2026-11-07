import { expect, test } from 'bun:test';

import { AREA, LANDMARK_FOOTPRINTS, VIEW_AREA } from './area.ts';
import { ringInArea } from './geometry.ts';
import { unpackCity } from './format.ts';
import { bikesIn } from './props.ts';
import { parseRooms, roomProblems } from './rooms.ts';
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
  expect([...kinds].toSorted()).toEqual(['cycleway', 'main', 'pedestrian', 'street']);
  // Every surface the data knows, somewhere: Leuven has its setts, its paving and its dirt tracks.
  const surfaces = new Set([...city.carriageways, ...city.paths].map((s) => s.surface));
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
