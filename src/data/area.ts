/**
 * What the current build of the city covers. Grow the area here; the bake script and the
 * budget check (scripts/) keep the result fast. Local metres, x = east, z = south.
 */

import type { Bounds } from './city.ts';
import { boundsOf } from './geometry.ts';

/**
 * Abutting rectangles, never overlapping: everything inside the R23 ring with the station,
 * then Heverlee from Arenbergpark and its castle across to the Abdij van Park. About 8.5 km² in all.
 */
export const AREA: readonly Bounds[] = [
  { minX: -1400, minZ: -1220, maxX: 1150, maxZ: 1250 },
  { minX: -1500, minZ: 1250, maxX: 1450, maxZ: 2000 },
];

/**
 * GRB ids of the footprints that hand-fitted landmark models sit on (src/scene/landmark-models.ts).
 * The bake keeps them at full detail and in the hero tier, wherever they stand.
 */
export const LANDMARK_FOOTPRINTS: readonly number[] = [
  2871416, // Stadhuis
  2878488, // Sint-Pieterskerk
  2871417, // Universiteitsbibliotheek
  2883895, // Arenbergkasteel
  5536465, // Abdij van Park, abbey church
  2870209, // Station Leuven
];

/** The rectangle around the whole area. */
export const VIEW_AREA: Bounds = boundsOf(AREA);

export const LANDMARKS: readonly { name: string; lon: number; lat: number }[] = [
  { name: 'Stadhuis', lon: 4.70111, lat: 50.87889 },
  { name: 'Sint-Pieterskerk', lon: 4.70111, lat: 50.87944 },
  { name: 'Oude Markt', lon: 4.69944, lat: 50.87806 },
  { name: 'Fonske', lon: 4.70194, lat: 50.87917 },
  { name: 'Universiteitsbibliotheek', lon: 4.70741, lat: 50.87801 },
  { name: 'M Leuven', lon: 4.70444, lat: 50.87889 },
  { name: 'Station Leuven', lon: 4.7152, lat: 50.8813 },
  { name: 'Groot Begijnhof', lon: 4.6975, lat: 50.872 },
  { name: 'Arenbergkasteel', lon: 4.6832, lat: 50.86333 },
  { name: 'Abdij van Park', lon: 4.7181, lat: 50.8641 },
  { name: 'Sint-Donatuspark', lon: 4.70291, lat: 50.87555 },
  { name: 'Sint-Michielskerk', lon: 4.70056, lat: 50.87611 },
  { name: 'Arenbergpark', lon: 4.6886, lat: 50.8656 },
];
