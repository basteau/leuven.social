/**
 * What the current build of the city covers. Grow the area here; the bake script and the
 * budget check (scripts/) keep the result fast. Local metres, x = east, z = south.
 */

import type { Bounds } from './city.ts';

/** Grote Markt, Oude Markt, Ladeuzeplein and the Dijle: about 1.2 × 0.85 km. */
export const VIEW_AREA: Bounds = { minX: -600, minZ: -400, maxX: 600, maxZ: 450 };

export const LANDMARKS: readonly { name: string; lon: number; lat: number }[] = [
  { name: 'Stadhuis', lon: 4.70111, lat: 50.87889 },
  { name: 'Sint-Pieterskerk', lon: 4.70111, lat: 50.87944 },
  { name: 'Oude Markt', lon: 4.69944, lat: 50.87806 },
  { name: 'Fonske', lon: 4.70194, lat: 50.87917 },
  { name: 'Universiteitsbibliotheek', lon: 4.70741, lat: 50.87801 },
  { name: 'M Leuven', lon: 4.70444, lat: 50.87889 },
  { name: 'Sint-Donatuspark', lon: 4.70291, lat: 50.87555 },
  { name: 'Sint-Michielskerk', lon: 4.70056, lat: 50.87611 },
];
