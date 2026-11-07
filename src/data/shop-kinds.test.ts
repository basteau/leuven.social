import { expect, test } from 'bun:test';

import { PLACES, SHOP_KINDS, placeKind, rank, shopKind } from './shop-kinds.ts';
import type { ShopKind } from './shop-kinds.ts';

test('a frituur is fast food that fries, by its cuisine or by its name', () => {
  expect(shopKind({ amenity: 'fast_food', cuisine: 'friture' })).toBe('frituur');
  expect(shopKind({ amenity: 'fast_food', cuisine: 'belgian;fries' })).toBe('frituur');
  expect(shopKind({ amenity: 'fast_food', name: "'t Fritwinkeltje" })).toBe('frituur');
  expect(shopKind({ amenity: 'fast_food', name: 'Frituur Tivoli', cuisine: 'burger' })).toBe(
    'frituur',
  );
  // Fried chicken is not a frituur, and neither is a kebab place.
  expect(shopKind({ amenity: 'fast_food', cuisine: 'chicken;fried_chicken' })).toBe('snack');
  expect(shopKind({ amenity: 'fast_food', cuisine: 'kebab', name: 'Ankara' })).toBe('snack');
  // A restaurant serving fries stays a restaurant.
  expect(shopKind({ amenity: 'restaurant', cuisine: 'fries' })).toBe('restaurant');
});

test('amenities, shops and crafts map to their kind', () => {
  expect(shopKind({ amenity: 'pub' })).toBe('bar');
  expect(shopKind({ amenity: 'cafe' })).toBe('cafe');
  expect(shopKind({ amenity: 'pharmacy' })).toBe('pharmacy');
  expect(shopKind({ amenity: 'bank' })).toBe('bank');
  expect(shopKind({ amenity: 'ice_cream' })).toBe('icecream');
  expect(shopKind({ shop: 'bakery' })).toBe('bakery');
  expect(shopKind({ craft: 'confectionery' })).toBe('bakery');
  expect(shopKind({ shop: 'supermarket' })).toBe('food');
  expect(shopKind({ shop: 'clothes' })).toBe('fashion');
  expect(shopKind({ shop: 'bicycle' })).toBe('bicycle');
  expect(shopKind({ shop: 'hairdresser' })).toBe('hairdresser');
  expect(shopKind({ shop: 'beauty' })).toBe('service');
  expect(shopKind({ shop: 'greengrocer' })).toBe('greengrocer');
  expect(shopKind({ shop: 'florist' })).toBe('florist');
  expect(shopKind({ shop: 'books' })).toBe('books');
  expect(shopKind({ shop: 'gift' })).toBe('shop');
  expect(shopKind({ shop: 'yes' })).toBe('shop');
});

test('a chemist is not a pharmacy, and vacant shops and other points are none', () => {
  expect(shopKind({ shop: 'chemist', name: 'Kruidvat' })).toBe('shop');
  expect(shopKind({ shop: 'vacant' })).toBeNull();
  expect(shopKind({ shop: 'no' })).toBeNull();
  expect(shopKind({ amenity: 'bench' })).toBeNull();
  expect(shopKind({ craft: 'carpenter' })).toBeNull();
  expect(shopKind({ amenity: 'constructor' })).toBeNull();
  expect(shopKind({})).toBeNull();
});

const main = (kinds: ShopKind[]) => kinds.toSorted((a, b) => rank(a) - rank(b))[0];

test('a building shows its most telling front', () => {
  expect(main(['service', 'frituur', 'restaurant'])).toBe('frituur');
  expect(main(['shop', 'bank'])).toBe('bank');
  expect(main(['restaurant', 'cafe'])).toBe('cafe');
});

test('public places by their amenity, tourism, leisure or building value', () => {
  expect(placeKind({ amenity: 'university' })).toBe('university');
  expect(placeKind({ amenity: 'kindergarten' })).toBe('school');
  expect(placeKind({ tourism: 'guest_house' })).toBe('hotel');
  expect(placeKind({ leisure: 'sports_centre' })).toBe('sports');
  expect(placeKind({ building: 'college' })).toBe('university');
  // The amenity says it before the building does.
  expect(placeKind({ amenity: 'library', building: 'university' })).toBe('library');
  expect(placeKind({ amenity: 'parking' })).toBeNull();
  expect(placeKind({ building: 'house' })).toBeNull();
  expect(placeKind({})).toBeNull();
});

test('places come after every shop, and rank after them too', () => {
  const first = SHOP_KINDS.findIndex((k) => PLACES.has(k));
  expect(SHOP_KINDS.slice(first).every((k) => PLACES.has(k))).toBe(true);
  expect(PLACES.has('shop')).toBe(false);
  expect(main(['university', 'service'])).toBe('service');
  expect(SHOP_KINDS.every((k) => rank(k) >= 0)).toBe(true);
});
