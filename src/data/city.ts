/**
 * The city model the viewer renders. Coordinates are local metres around Grote Markt:
 * x = east, z = south (three.js: north is -z). Rings are flat [x0, z0, x1, z1, …] arrays,
 * counter-clockwise in (x, z), without a closing duplicate point.
 */

import type { Field, PitchSurface } from './pitches.ts';
import { surfaceOf } from './roads.ts';
import type { ShopKind } from './shop-kinds.ts';

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
  /** Its main shop front, the most telling of its `City.fronts` (src/data/shops.ts). */
  front?: ShopFront;
}

/**
 * A shop, café or bank on the ground floor, from OpenStreetMap (src/data/shops.ts): on its
 * building's wall that faces its street (src/data/facades.ts).
 */
export interface ShopFront {
  /** Its building's place in `City.buildings`. */
  building: number;
  /** The wall: the edge of the building's `ring` from corner `edge` to the next. */
  edge: number;
  /** Where along that wall it is centred (m from corner `edge`). */
  along: number;
  kind: ShopKind;
  /** OSM `outdoor_seating=yes`, with room on the pavement for a table and two chairs. */
  terrace: boolean;
}

/**
 * What a road, path or square is made of, as the map draws it: one table for every surface in
 * the city, from OSM's `surface` tag or the usual surface of a way's kind (`surfaceOf` in
 * src/data/roads.ts). Each has a colour (src/scene/palette.ts) and a texture (src/scene/paint.ts).
 */
export const SURFACES = [
  'asphalt',
  'concrete',
  'sett',
  'paving',
  'gravel',
  'earth',
  'grass',
] as const;
export type Surface = (typeof SURFACES)[number];
/** The surfaces a car drives at its cruise on; the rest slow it. */
export const PAVED: ReadonlySet<Surface> = new Set(['asphalt', 'concrete', 'sett', 'paving']);

/** A footpath, cycle path or park path, drawn as a ribbon on the ground. */
export interface Path {
  /** Full width in metres. */
  width: number;
  surface: Surface;
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

/** What a bridge or tunnel carries, which sets its clearance, its railing and who may use it. */
export const CARRIES = ['road', 'path', 'rail'] as const;
export type Carries = (typeof CARRIES)[number];

/** A cycle way on a deck is a ribbon this wide; the renderer draws it in the cycle lanes' red (m). */
export const CYCLE_LANE = 2;

/**
 * A bridge's deck: the GRB structure's outline where there is one (else the width of its OSM
 * ways), held up over the ground at `rise` metres above the terrain at each point of `axis`. A
 * road or path deck is a level of its own in the walk grid; a railway's stays at the terrain.
 */
export interface Deck {
  carries: Carries;
  /** Counter-clockwise outline, flat [x0, z0, x1, z1, …]. */
  ring: Float32Array;
  /** Centre line of the span, from one end past the other; `ends` of the deck are where it leaves. */
  axis: Float32Array;
  /** Metres above the terrain at each point of `axis`. */
  rise: Float32Array;
  /** Where its piers stand, flat [x, z, …]; none on a carriageway or a track. */
  piers: Float32Array;
  /** The road and cycle ways on it, as ribbons of their own surface. */
  lanes: Path[];
}

/**
 * A length of ground raised or sunk along a line, between retaining walls: the approach to a deck
 * or a tunnel, or a road dropping under a railway. Everything the map draws there follows it.
 */
export interface Ramp {
  /** Flat [x0, z0, x1, z1, …]. */
  line: Float32Array;
  /** Metres above the terrain at each point of `line`; negative in a cutting. */
  rise: Float32Array;
  /** Half its width (m). */
  half: number;
  /** How far it reaches to each side of `line` at each point, where a road's width varies (m). */
  left?: Float32Array;
  right?: Float32Array;
  /** Tracks run on it: only these move the railway. */
  rail: boolean;
}

/** A covered stretch below the ground, from portal to portal. */
export interface Tunnel {
  carries: Carries;
  line: Float32Array;
  /** Half its width (m). */
  half: number;
  /** How far its floor lies below the terrain (m). */
  depth: number;
  /** Whether each end of `line` opens to the air: its first point, its last. */
  mouths: [boolean, boolean];
}

/**
 * What lies on the road surface beside the pavement: the GRB surface cut along its kerbs
 * (tools/build_road_zones.py), named from the OSM ways on it (src/data/roads.ts) as a street, a
 * ring or main road, a cycle track or a pedestrian street, each with what it's made of.
 */
export const CARRIAGEWAY_KINDS = ['street', 'main', 'cycleway', 'pedestrian'] as const;
export type CarriagewayKind = (typeof CARRIAGEWAY_KINDS)[number];

export interface Carriageway {
  kind: CarriagewayKind;
  surface: Surface;
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
 * Street furniture, then monuments (from 'statue' on), from OpenStreetMap points
 * (src/data/props.ts, src/data/monuments.ts). All of them stand in the way: none is walkable.
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
  'bust',
  'group',
  'sculpture',
  'column',
  'stone',
] as const;
export type PropKind = (typeof PROP_KINDS)[number];
/** Monuments: the props that are art or memory, each an archetype (src/data/monuments.ts). */
export type MonumentKind = Exclude<PropKind, 'lamp' | 'bench' | 'bikes' | 'shelter' | 'busstop'>;
/** What a monument is made of, as drawn; a fountain of water has a jet in its basin. */
export const MATERIALS = [
  'bronze',
  'stone',
  'marble',
  'bluestone',
  'steel',
  'rust',
  'concrete',
  'wood',
  'brick',
  'water',
] as const;
export type Material = (typeof MATERIALS)[number];

/** What a bike rack is, as OSM's `bicycle_parking` says: the file stores its place in this list. */
export const RACK_STYLES = ['hoops', 'anchors', 'wall', 'informal', 'shed'] as const;
export type RackStyle = (typeof RACK_STYLES)[number];

/** What kind of tree it is, where OSM says; a tree only the LiDAR saw is `broad`. */
export const TREE_KINDS = ['broad', 'conifer', 'column', 'willow'] as const;
export type TreeKind = (typeof TREE_KINDS)[number];

export interface Prop {
  kind: PropKind;
  x: number;
  z: number;
  /** Which way it faces (radians from +x towards +z): towards the nearest kerb, path or wall. */
  angle: number;
  /** Stands in a bike rack; a monument's height, plinth included (m); else 0. */
  size: number;
  /** Bike racks only: the share of their stands that hold a bike (`rackFill`). */
  fill?: number;
  /** Bike racks only: what OSM says they're made of (`bicycle_parking`), and whether roofed. */
  rack?: RackStyle;
  covered?: boolean;
  /** Monuments only: their plinth or basin across (u) and along (v) their facing (m). */
  width?: number;
  depth?: number;
  /** Monuments only: what they're made of. */
  material?: Material;
}

/** Whether a prop is a monument, which carries its plinth and material. */
export const isMonument = (kind: PropKind): kind is MonumentKind =>
  PROP_KINDS.indexOf(kind) >= PROP_KINDS.indexOf('statue');

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

/**
 * The lie of the land (src/data/terrain.ts reads it as triangles): heights on a square grid,
 * node (i, j) at x = minX + i · step, z = minZ + j · step. The grid is anchored at Grote Markt:
 * `minX` and `minZ` are whole steps from it.
 */
export interface TerrainGrid {
  step: number;
  minX: number;
  minZ: number;
  cols: number;
  rows: number;
  /** Metres above the ground at Grote Markt, a row (along x) at a time. */
  heights: Float32Array;
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
  /** Paved traffic islands and footway areas in the road (`area:highway`), pale and raised. */
  islands: Float32Array[];
  /** Beds of flowers (OSM's `landuse=flowerbed`), drawn as soil and what grows on it. */
  flowerbeds: Float32Array[];
  /** Hedges, as flat [x0, z0, …] lines along where they grow. */
  hedges: Float32Array[];
  /** Sports pitches and running tracks. */
  pitches: Float32Array[];
  /** Each pitch's surface, in the order of `pitches` (src/data/pitches.ts). */
  pitchSurfaces: PitchSurface[];
  /** The lines painted on the pitches: soccer fields, tennis and basketball courts, track lanes. */
  fields: Field[];
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
  /** Each tree's place in `TREE_KINDS`. */
  treeKinds: Uint8Array;
  props: Prop[];
  tanks: Tank[];
  /** GRB bridge outlines left at the ground: what crosses them goes under in a tunnel. */
  bridges: Float32Array[];
  /** Bridges held up over what they cross, each a level of its own to walk on. */
  decks: Deck[];
  /** The ground raised or sunk along the approaches. */
  ramps: Ramp[];
  /** Covered roads, paths and tracks with a way in at both ends. */
  tunnels: Tunnel[];
  /** Bridge parapets: low walls along the sides of a bridge that face the water, as open lines. */
  parapets: Float32Array[];
  /** Every street and square name, sorted, each once (src/data/streets.ts). */
  streetNames: string[];
  streets: Street[];
  /** Each square's name in `streetNames`, in the order of `plazas`; -1 where it has none. */
  plazaNames: number[];
  /** The ground's height, smoothed to the landform: y = 0 is the ground at Grote Markt. */
  terrain: TerrainGrid;
  /** Shop fronts, by building, each building's main one first. */
  fronts: ShopFront[];
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
const PITCHED_SHARE = 0.4;

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
const ACROSS_SHARE = 0.65;

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
  return { width, surface: surfaceOf(tags) };
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
