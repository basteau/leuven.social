/**
 * What the current build of the city covers. Grow the area here; the bake script and the
 * budget check (scripts/) keep the result fast. Local metres, x = east, z = south.
 */

import type { Bounds, Label } from './city.ts';
import { boundsOf } from './geometry.ts';
import { toLocal } from './projection.ts';

/**
 * Abutting rectangles, never overlapping: everything inside the R23 ring with the station,
 * then Heverlee from Arenbergpark and its castle across to the Abdij van Park. About 8.5 km² in all.
 */
export const AREA: readonly Bounds[] = [
  { minX: -1400, minZ: -1220, maxX: 1150, maxZ: 1250 },
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
 * A label names a Wikidata item, and the bake places it at the item's coordinates (P625, from
 * the `wikidata-labels` download), or on the GRB footprint of the building it names. A place
 * without an item gives its own position and says where it comes from: docs/DATA.md lists
 * these under Exceptions.
 */
export type Landmark = { name: string } & (
  { wikidata: string; footprint?: number } | { lon: number; lat: number; source: string }
);

export const LANDMARKS: readonly Landmark[] = [
  { name: 'Stadhuis', wikidata: 'Q940882' },
  { name: 'Sint-Pieterskerk', wikidata: 'Q17722' },
  { name: 'Oude Markt', wikidata: 'Q2792167' },
  { name: 'Fonske', wikidata: 'Q2107804' },
  { name: 'Universiteitsbibliotheek', wikidata: 'Q139854572' },
  { name: 'M Leuven', wikidata: 'Q2362660' },
  // Wikidata's point is on the tracks; the label belongs on the station building.
  { name: 'Station Leuven', wikidata: 'Q801090', footprint: 2870209 },
  { name: 'Groot Begijnhof', wikidata: 'Q1049301' },
  { name: 'Arenbergkasteel', wikidata: 'Q1522076' },
  { name: 'Abdij van Park', wikidata: 'Q476178' },
  { name: 'Sint-Donatuspark', wikidata: 'Q2663022' },
  { name: 'Sint-Michielskerk', wikidata: 'Q1502706' },
  {
    name: 'Arenbergpark',
    lon: 4.6886,
    lat: 50.8656,
    source: "No Wikidata item: the middle of the park's lawn on the orthophoto",
  },
];

/** The Wikidata items the labels need, sorted, each once. */
export const LANDMARK_ITEMS: readonly string[] = [
  ...new Set(LANDMARKS.flatMap((l) => ('wikidata' in l ? [l.wikidata] : []))),
].toSorted();

/**
 * Where each label goes, in local metres: on its footprint's centre, at its item's coordinates,
 * or where it says.
 */
export function placeLandmarks(
  landmarks: readonly Landmark[],
  items: Readonly<Record<string, { lon: number; lat: number }>>,
  footprintCentre: (id: number) => readonly [number, number] | undefined,
): Label[] {
  return landmarks.map((l) => {
    if (!('wikidata' in l)) return label(l.name, toLocal(l.lon, l.lat));
    if (l.footprint !== undefined) {
      const centre = footprintCentre(l.footprint);
      if (!centre) throw new Error(`${l.name}: footprint ${l.footprint} is not in the city`);
      return label(l.name, centre);
    }
    const item = items[l.wikidata];
    if (!item) {
      throw new Error(`No coordinates for ${l.name} (${l.wikidata}): run bun run data:fetch`);
    }
    return label(l.name, toLocal(item.lon, item.lat));
  });
}

const label = (name: string, [x, z]: readonly [number, number]): Label => ({ name, x, z });
