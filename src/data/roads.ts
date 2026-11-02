/**
 * What OSM's tags say about the road surface. tools/build_road_zones.py cuts the GRB road surface
 * along its kerbs and hands each face the tags of the way that runs along it; these decide how
 * the viewer paints it.
 */

import type { CarriagewayKind, MarkingKind, Surface } from './city.ts';

/** What runs along a carriageway face (see tools/build_road_zones.py). */
export type RoadRole = 'car' | 'pedestrian' | 'cycle';

type Tags = Record<string, string | undefined>;

/** OSM `surface` values, each to the surface the map draws (`SURFACES` in city.ts). */
const SURFACE_OF_TAG: Record<string, Surface> = {
  asphalt: 'asphalt',
  paved: 'asphalt',
  chipseal: 'asphalt',
  concrete: 'concrete',
  'concrete:lanes': 'concrete',
  sett: 'sett',
  cobblestone: 'sett',
  unhewn_cobblestone: 'sett',
  'cobblestone:flattened': 'sett',
  paving_stones: 'paving',
  'paving_stones:30': 'paving',
  bricks: 'paving',
  'concrete:plates': 'paving',
  stone: 'paving',
  gravel: 'gravel',
  fine_gravel: 'gravel',
  compacted: 'gravel',
  pebblestone: 'gravel',
  unpaved: 'earth',
  dirt: 'earth',
  earth: 'earth',
  ground: 'earth',
  mud: 'earth',
  sand: 'earth',
  woodchips: 'earth',
  rock: 'earth',
  grass: 'grass',
  grass_paver: 'grass',
};
/** Without a surface tag, what a way of each kind is usually made of; any other way is asphalt. */
const USUAL: Record<string, Surface> = {
  track: 'earth',
  path: 'earth',
  bridleway: 'earth',
  footway: 'paving',
  steps: 'paving',
  pedestrian: 'paving',
};

/**
 * What a way is made of, from its `surface` tag (the first of several), else what its kind
 * usually is: a track or a park path earth, a footway or a pedestrian street paving stones, a
 * road asphalt. One rule for every road, path and square, so a dirt road is drawn as dirt.
 */
export function surfaceOf(tags: Tags): Surface {
  const tagged = tags.surface?.split(';')[0]?.trim() ?? '';
  return SURFACE_OF_TAG[tagged] ?? USUAL[tags.highway ?? ''] ?? 'asphalt';
}
/** Ring and through roads: darker asphalt, with lane markings. */
const MAIN = new Set([
  'motorway',
  'motorway_link',
  'trunk',
  'trunk_link',
  'primary',
  'primary_link',
  'secondary',
  'secondary_link',
]);

/**
 * What a carriageway is for: a cycle track, a pedestrian street, a ring or main road (darker
 * asphalt, lane markings) or any other street. What it's made of is `surfaceOf`.
 */
export function carriagewayKind(role: RoadRole, tags: Tags): CarriagewayKind {
  if (role === 'cycle') return 'cycleway';
  if (role === 'pedestrian') return 'pedestrian';
  return MAIN.has(tags.highway ?? '') ? 'main' : 'street';
}

const ZEBRA = new Set(['zebra', 'zebra:bicolour', 'zebra:double', 'yes', 'rainbow', 'surface']);
const BIKE = new Set(['dashes', 'dots']);
const MARKED = new Set(['zebra', 'marked', 'uncontrolled', 'traffic_signals']);

/**
 * The paint on a crossing: zebra stripes for people, two rows of blocks for bikes (the Belgian
 * cyclist crossing), or none. `crossing:markings` says it outright; otherwise a marked, uncontrolled
 * or signalled crossing is striped, as Belgian ones are.
 */
export function crossingMarking(
  tags: Tags,
): Extract<MarkingKind, 'zebra' | 'bike-crossing'> | null {
  const markings = tags['crossing:markings'];
  const bike = tags.highway === 'cycleway' || tags.cycleway === 'crossing';
  if (markings !== undefined) {
    if (ZEBRA.has(markings)) return bike && markings === 'yes' ? 'bike-crossing' : 'zebra';
    return BIKE.has(markings) ? 'bike-crossing' : null;
  }
  if (!MARKED.has(tags.crossing ?? '')) return null;
  return bike ? 'bike-crossing' : 'zebra';
}
