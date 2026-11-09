/**
 * What the current build of the city covers. Grow the area here; the bake script and the
 * budget check (scripts/) keep the result fast. Local metres, x = east, z = south.
 */

import type { Bounds } from './city.ts';
import { boundsOf } from './geometry.ts';

/**
 * Abutting rectangles, never overlapping, about 17.1 km² in all. Each side stands where the fewest
 * GRB footprints straddle it (a house across the edge isn't drawn at all), and past what it frames:
 * the Vaart up to the brewery, the whole of UZ Gasthuisberg to the E314, Campus Arenberg, the
 * protected domain of the Abdij van Park to its southern tip, and Heverleebos short of the E40.
 * Kessel-Lo is the densest ground here, so the map goes only 100 m into it.
 */
export const AREA: readonly Bounds[] = [
  // The Vaart and the railway beside it, from the Vaartkom north past the Stella Artois brewery.
  { minX: 20, minZ: -2190, maxX: 1080, maxZ: -1220 },
  // The R23 ring, the station and its whole track bundle.
  { minX: -1400, minZ: -1220, maxX: 1400, maxZ: 1250 },
  // UZ Gasthuisberg.
  { minX: -2460, minZ: -670, maxX: -1400, maxZ: 510 },
  // From Gasthuisberg down to Heverlee.
  { minX: -2120, minZ: 510, maxX: -1400, maxZ: 1250 },
  // Campus Arenberg, Arenbergpark and its castle, across to the abbey and its ponds.
  { minX: -2120, minZ: 1250, maxX: 2020, maxZ: 2000 },
  // Heverlee, the science park and the abbey's fields.
  { minX: -1420, minZ: 2000, maxX: 2020, maxZ: 3060 },
  // The edge of Heverleebos, stopping short of the E40.
  { minX: -1420, minZ: 3060, maxX: 780, maxZ: 3360 },
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
