/**
 * What the current build of the city covers. Grow the area here; the bake script and the
 * budget check (scripts/) keep the result fast. Local metres, x = east, z = south.
 */

import type { Bounds } from './city.ts';
import { boundsOf } from './geometry.ts';

/**
 * Abutting rectangles, never overlapping: everything inside the R23 ring with the station and
 * its whole track bundle and platform roof, then Heverlee from Arenbergpark and its castle
 * across to the Abdij van Park. About 8.9 km² in all.
 */
export const AREA: readonly Bounds[] = [
  { minX: -1400, minZ: -1220, maxX: 1300, maxZ: 1250 },
  { minX: -1500, minZ: 1250, maxX: 1450, maxZ: 2000 },
];

/**
 * GRB ids of the footprints that hand-fitted landmark models sit on (src/scene/landmark-models.ts),
 * with the Wikidata item each one is. The bake keeps them at full detail and in the hero tier,
 * wherever they stand.
 */
export const LANDMARK_FOOTPRINTS: readonly number[] = [
  2871416, // Stadhuis, Q940882
  2878488, // Sint-Pieterskerk, Q17722
  2871417, // Universiteitsbibliotheek, Q139854572
  2883895, // Arenbergkasteel, Q1522076
  5536465, // Abdij van Park, abbey church, Q476178
  2870209, // Station Leuven, Q801090
];

/** The rectangle around the whole area. */
export const VIEW_AREA: Bounds = boundsOf(AREA);
