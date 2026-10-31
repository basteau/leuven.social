/**
 * What OSM's tags say about the road surface. tools/build_road_zones.py cuts the GRB road surface
 * along its kerbs and hands each face the tags of the way that runs along it; these decide how
 * the viewer paints it.
 */

import type { CarriagewayKind, MarkingKind } from './city.ts';

/** What runs along a carriageway face (see tools/build_road_zones.py). */
export type RoadRole = 'car' | 'pedestrian' | 'cycle';

const SETT = new Set(['sett', 'cobblestone', 'unhewn_cobblestone', 'cobblestone:flattened']);
const PAVING = new Set(['paving_stones', 'bricks', 'concrete:plates', 'stone', 'paving_stones:30']);
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

type Tags = Record<string, string | undefined>;

/**
 * A carriageway is asphalt (darker on main roads), setts or paving stones. Pedestrian streets are
 * paved unless they're cobbled, and cycle tracks are red.
 */
export function carriagewayKind(role: RoadRole, tags: Tags): CarriagewayKind {
  const surface = tags.surface ?? '';
  if (role === 'cycle') return 'cycleway';
  if (SETT.has(surface)) return 'sett';
  if (role === 'pedestrian' || PAVING.has(surface)) return 'paving';
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
