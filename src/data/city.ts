/**
 * The city model the viewer renders. Coordinates are local metres around Grote Markt:
 * x = east, z = south (three.js: north is -z). Rings are flat [x0, z0, x1, z1, …] arrays,
 * counter-clockwise in (x, z), without a closing duplicate point.
 */

export const TIERS = ['hero', 'core', 'fringe'] as const;
export type Tier = (typeof TIERS)[number];

export const KINDS = ['other', 'house', 'apartments', 'retail', 'civic', 'church', 'shed'] as const;
export type Kind = (typeof KINDS)[number];

export const ROOFS = ['auto', 'flat', 'gabled', 'hipped'] as const;
export type Roof = (typeof ROOFS)[number];

export interface Building {
  id: number;
  tier: Tier;
  kind: Kind;
  roof: Roof;
  /** Roof top above ground in metres (LiDAR p90). */
  height: number;
  /** Where the roof starts (LiDAR p15), at most `height`; equal to it on flat roofs. */
  eave: number;
  /** Roof colour sampled from orthophotos as 0xRRGGBB, or null where none was sampled. */
  roofColor: number | null;
  ring: Float32Array;
  /** Courtyards: inner rings, clockwise in (x, z). */
  holes: Float32Array[];
}

/** A footpath, cycle path or park path, drawn as a ribbon on the ground. */
export interface Path {
  /** Full width in metres. */
  width: number;
  /** Paved (asphalt, setts, slabs) or a gravel or earth trail. */
  paved: boolean;
  /** Centre line as flat [x0, z0, x1, z1, …]. */
  line: Float32Array;
}

export interface Label {
  name: string;
  x: number;
  z: number;
}

export interface Bounds {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export interface City {
  /** Abutting rectangles that make up the map (see area.ts); `bounds` surrounds them. */
  area: Bounds[];
  bounds: Bounds;
  labels: Label[];
  buildings: Building[];
  roads: Float32Array[];
  plazas: Float32Array[];
  green: Float32Array[];
  water: Float32Array[];
  /** Woods and scrub: a darker floor under the trees. */
  woods: Float32Array[];
  /** Sports pitches. */
  pitches: Float32Array[];
  /** Car parks outside the road surface. */
  parking: Float32Array[];
  paths: Path[];
  /** Flat [x0, z0, x1, z1, …] tree positions. */
  trees: Float32Array;
  /** Height of each tree in metres, from the LiDAR canopy. */
  treeHeights: Float32Array;
}

const KIND_BY_OSM: Record<string, Kind> = {
  house: 'house',
  terrace: 'house',
  detached: 'house',
  semidetached_house: 'house',
  residential: 'house',
  apartments: 'apartments',
  dormitory: 'apartments',
  retail: 'retail',
  commercial: 'retail',
  office: 'retail',
  hotel: 'retail',
  church: 'church',
  cathedral: 'church',
  chapel: 'church',
  university: 'civic',
  college: 'civic',
  school: 'civic',
  public: 'civic',
  civic: 'civic',
  government: 'civic',
  townhall: 'civic',
  museum: 'civic',
  library: 'civic',
  shed: 'shed',
  garage: 'shed',
  garages: 'shed',
  roof: 'shed',
  carport: 'shed',
};

const ROOF_BY_OSM: Record<string, Roof> = {
  flat: 'flat',
  gabled: 'gabled',
  saltbox: 'gabled',
  double_saltbox: 'gabled',
  hipped: 'hipped',
  'half-hipped': 'hipped',
  pyramidal: 'hipped',
  mansard: 'hipped',
};

/** Maps an OSM `building=*` value to the few kinds the renderer styles differently. */
export function kindFromOsm(value: string | null | undefined): Kind {
  return (value && Object.hasOwn(KIND_BY_OSM, value) && KIND_BY_OSM[value]) || 'other';
}

/** Maps an OSM `roof:shape=*` value to the roofs the renderer can draw. */
export function roofFromOsm(value: string | null | undefined): Roof {
  return (value && Object.hasOwn(ROOF_BY_OSM, value) && ROOF_BY_OSM[value]) || 'auto';
}

/**
 * Share of a roof's LiDAR pixels sloped 15–60° above which it counts as pitched. Real flat
 * roofs stay under ~0.25 (parapets, rooftop plant); real pitched ones are mostly above 0.5.
 */
export const PITCHED_SHARE = 0.4;

/**
 * The roof to draw: an OSM `roof:shape` tag wins, then the LiDAR slope survey decides between
 * flat and pitched ('gabled' here; the renderer picks gable or hip from the footprint).
 * Without either, 'auto' lets the renderer guess from the building kind.
 */
export function roofFromSurvey(osm: string | null | undefined, pitchedShare?: number | null): Roof {
  const tagged = roofFromOsm(osm);
  if (tagged !== 'auto' || pitchedShare === null || pitchedShare === undefined) return tagged;
  return pitchedShare >= PITCHED_SHARE ? 'gabled' : 'flat';
}

/** Path widths by OSM `highway=*` where the way has no usable `width` tag (m). */
const PATH_WIDTH: Record<string, number> = {
  pedestrian: 4,
  track: 3,
  cycleway: 2.5,
  bridleway: 2.5,
  footway: 2,
  steps: 2,
  path: 1.5,
};
const UNPAVED = new Set([
  'unpaved',
  'compacted',
  'gravel',
  'fine_gravel',
  'pebblestone',
  'dirt',
  'earth',
  'ground',
  'grass',
  'sand',
  'mud',
  'woodchips',
]);

/**
 * Which OSM ways are paths worth drawing, and how. Roads are already GRB road surfaces, and
 * sidewalks and crossings lie inside them, so only paths of their own count: through parks,
 * along the Dijle, between blocks. Tunnels and indoor corridors stay hidden.
 */
export function pathFromOsm(tags: Record<string, string | undefined>): Omit<Path, 'line'> | null {
  const highway = tags.highway ?? '';
  if (!Object.hasOwn(PATH_WIDTH, highway)) return null;
  if (tags.area === 'yes' || tags.indoor === 'yes' || tags.tunnel === 'yes') return null;
  if (tags.footway === 'sidewalk' || tags.footway === 'crossing') return null;
  if (tags.cycleway === 'crossing' || Number(tags.layer) < 0) return null;
  const tagged = Number.parseFloat(tags.width ?? '');
  const width = tagged > 0.5 && tagged < 12 ? tagged : PATH_WIDTH[highway]!;
  // Untagged paths: a park path is a trail, a footway in town is paved.
  const surface = tags.surface ?? (highway === 'path' || highway === 'track' ? 'ground' : 'paved');
  return { width, paved: !UNPAVED.has(surface) };
}
