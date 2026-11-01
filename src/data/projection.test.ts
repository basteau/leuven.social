import { expect, test } from 'bun:test';

import { ORIGIN, toLambert72, toLocal, toLonLat } from './projection.ts';

test('Grote Markt is the origin', () => {
  expect(toLocal(ORIGIN.lon, ORIGIN.lat)).toEqual([0, 0]);
});

test('Ladeuzeplein lies ~390 m east and ~110 m south of Grote Markt', () => {
  const [x, z] = toLocal(4.7069, 50.8782);
  expect(x).toBeGreaterThan(370);
  expect(x).toBeLessThan(400);
  expect(z).toBeGreaterThan(100);
  expect(z).toBeLessThan(115);
});

test('toLonLat inverts toLocal', () => {
  const [lon, lat] = toLonLat(...toLocal(4.68306, 50.86333));
  expect(lon).toBeCloseTo(4.68306, 9);
  expect(lat).toBeCloseTo(50.86333, 9);
});

// Reference values from pyproj 3.8 (PROJ 9.8), EPSG:4326 → EPSG:31370.
test.each([
  [4.70139, 50.87917, 173409.9985, 174364.2191],
  [4.676, 50.857, 171633.3663, 171890.3021],
  [4.722, 50.892, 174853.6537, 175798.1501],
  [2.55, 51.35, 23296.4993, 228242.3111],
  [5.9, 50.7, 258168.4139, 155497.2453],
])('toLambert72(%p, %p) matches PROJ', (lon, lat, x, y) => {
  const [lx, ly] = toLambert72(lon, lat);
  expect(Math.abs(lx - x)).toBeLessThan(0.005);
  expect(Math.abs(ly - y)).toBeLessThan(0.005);
});
