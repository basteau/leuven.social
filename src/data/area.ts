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

/**
 * Labels, most important first: a label that would overlap an earlier one is hidden. Each shows
 * from `minZoom` (default: always), so the far view names landmarks and districts across the
 * whole map while churches, squares and small sights wait until there's room for them.
 */
export const LANDMARKS: readonly { name: string; lon: number; lat: number; minZoom?: number }[] = [
  { name: 'Stadhuis', lon: 4.70111, lat: 50.87889 },
  { name: 'Sint-Pieterskerk', lon: 4.70111, lat: 50.87944 },
  { name: 'Oude Markt', lon: 4.69944, lat: 50.87806 },
  { name: 'Universiteitsbibliotheek', lon: 4.70741, lat: 50.87801 },
  { name: 'Station Leuven', lon: 4.7152, lat: 50.8813 },
  { name: 'Groot Begijnhof', lon: 4.6975, lat: 50.872 },
  { name: 'Arenbergkasteel', lon: 4.6832, lat: 50.86333 },
  { name: 'Abdij van Park', lon: 4.7181, lat: 50.8641 },
  // Districts and the big green and industrial sites, to find your way from far out.
  { name: 'Heverlee', lon: 4.69333, lat: 50.86476 },
  { name: 'Vaartkom', lon: 4.7045, lat: 50.8878 },
  { name: 'Keizersberg', lon: 4.6972, lat: 50.88824 },
  { name: 'Kruidtuin', lon: 4.69004, lat: 50.8778 },
  { name: 'Brouwerij Stella Artois', lon: 4.71146, lat: 50.88887 },
  { name: 'Philipssite', lon: 4.71131, lat: 50.86829 },
  { name: 'Sint-Michielskerk', lon: 4.70056, lat: 50.87611 },
  { name: 'M Leuven', lon: 4.70444, lat: 50.87889, minZoom: 1 },
  { name: 'Sint-Donatuspark', lon: 4.70291, lat: 50.87555, minZoom: 1 },
  { name: 'Arenbergpark', lon: 4.6886, lat: 50.8656, minZoom: 1 },
  { name: 'Fonske', lon: 4.70194, lat: 50.87917, minZoom: 1 },
  // Churches and squares, once there's room.
  { name: 'Sint-Geertruikerk', lon: 4.69932, lat: 50.8841, minZoom: 1.5 },
  { name: 'Sint-Jacobskerk', lon: 4.69114, lat: 50.88053, minZoom: 1.5 },
  { name: 'Sint-Kwintenskerk', lon: 4.69857, lat: 50.87001, minZoom: 1.5 },
  { name: 'Martelarenplein', lon: 4.71513, lat: 50.88138, minZoom: 2 },
  { name: 'Ladeuzeplein', lon: 4.70656, lat: 50.87846, minZoom: 2 },
  { name: 'Hogeschoolplein', lon: 4.70173, lat: 50.87735, minZoom: 2 },
  { name: 'Vismarkt', lon: 4.69984, lat: 50.88149, minZoom: 2 },
  { name: 'Klein Begijnhof', lon: 4.699, lat: 50.88441, minZoom: 2 },
  { name: 'De Bruul', lon: 4.69545, lat: 50.88368, minZoom: 2 },
  { name: 'Dijlepark', lon: 4.69696, lat: 50.87376, minZoom: 2 },
  { name: 'Rector De Somerplein', lon: 4.70302, lat: 50.87916, minZoom: 2.5 },
  { name: 'Totem', lon: 4.70635, lat: 50.8786, minZoom: 2.5 },
];
