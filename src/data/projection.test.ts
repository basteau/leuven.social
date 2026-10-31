import { expect, test } from 'bun:test';

import { ORIGIN, toLocal, toLonLat } from './projection.ts';

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
