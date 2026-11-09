import { expect, test } from 'bun:test';

import { AREA, LANDMARK_FOOTPRINTS, VIEW_AREA } from './area.ts';
import { ringInArea } from './geometry.ts';
import { unpackCity } from './format.ts';
import { bikesIn } from './props.ts';
import { parseRooms, roomProblems } from './rooms.ts';
import { StreetIndex } from './streets.ts';
import { deckStrip } from './structures.ts';
import { landform } from './terrain.ts';

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
  // What grows and how racks are built come from the map, not from a guess.
  expect(city.treeKinds.length).toBe(city.treeHeights.length);
  expect(new Set(city.treeKinds).size).toBeGreaterThan(2);
  expect(city.hedges.length).toBeGreaterThan(100);
  expect(city.flowerbeds.length).toBeGreaterThan(5);
  expect(city.islands.length).toBeGreaterThan(20);
  const parked = city.props.filter((p) => p.kind === 'bikes');
  expect(parked.some((p) => p.covered)).toBe(true);
  expect(new Set(parked.map((p) => p.rack)).size).toBeGreaterThan(2);
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
  expect(bikes).toBeGreaterThan(2900); // fewer than the 3,100 of old: racks no longer jump the road
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

/** Metres of seam under 0.3 m left between ramps on the map: 1,567 before heights were matched. */
const SEAMS_LEFT = 1400;

// Guards the shapes the ground makes: a wall in a road is the thing to catch, and it can't be seen
// from any one line of code. The number only comes down; it's the wall left where a road surface
// lies at one height across both sides of it.
test('the ground steps only where it steps', async () => {
  const response = await fetch(new URL('../../public/data/city.bin', import.meta.url));
  const city = await unpackCity(new Uint8Array(await response.arrayBuffer()));
  const ground = landform(city.terrain, city.ramps, city.decks.map(deckStrip));
  const steps = ground.steps();
  let total = 0;
  for (const { ax, az, bx, bz, high, low } of steps) {
    total += Math.hypot(bx - ax, bz - az);
    // Each is what it says: the heights on its two sides are those it was found between.
    const length = Math.hypot(bx - ax, bz - az) || 1;
    const [rx, rz] = [(bz - az) / length, -(bx - ax) / length];
    const [mx, mz] = [(ax + bx) / 2, (az + bz) / 2];
    const lowSide = ground.height(mx + rx * 0.03, mz + rz * 0.03) - ground.plain(mx, mz);
    const highSide = ground.height(mx - rx * 0.03, mz - rz * 0.03) - ground.plain(mx, mz);
    // A step tapering away at one end has next to no drop at its middle.
    if ((high[0] - low[0] + high[1] - low[1]) / 2 > 0.1) expect(highSide).toBeGreaterThan(lowSide);
    expect(Math.abs(lowSide - (low[0] + low[1]) / 2)).toBeLessThan(
      Math.abs(high[0] - low[0]) + Math.abs(high[1] - low[1]) + 0.5,
    );
  }
  expect(total).toBeGreaterThan(5000);
  // No length of any ramp is left out: along each one's line the ground is lifted or sunk.
  for (const ramp of city.ramps.filter((r) => !r.rail)) {
    for (let i = 0; i + 3 < ramp.line.length; i += 2) {
      const [ax, az] = [ramp.line[i]!, ramp.line[i + 1]!];
      const [bx, bz] = [ramp.line[i + 2]!, ramp.line[i + 3]!];
      const [ra, rb] = [ramp.rise[i / 2]!, ramp.rise[i / 2 + 1]!];
      for (const t of [0.25, 0.5, 0.75]) {
        if (Math.abs(ra + (rb - ra) * t) < 0.2) continue;
        const [x, z] = [ax + (bx - ax) * t, az + (bz - az) * t];
        expect(ground.height(x, z) - ground.plain(x, z)).not.toBe(0);
      }
    }
  }
  // Seams of a few centimetres between ramps side by side: what's left once their heights are
  // matched, and drawn as the road's own. This only comes down.
  let seams = 0;
  for (const { ax, az, bx, bz, high, low } of steps) {
    const between = Math.min(Math.abs(low[0]), Math.abs(low[1])) > 1e-6;
    const sunk = Math.min(Math.abs(high[0]), Math.abs(high[1])) > 1e-6;
    if (between && sunk && Math.max(high[0] - low[0], high[1] - low[1]) < 0.3) {
      seams += Math.hypot(bx - ax, bz - az);
    }
  }
  expect(seams).toBeLessThan(SEAMS_LEFT);
  // Every ramp lies wider than nothing, and reaches as far as it says at every point.
  for (const ramp of city.ramps) {
    const n = ramp.line.length / 2;
    expect(ramp.rise.length).toBe(n);
    if (ramp.left) expect(ramp.left.length).toBe(n);
    if (ramp.right) expect(ramp.right.length).toBe(n);
  }
});
