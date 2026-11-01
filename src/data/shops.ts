/**
 * Shop fronts from OpenStreetMap: a house or block with a shop, café, bar or restaurant mapped
 * inside its footprint has one downstairs, so it is drawn as `retail` (a glazed ground floor
 * under an awning) even where its `building=*` tag only says it's a house.
 */

import type { Building, Kind } from './city.ts';
import { pointInRing } from './geometry.ts';

/** OSM `amenity=*` values that come with a shop window on the street. */
const STREET_AMENITIES = new Set(['restaurant', 'cafe', 'pub', 'bar', 'fast_food', 'ice_cream']);
/** Only these kinds turn into shops; churches, civic buildings and sheds keep theirs. */
const PROMOTED = new Set<Kind>(['house', 'apartments', 'other']);

/** Whether an OSM point's tags make it a shop front. */
export function isShopFront(tags: Record<string, string | undefined>): boolean {
  return tags.shop !== undefined || STREET_AMENITIES.has(tags.amenity ?? '');
}

/**
 * Turns buildings with a shop front point (flat [x, z, …]) inside them into `retail`, in
 * place. Returns how many changed.
 */
export function markShopFronts(buildings: Building[], points: ArrayLike<number>): number {
  const CELL = 50;
  const grid = new Map<string, number[]>();
  for (let i = 0; i < points.length; i += 2) {
    const key = `${Math.floor(points[i]! / CELL)},${Math.floor(points[i + 1]! / CELL)}`;
    grid.set(key, [...(grid.get(key) ?? []), i]);
  }
  let marked = 0;
  for (const b of buildings) {
    if (!PROMOTED.has(b.kind)) continue;
    let [minX, minZ, maxX, maxZ] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let k = 0; k < b.ring.length; k += 2) {
      [minX, maxX] = [Math.min(minX, b.ring[k]!), Math.max(maxX, b.ring[k]!)];
      [minZ, maxZ] = [Math.min(minZ, b.ring[k + 1]!), Math.max(maxZ, b.ring[k + 1]!)];
    }
    search: for (let i = Math.floor(minX / CELL); i <= Math.floor(maxX / CELL); i++) {
      for (let j = Math.floor(minZ / CELL); j <= Math.floor(maxZ / CELL); j++) {
        for (const p of grid.get(`${i},${j}`) ?? []) {
          if (pointInRing(b.ring, points[p]!, points[p + 1]!)) {
            b.kind = 'retail';
            marked++;
            break search;
          }
        }
      }
    }
  }
  return marked;
}
