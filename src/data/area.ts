/**
 * What the current build of the city covers. Grow the area here; the bake script and the
 * budget check (scripts/) keep the result fast. Local metres, x = east, z = south.
 */

import type { Bounds } from './city.ts';
import { boundsOf } from './geometry.ts';
import type { LabelRef } from './labels.ts';

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

/**
 * What gets a label, most important first: a label that would overlap an earlier one is hidden.
 * Each is an id, never a typed-in name or coordinate: the bake reads both from the data
 * (src/data/labels.ts), so a label moves and renames with OpenStreetMap. Each shows from
 * `minZoom` (default: always), so the far view names landmarks and big sites across the whole
 * map while churches, squares and small sights wait until there's room for them.
 */
export const LANDMARKS: readonly (LabelRef & { minZoom?: number })[] = [
  { wikidata: 'Q940882' }, // Stadhuis
  { wikidata: 'Q17722' }, // Sint-Pieterskerk
  { wikidata: 'Q4766627' }, // Oude Markt
  { wikidata: 'Q1519139' }, // Universiteitsbibliotheek
  { grb: 2870209 }, // Station Leuven: OSM's station node isn't in the dumps, its name is on the footprint
  { wikidata: 'Q1049301' }, // Groot Begijnhof
  { wikidata: 'Q1522076' }, // Arenbergkasteel
  { wikidata: 'Q476178' }, // Abdij van Park
  // The big green and industrial sites, to find your way from far out.
  { wikidata: 'Q1944313' }, // Vaartkom
  { osm: 'way/987152632' }, // Keizersberg
  { wikidata: 'Q2565202' }, // Kruidtuin
  { wikidata: 'Q2523485' }, // Brouwerij Stella Artois
  { osm: 'way/69413017' }, // Park Philipssite
  { wikidata: 'Q1502706' }, // Sint-Michielskerk
  { wikidata: 'Q2362660', minZoom: 1 }, // M-Museum
  { wikidata: 'Q2663022', minZoom: 1 }, // Sint-Donatuspark
  { osm: 'way/294999180', minZoom: 1 }, // Arenbergpark
  { wikidata: 'Q2107804', minZoom: 1 }, // Fonske
  // Churches and squares, once there's room.
  { wikidata: 'Q28946510', minZoom: 1.5 }, // Sint-Geertruikerk
  { wikidata: 'Q18380032', minZoom: 1.5 }, // Sint-Jacobskerk
  { wikidata: 'Q2289620', minZoom: 1.5 }, // Sint-Kwintenskerk
  { wikidata: 'Q2658903', minZoom: 2 }, // Martelarenplein
  { wikidata: 'Q6469401', minZoom: 2 }, // Monseigneur Ladeuzeplein
  { osm: 'way/48232563', minZoom: 2 }, // Hogeschoolplein
  { wikidata: 'Q2202491', minZoom: 2 }, // Vismarkt
  { wikidata: 'Q2491406', minZoom: 2 }, // Klein Begijnhof
  { wikidata: 'Q112622460', minZoom: 2 }, // De Bruul
  { wikidata: 'Q21771834', minZoom: 2 }, // Dijlepark
  { wikidata: 'Q2166249', minZoom: 2.5 }, // Rector De Somerplein
  { wikidata: 'Q22446282', minZoom: 2.5 }, // Totem
];
