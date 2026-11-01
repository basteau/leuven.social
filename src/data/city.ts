/**
 * The city model the viewer renders. Coordinates are local metres around Grote Markt:
 * x = east, z = south (three.js: north is -z). Rings are flat [x0, z0, x1, z1, …] arrays,
 * counter-clockwise in (x, z), without a closing duplicate point.
 */

export const TIERS = ['hero', 'core', 'fringe'] as const;
export type Tier = (typeof TIERS)[number];

export const KINDS = ['other', 'house', 'apartments', 'retail', 'civic', 'church', 'shed'] as const;
export type Kind = (typeof KINDS)[number];

/**
 * 'gabled' is any pitched roof; the renderer picks gable or hip from the footprint and puts a
 * gable's ridge along its long side. 'across' is a pitched roof whose slopes the LiDAR saw facing
 * along that side, so a gable's ridge runs across it: a terraced house on a deep plot, its ridge
 * parallel to the street (`roofAcross`).
 */
export const ROOFS = ['auto', 'flat', 'gabled', 'hipped', 'across'] as const;
export type Roof = (typeof ROOFS)[number];

/**
 * A church tower the LiDAR saw rising far over the nave: a square tower with a pointed spire, or
 * a slender spire on the ridge (a turret) when its walls end at the roof (`top` equals the
 * building's height).
 */
export interface Tower {
  /** Centre, local metres. */
  x: number;
  z: number;
  /** From the centre to a corner: a square tower of the area the LiDAR saw. */
  radius: number;
  /** Top of its walls and tip of its spire, metres above ground. */
  top: number;
  tip: number;
}

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
  /** A church's tower, where the LiDAR saw one. */
  tower?: Tower;
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

export const RAIL_KINDS = ['main', 'yard'] as const;
export type RailKind = (typeof RAIL_KINDS)[number];

/**
 * One railway track along its centre line: standard gauge, two rails 1.435 m apart. Rails are a
 * layer of their own so anything that moves on foot can keep off them; platforms are the part
 * of the railway people walk on.
 */
export interface Rail {
  /** A running line (main or branch, and the crossovers between them) or a yard or siding track. */
  kind: RailKind;
  /** Carried over a road or the water. */
  bridge: boolean;
  /** Under a contact wire, so catenary masts stand along it. */
  electrified: boolean;
  /** Centre line as flat [x0, z0, x1, z1, …]. */
  line: Float32Array;
}

/**
 * What lies on the road surface beside the pavement, and what it's made of: the GRB surface cut
 * along its kerbs (tools/build_road_zones.py), named from the OSM ways on it (src/data/roads.ts).
 * Pedestrian streets count, by their paving; so do cycle tracks.
 */
export const CARRIAGEWAY_KINDS = ['street', 'main', 'sett', 'paving', 'cycleway'] as const;
export type CarriagewayKind = (typeof CARRIAGEWAY_KINDS)[number];

export interface Carriageway {
  kind: CarriagewayKind;
  ring: Float32Array;
}

/** Paint on the carriageway: lane dividers, painted cycle lanes and crossings. */
export const MARKING_KINDS = ['dashed', 'solid', 'cycle-lane', 'zebra', 'bike-crossing'] as const;
export type MarkingKind = (typeof MARKING_KINDS)[number];

export interface Marking {
  kind: MarkingKind;
  /** A lane's centre line, or for crossings the line across the carriageway they follow. */
  line: Float32Array;
}

/** A named road, path or stretch of one, for the street sign: its name and its centre line. */
export interface Street {
  /** Where its name is in `City.streetNames`. */
  name: number;
  /** Centre line as flat [x0, z0, x1, z1, …]. */
  line: Float32Array;
}

/**
 * Street furniture and small monuments, from OpenStreetMap points (src/data/props.ts). All of
 * them stand in the way: none is walkable.
 */
export const PROP_KINDS = [
  'lamp',
  'bench',
  'bikes',
  'shelter',
  'busstop',
  'statue',
  'fountain',
  'pump',
  'needle',
] as const;
export type PropKind = (typeof PROP_KINDS)[number];

export interface Prop {
  kind: PropKind;
  x: number;
  z: number;
  /** Which way it faces (radians from +x towards +z): towards the nearest kerb, path or wall. */
  angle: number;
  /** Stands in a bike rack; a statue's or needle's tagged height (m); else 0. */
  size: number;
}

/** A tank or silo (GRB structures): its footprint and LiDAR height. Solid, so not walkable. */
export interface Tank {
  height: number;
  ring: Float32Array;
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
  buildings: Building[];
  /**
   * The whole road surface, facade to facade (GRB), all of it walkable. It's pavement wherever no
   * carriageway lies on it.
   */
  roads: Float32Array[];
  carriageways: Carriageway[];
  markings: Marking[];
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
  /** Railway tracks above ground. Not walkable: cross them only where a road or path does. */
  rails: Rail[];
  /** Railway platforms, raised to train-floor height. */
  platforms: Float32Array[];
  /** Railway land (OSM `landuse=railway`): the gravel and ballast around the tracks. */
  railLand: Float32Array[];
  /** Roofs over the platforms (GRB `afdak` on railway land), drawn as vaulted bays. */
  canopies: Float32Array[];
  /** Flat [x0, z0, x1, z1, …] tree positions. */
  trees: Float32Array;
  /** Height of each tree in metres, from the LiDAR canopy. */
  treeHeights: Float32Array;
  props: Prop[];
  tanks: Tank[];
  /** Bridge parapets: low walls along the sides of a bridge that face the water, as open lines. */
  parapets: Float32Array[];
  /** Every street and square name, sorted, each once (src/data/streets.ts). */
  streetNames: string[];
  streets: Street[];
  /** Each square's name in `streetNames`, in the order of `plazas`; -1 where it has none. */
  plazaNames: number[];
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

/**
 * How strongly a roof's slopes must face along the footprint's long side to turn its ridge across:
 * the share of their (squared) steepness along that side. Gables with the ridge along the long
 * side measure under 0.35, turned ones over 0.65; between is a hip, or a roof too broken to say.
 */
export const ACROSS_SHARE = 0.65;

/**
 * Turns a pitched roof's ridge across the footprint where its slopes face along the long side
 * (`facing` from tools/build_leuven_data.py: the axis they face, in degrees from x towards z, and
 * how strongly they keep to it, 0–1). `along` is the footprint's long side as a unit vector.
 */
export function roofAcross(
  roof: Roof,
  facing: readonly [number, number] | null | undefined,
  along: { ux: number; uz: number },
): Roof {
  if (roof !== 'gabled' || !facing) return roof;
  const [degrees, strength] = facing;
  const angle = (degrees * Math.PI) / 180;
  // The share along u of slopes spread round one axis: ½(1 + strength · cos 2Δ).
  const cos = Math.cos(angle) * along.ux + Math.sin(angle) * along.uz;
  const share = 0.5 * (1 + strength * (2 * cos * cos - 1));
  return share > ACROSS_SHARE ? 'across' : roof;
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

const YARD_SERVICES = new Set(['yard', 'siding', 'spur']);
const off = (value: string | undefined) => value === undefined || value === 'no';

/**
 * Which OSM ways are tracks worth drawing, and how. Tunnels, covered tracks and anything below
 * ground stay hidden, as do abandoned, razed and disused lines. Leuven maps one way per track,
 * all standard gauge.
 */
export function railFromOsm(tags: Record<string, string | undefined>): Omit<Rail, 'line'> | null {
  if (tags.railway !== 'rail') return null;
  if (!off(tags.tunnel) || !off(tags.covered) || tags.indoor === 'yes') return null;
  if (Number(tags.layer) < 0) return null;
  return {
    kind: YARD_SERVICES.has(tags.service ?? '') ? 'yard' : 'main',
    bridge: !off(tags.bridge),
    electrified: !off(tags.electrified),
  };
}
