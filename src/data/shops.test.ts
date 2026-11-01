import { expect, test } from 'bun:test';

import type { Building } from './city.ts';
import { isShopFront, markShopFronts } from './shops.ts';

const house = (x: number, kind: Building['kind'] = 'house'): Building => ({
  id: x,
  tier: 'core',
  kind,
  roof: 'auto',
  height: 10,
  eave: 8,
  roofColor: null,
  ring: new Float32Array([x, 0, x + 6, 0, x + 6, 10, x, 10]),
  holes: [],
});

test('shops and street-side cafés, bars and restaurants are shop fronts', () => {
  expect(isShopFront({ shop: 'bakery' })).toBe(true);
  expect(isShopFront({ amenity: 'cafe' })).toBe(true);
  expect(isShopFront({ amenity: 'bench' })).toBe(false);
  expect(isShopFront({})).toBe(false);
});

test('a house with a café inside becomes retail; churches and empty houses stay', () => {
  const buildings = [house(0), house(100), house(200, 'church')];
  // A café in the first house, one in the church, one in nobody's footprint.
  expect(markShopFronts(buildings, [3, 5, 203, 5, 60, 60])).toBe(1);
  expect(buildings.map((b) => b.kind)).toEqual(['retail', 'house', 'church']);
});
