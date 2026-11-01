import { expect, test } from 'bun:test';

import { AREA, VIEW_AREA } from './area.ts';
import { ringInArea } from './geometry.ts';
import { unpackCity } from './format.ts';
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
  const streets = new StreetIndex(city);
  expect(streets.nameAt(0, 0)).toBe('Grote Markt');
  expect(city.plazaNames.some((n) => city.streetNames[n] === 'Oude Markt')).toBe(true);
});
