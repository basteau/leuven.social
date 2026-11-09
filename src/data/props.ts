/**
 * Street furniture and monuments from OpenStreetMap points: lamps, benches, bike racks, bus
 * stops, and the statues, sculptures, memorials, fountains and pumps of src/data/monuments.ts.
 * They are what makes a street read as a street at zoom 2–4. A point has neither a size nor a
 * direction, so each kind gets a footprint and a rule (`placeProps`): what it may stand on, how
 * much room it keeps, and which way it turns. Benches and racks drawn as ways bring the way they
 * run (`_bearing`) and their length (`_length`), and monuments their plinth, from
 * tools/build_leuven_data.py.
 */

import { isMonument } from './city.ts';
import type { Material, Prop, PropKind, RackStyle } from './city.ts';
import { pointInRing } from './geometry.ts';
import { monumentFromOsm, plinthOf } from './monuments.ts';

type Tags = Record<string, string | undefined>;

/** Bike racks hold at most this many stands in the model: two rows of twelve. */
export const MAX_STANDS = 24;
/** Stands in a rack whose capacity isn't tagged: a typical Leuven pavement rack. */
export const DEFAULT_STANDS = 6;
/** Stands per row; bigger racks get a second row, back to back. */
export const ROW = 12;
export const STAND_SPACING = 0.7;
/**
 * How much larger than life street furniture is drawn: at life size a lamp post or a bike is a
 * pixel or two even zoomed in. Monuments are drawn at the size src/data/monuments.ts gives them,
 * measured where it can, never under a few pixels.
 */
export const propScale = (kind: PropKind): number => (isMonument(kind) ? 1 : 1.3);

/** Racks we can't see from above: in a basement, a building or behind doors. */
const HIDDEN_RACKS = new Set(['underground', 'indoor']);
/** Lamps without a post of their own: on a façade, or hung over the street. */
const POSTLESS_MOUNTS = new Set(['wall', 'suspended', 'wire', 'ceiling']);
const POSTLESS_SUPPORTS = new Set(['wall_mounted', 'suspended', 'wire', 'ceiling']);
/** Kinds whose OSM `direction` says which way they face: a bench's sitter, a lamp's light. */
const DIRECTED = (kind: PropKind) => kind === 'bench' || kind === 'lamp' || isMonument(kind);
/** Kinds drawn along the way they're mapped as, when they are: a long bench, a row of stands. */
const RUNS = new Set<PropKind>(['bench', 'bikes']);
const POINTS = /* @__PURE__ */ 'N NNE NE ENE E ESE SE SSE S SSW SW WSW W WNW NW NNW'.split(' ');

/**
 * An OSM `direction` (degrees clockwise from north, or a compass point) as a turn in the map's
 * frame: radians from +x (east) towards +z (south). Null when there is none or it's a range.
 */
export function directionFromOsm(tag: string | undefined): number | null {
  if (tag === undefined) return null;
  const point = POINTS.indexOf(tag.trim().toUpperCase());
  const degrees =
    point >= 0 ? point * 22.5 : /^-?\d+(\.\d+)?$/.test(tag.trim()) ? Number(tag) : NaN;
  if (Number.isNaN(degrees)) return null;
  const bearing = (degrees * Math.PI) / 180;
  return Math.atan2(-Math.cos(bearing), Math.sin(bearing));
}

/** What `propFromOsm` reads off a point. */
export interface PropStyle {
  kind: PropKind;
  size: number;
  /** A tagged direction (a turn), for the kinds that face one way. */
  facing: number | null;
  /** The way it runs (a turn): a bench or rack drawn as a way, a monument's mapped plinth. */
  axis: number | null;
  width?: number;
  depth?: number;
  material?: Material;
  rack?: RackStyle;
  covered?: boolean;
}

/**
 * Which OSM points are props, and how big. Monuments are read by src/data/monuments.ts first. A
 * tagged direction counts for the kinds that face one way (`facing`, else null). A bench or rack
 * drawn as a way runs along it, and a monument along its plinth (`axis`, the turn of
 * `_bearing`, else null), and a bench line's `side` is the one its sitter faces: OSM leaves
 * `side` on benches undefined, and read this way the only ones that have it (Martelarenplein's,
 * round two low blocks) face out onto the square.
 */
export function propFromOsm(tags: Tags): PropStyle | null {
  const monument = monumentFromOsm(tags);
  const style = monument ?? styleFromOsm(tags);
  if (!style) return null;
  const axis = directionFromOsm(
    monument ? monument.bearing : RUNS.has(style.kind) ? tags['_bearing'] : undefined,
  );
  const facing =
    (DIRECTED(style.kind) ? directionFromOsm(tags.direction) : null) ??
    (style.kind === 'bench' && axis !== null ? sideOf(axis, tags.side) : null);
  if (!monument) return { ...style, facing, axis };
  const { kind, size, width, depth, material } = monument;
  return { kind, size, facing, axis, width, depth, material };
}

/** The turn to the left or right of a run (the map's turn is clockwise seen from above). */
function sideOf(axis: number, side: string | undefined): number | null {
  if (side !== 'left' && side !== 'right') return null;
  return axis + (side === 'right' ? Math.PI / 2 : -Math.PI / 2);
}

/**
 * Stands in a rack drawn as a way `length` metres long with no capacity: as many as fill it
 * when drawn, in one row.
 */
export function standsAlong(length: number): number {
  const stands = Math.round((length / propScale('bikes') - 2 * HANDLEBAR) / STAND_SPACING) + 1;
  return Math.min(Math.max(stands, 2), ROW);
}

/** What a rack is made of, by OSM's `bicycle_parking`: hoops unless it says otherwise. */
export function rackStyleOf(tag: string | undefined): RackStyle {
  if (tag === 'anchors') return 'anchors';
  if (tag === 'wall_loops' || tag === 'wall_hoops') return 'wall';
  if (tag === 'informal') return 'informal';
  if (tag === 'shed') return 'shed';
  return 'hoops';
}

function styleFromOsm(
  tags: Tags,
): { kind: PropKind; size: number; rack?: RackStyle; covered?: boolean } | null {
  if (tags.amenity === 'bench') return { kind: 'bench', size: 0 };
  if (tags.amenity === 'bicycle_parking') {
    if (HIDDEN_RACKS.has(tags.location ?? '') || tags.bicycle_parking === 'building') return null;
    const capacity = Number.parseInt(tags.capacity ?? '', 10);
    // A single loop, mostly at a house's door: too small to read as a rack, so not drawn.
    if (capacity === 1) return null;
    const length = Number.parseFloat(tags['_length'] ?? '');
    const stands = capacity > 0 ? capacity : length > 0 ? standsAlong(length) : DEFAULT_STANDS;
    const rack = rackStyleOf(tags.bicycle_parking);
    const covered = tags.covered === 'yes' || rack === 'shed';
    return { kind: 'bikes', size: Math.min(Math.max(stands, 2), MAX_STANDS), rack, covered };
  }
  if (tags.highway === 'bus_stop')
    return { kind: tags.shelter === 'yes' ? 'shelter' : 'busstop', size: 0 };
  if (tags.highway === 'street_lamp') {
    const postless =
      POSTLESS_MOUNTS.has(tags.lamp_mount ?? '') || POSTLESS_SUPPORTS.has(tags.support ?? '');
    return postless ? null : { kind: 'lamp', size: 0 };
  }
  return null;
}

/**
 * A footprint on the ground: its centre, its facing (a unit vector) and how far it reaches across
 * (u) and along (v) that facing. Each prop is drawn in this frame (src/scene/props.ts).
 */
export interface Footprint {
  x: number;
  z: number;
  fx: number;
  fz: number;
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}

/**
 * What each model covers below head height, at life size (m): across its facing (u), then along
 * it (v, + is the way it faces). A bench keeps room for the legs in front of its seat; a lamp's
 * lantern hangs above it all. src/scene/props.test.ts checks every model stays inside.
 */
const EXTENT: Record<'lamp' | 'bench' | 'shelter' | 'busstop', [number, number, number, number]> = {
  lamp: [-0.12, 0.12, -0.12, 0.12],
  bench: [-0.9, 0.9, -0.25, 0.7],
  shelter: [-1.6, 1.6, -0.75, 0.75],
  busstop: [-0.1, 0.1, -0.3, 0.3],
};
/**
 * Half a parked bike's length, whatever it carries and however its front wheel is turned, and
 * how far it may stand off its stand (m). src/scene/props.test.ts checks every look fits.
 */
export const BIKE_HALF_LENGTH = 0.9;
export const BIKE_SHIFT = 0.15;
/** What a rack's end bikes reach past their stand: half a handlebar, turned and off square (m). */
export const HANDLEBAR = 0.3;
/** A rack's second row stands this far behind the first (m). */
export const ROW_GAP = 0.9;

/** How a rack of this many stands is laid out: rows back to back, stands along the kerb. */
export function rackRows(stands: number): { rows: number; perRow: number } {
  const rows = stands > ROW ? 2 : 1;
  return { rows, perRow: Math.ceil(stands / rows) };
}

/** Small integer hash in [0, 1), so a rack's bikes and their looks stay put across rebakes. */
export const propHash = (a: number, b: number): number => {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b, 0xc2b2ae35);
  h ^= h >>> 15;
  return (Math.imul(h, 0x27d4eb2d) >>> 0) / 2 ** 32;
};
/** A prop's seed, from where it stands. */
export const propSeed = (x: number, z: number): number => Math.round(x * 7) ^ Math.round(z * 13);

/** How full a rack is, by where it stands (`rackFill`). */
export type FillClass = 'station' | 'hotspot' | 'private' | 'busy' | 'quiet';
/**
 * The share of a rack's stands that hold a bike, by class: Leuven's station racks are packed, a
 * square of racks by the faculties well used, a pavement rack in a quiet street a third full,
 * and one behind a gate (`access=private`, `customers`, `permit`) mostly empty.
 */
export const FILL: Record<FillClass, number> = {
  station: 0.85,
  hotspot: 0.65,
  private: 0.2,
  busy: 0.45,
  quiet: 0.3,
};
/** Racks this close to the station (the middle of its platform roofs) are station racks (m). */
export const STATION_REACH = 300;
/** How far round a rack its neighbours' stands count (m), and how many make it busy or a hotspot. */
export const NEAR_REACH = 60;
export const BUSY_STANDS = 50;
export const HOTSPOT_STANDS = 90;
/** Bikes drawn in one rack outside the station: a long rack in a quiet street isn't a car park. */
export const MAX_BIKES = 10;
const RESTRICTED = new Set(['private', 'customers', 'permit']);

/** What `rackFill` reads off a rack: where it stands, its stands, its OSM `access`. */
export interface RackSite {
  x: number;
  z: number;
  size: number;
  access?: string | undefined;
}

/**
 * How full each rack is, by where it stands: its class (see `FILL`), checked in that order, and
 * how many bikes it holds. The count is the class's share of its stands, rounded up or down at
 * random (seeded by where it stands) so the shares hold on average, and at most `MAX_BIKES`
 * outside the station. Stands within `NEAR_REACH` count the rack's own. Without a station (no
 * platform roofs) no rack is a station rack.
 */
export function rackFill(
  racks: readonly RackSite[],
  station: readonly [number, number] | null,
): { class: FillClass; bikes: number }[] {
  return racks.map((r) => {
    let near = 0;
    for (const q of racks) {
      if (Math.hypot(q.x - r.x, q.z - r.z) <= NEAR_REACH) near += q.size;
    }
    const kind: FillClass =
      station && Math.hypot(r.x - station[0], r.z - station[1]) <= STATION_REACH
        ? 'station'
        : near >= HOTSPOT_STANDS
          ? 'hotspot'
          : RESTRICTED.has(r.access ?? '')
            ? 'private'
            : near >= BUSY_STANDS
              ? 'busy'
              : 'quiet';
    const share = r.size * FILL[kind] + propHash(propSeed(r.x, r.z), 99);
    const most = kind === 'station' ? r.size : Math.min(r.size, MAX_BIKES);
    return { class: kind, bikes: Math.min(most, Math.floor(share)) };
  });
}

/** Bikes in a rack, from its fill (a share of its stands). */
export const bikesIn = (p: Prop): number => Math.round((p.fill ?? 0) * p.size);

/** Where a prop stands and what it covers, drawn to scale: a monument its plinth or basin. */
export function propFootprint(p: Prop): Footprint {
  let [u0, u1, v0, v1] = p.kind === 'bikes' ? rackExtent(p.size) : extent(p);
  const s = propScale(p.kind);
  [u0, u1, v0, v1] = [u0 * s, u1 * s, v0 * s, v1 * s];
  return { x: p.x, z: p.z, fx: Math.cos(p.angle), fz: Math.sin(p.angle), u0, u1, v0, v1 };
}

function extent(p: Prop): [number, number, number, number] {
  if (!isMonument(p.kind)) return EXTENT[p.kind as keyof typeof EXTENT];
  const [w, d] = p.width && p.depth ? [p.width, p.depth] : plinthOf(p.kind, p.size);
  return [-w / 2, w / 2, -d / 2, d / 2];
}

function rackExtent(stands: number): [number, number, number, number] {
  const { rows, perRow } = rackRows(stands);
  const across = ((perRow - 1) / 2) * STAND_SPACING + HANDLEBAR;
  const along = BIKE_HALF_LENGTH + BIKE_SHIFT + (rows === 2 ? ROW_GAP : 0);
  return [-across, across, -along, along];
}

const grow = (f: Footprint, by: number): Footprint => ({
  ...f,
  u0: f.u0 - by,
  u1: f.u1 + by,
  v0: f.v0 - by,
  v1: f.v1 + by,
});

/** A point in a footprint's own frame: across (u) and along (v) its facing. */
const local = (f: Footprint, x: number, z: number): [u: number, v: number] => {
  const [dx, dz] = [x - f.x, z - f.z];
  return [-dx * f.fz + dz * f.fx, dx * f.fx + dz * f.fz];
};

const corners = (f: Footprint): [number, number][] =>
  [
    [f.u0, f.v0],
    [f.u1, f.v0],
    [f.u1, f.v1],
    [f.u0, f.v1],
  ].map(([u, v]) => [f.x - f.fz * u! + f.fx * v!, f.z + f.fx * u! + f.fz * v!]);

/** The part of a segment inside a footprint, as [t0, t1] along it, or null (Liang–Barsky). */
function clipToFootprint(
  f: Footprint,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): [number, number] | null {
  const [ua, va] = local(f, ax, az);
  const [ub, vb] = local(f, bx, bz);
  let [t0, t1] = [0, 1];
  for (const [p, q] of [
    [ua - ub, ua - f.u0],
    [ub - ua, f.u1 - ua],
    [va - vb, va - f.v0],
    [vb - va, f.v1 - va],
  ] as const) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return null;
  }
  return [t0, t1];
}

/** Whether a line segment crosses or lies in a footprint. */
export function segmentInFootprint(
  f: Footprint,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): boolean {
  return clipToFootprint(f, ax, az, bx, bz) !== null;
}

/** Whether two footprints overlap: no gap along any of their four sides (separating axes). */
export function footprintsOverlap(a: Footprint, b: Footprint): boolean {
  const [ca, cb] = [corners(a), corners(b)];
  for (const [ax, az] of [
    [a.fx, a.fz],
    [-a.fz, a.fx],
    [b.fx, b.fz],
    [-b.fz, b.fx],
  ] as const) {
    const project = (c: [number, number][]) => c.map(([x, z]) => x * ax + z * az);
    const [pa, pb] = [project(ca), project(cb)];
    if (Math.max(...pa) < Math.min(...pb) || Math.max(...pb) < Math.min(...pa)) return false;
  }
  return true;
}

/** Whether a disc (a tree trunk), or with no radius a point, lies in a footprint. */
export function discInFootprint(f: Footprint, x: number, z: number, radius: number): boolean {
  const [u, v] = local(f, x, z);
  const du = u - Math.min(Math.max(u, f.u0), f.u1);
  const dv = v - Math.min(Math.max(v, f.v0), f.v1);
  return du * du + dv * dv < radius * radius || (du === 0 && dv === 0);
}

/** Whether an edge of these shapes (a wall, a kerb) lies between two points. */
function edgeBetween(shapes: Shapes, ax: number, az: number, bx: number, bz: number): boolean {
  const reach = Math.hypot(bx - ax, bz - az) / 2 + 0.1;
  return shapes.edges.some((ax + bx) / 2, (az + bz) / 2, reach, (cx, cz, dx, dz) =>
    crosses(ax, az, bx, bz, cx, cz, dx, dz),
  );
}

/** Which side of the line pq a point r lies. */
const side = (px: number, pz: number, qx: number, qz: number, rx: number, rz: number) =>
  Math.sign((qx - px) * (rz - pz) - (qz - pz) * (rx - px));

/** Whether segment ab crosses segment cd. */
function crosses(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
  dx: number,
  dz: number,
): boolean {
  return (
    side(ax, az, bx, bz, cx, cz) !== side(ax, az, bx, bz, dx, dz) &&
    side(cx, cz, dx, dz, ax, az) !== side(cx, cz, dx, dz, bx, bz)
  );
}

/** Bucket keys for a grid cell; coordinates within ±32,768 cells. */
const key = (i: number, j: number) => (i + 32768) * 65536 + (j + 32768);

function* cellsAround(size: number, x: number, z: number, reach: number): Generator<number> {
  for (let i = Math.floor((x - reach) / size); i <= Math.floor((x + reach) / size); i++) {
    for (let j = Math.floor((z - reach) / size); j <= Math.floor((z + reach) / size); j++) {
      yield key(i, j);
    }
  }
}

/**
 * Line segments bucketed on a square grid, for "what's the nearest edge to here" over the
 * whole city's kerbs, paths and walls without testing every one of them.
 */
export class EdgeIndex {
  readonly #size: number;
  readonly #cells = new Map<number, number[]>();

  constructor(size = 16) {
    this.#size = size;
  }

  segment(ax: number, az: number, bx: number, bz: number): void {
    const s = this.#size;
    for (let i = Math.floor(Math.min(ax, bx) / s); i <= Math.floor(Math.max(ax, bx) / s); i++) {
      for (let j = Math.floor(Math.min(az, bz) / s); j <= Math.floor(Math.max(az, bz) / s); j++) {
        const k = key(i, j);
        const list = this.#cells.get(k);
        if (list) list.push(ax, az, bx, bz);
        else this.#cells.set(k, [ax, az, bx, bz]);
      }
    }
  }

  /** A closed ring's edges, or (`closed` false) an open line's. */
  add(points: ArrayLike<number>, closed = true): void {
    const n = points.length;
    const last = closed ? n : n - 2;
    for (let i = 0; i < last; i += 2) {
      const j = (i + 2) % n;
      this.segment(points[i]!, points[i + 1]!, points[j]!, points[j + 1]!);
    }
  }

  /** Whether any edge within `reach` of (x, z) passes `test`. */
  some(
    x: number,
    z: number,
    reach: number,
    test: (ax: number, az: number, bx: number, bz: number) => boolean,
  ): boolean {
    for (const k of cellsAround(this.#size, x, z, reach)) {
      const list = this.#cells.get(k) ?? [];
      for (let i = 0; i < list.length; i += 4) {
        if (test(list[i]!, list[i + 1]!, list[i + 2]!, list[i + 3]!)) return true;
      }
    }
    return false;
  }

  /**
   * The nearest point on any edge within `reach` metres: the offset to it from (x, z), and the
   * direction of its edge. Null when nothing is that close.
   */
  nearest(x: number, z: number, reach: number): Nearest | null {
    let best: Nearest | null = null;
    this.some(x, z, reach, (ax, az, bx, bz) => {
      const [ex, ez] = [bx - ax, bz - az];
      const length2 = ex * ex + ez * ez;
      if (length2 < 1e-12) return false;
      const t = Math.min(1, Math.max(0, ((x - ax) * ex + (z - az) * ez) / length2));
      const [dx, dz] = [ax + ex * t - x, az + ez * t - z];
      const distance = Math.hypot(dx, dz);
      if (distance > reach || (best && distance >= best.distance)) return false;
      const length = Math.sqrt(length2);
      best = { dx, dz, distance, ux: ex / length, uz: ez / length };
      return false;
    });
    return best;
  }
}

export interface Nearest {
  dx: number;
  dz: number;
  distance: number;
  ux: number;
  uz: number;
}

/** Rings bucketed by their bounding boxes, for "is this point inside any of them". */
export class RingIndex {
  readonly #size: number;
  readonly #cells = new Map<number, ArrayLike<number>[]>();

  constructor(size = 32) {
    this.#size = size;
  }

  add(ring: ArrayLike<number>): void {
    let [minX, minZ, maxX, maxZ] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let k = 0; k < ring.length; k += 2) {
      [minX, maxX] = [Math.min(minX, ring[k]!), Math.max(maxX, ring[k]!)];
      [minZ, maxZ] = [Math.min(minZ, ring[k + 1]!), Math.max(maxZ, ring[k + 1]!)];
    }
    const s = this.#size;
    for (let i = Math.floor(minX / s); i <= Math.floor(maxX / s); i++) {
      for (let j = Math.floor(minZ / s); j <= Math.floor(maxZ / s); j++) {
        const k = key(i, j);
        const list = this.#cells.get(k);
        if (list) list.push(ring);
        else this.#cells.set(k, [ring]);
      }
    }
  }

  contains(x: number, z: number): boolean {
    const list = this.#cells.get(key(Math.floor(x / this.#size), Math.floor(z / this.#size)));
    return list?.some((ring) => pointInRing(ring, x, z)) ?? false;
  }
}

/** Areas (rings) and lines, for "does this footprint touch any of them". */
export class Shapes {
  readonly edges = new EdgeIndex();
  readonly #rings = new RingIndex();

  ring(points: ArrayLike<number>): void {
    this.#rings.add(points);
    this.#add(points, true);
  }

  line(points: ArrayLike<number>): void {
    this.#add(points, false);
  }

  #add(points: ArrayLike<number>, closed: boolean): void {
    this.edges.add(points, closed);
  }

  contains(x: number, z: number): boolean {
    return this.#rings.contains(x, z);
  }

  /** Whether a footprint reaches into an area or across a line. */
  touches(f: Footprint): boolean {
    if (this.contains(f.x, f.z)) return true;
    return this.edges.some(f.x, f.z, radius(f), (ax, az, bx, bz) =>
      segmentInFootprint(f, ax, az, bx, bz),
    );
  }
}

/** The furthest a footprint reaches from its centre: a corner. */
const radius = (f: Footprint) => Math.hypot(Math.max(-f.u0, f.u1), Math.max(-f.v0, f.v1));

/**
 * Whether a footprint stands on the road as the map draws it, over a carriageway or cycle track.
 * Roads are drawn under squares, so a stretch of road under a square is no road to stand clear of,
 * and a rack on the square over it keeps its place: only what shows counts.
 */
export function onDrawnRoad(f: Footprint, roads: Shapes, squares: RingIndex): boolean {
  const shows = (x: number, z: number) => roads.contains(x, z) && !squares.contains(x, z);
  if (shows(f.x, f.z) || corners(f).some(([x, z]) => shows(x, z))) return true;
  return roads.edges.some(f.x, f.z, radius(f), (ax, az, bx, bz) => {
    const inside = clipToFootprint(f, ax, az, bx, bz);
    if (!inside) return false;
    // The edge shows if any of the stretch inside the footprint lies outside a square.
    const [t0, t1] = inside;
    return [t0, (t0 + t1) / 2, t1].some(
      (t) => !squares.contains(ax + (bx - ax) * t, az + (bz - az) * t),
    );
  });
}

/** Rectangles covering a path (flat [x, z, …]) `width` metres across, a ring for each stretch. */
export function pathStrip(line: ArrayLike<number>, width: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i + 3 < line.length; i += 2) {
    const [ax, az, bx, bz] = [line[i]!, line[i + 1]!, line[i + 2]!, line[i + 3]!];
    const length = Math.hypot(bx - ax, bz - az);
    if (length === 0) continue;
    const [nx, nz] = [(-(bz - az) / length) * (width / 2), ((bx - ax) / length) * (width / 2)];
    out.push([ax + nx, az + nz, bx + nx, bz + nz, bx - nx, bz - nz, ax - nx, az - nz]);
  }
  return out;
}

/** What the bake knows about the ground round a prop. */
export interface Surroundings {
  /** Carriageways and cycle tracks: their edges are kerbs; props keep off them where they can. */
  roads: Shapes;
  /** Cycle paths only OSM maps, the width they're drawn (`pathStrip`): no rack stands on one. */
  cyclePaths: Shapes;
  /** Footprints and tanks (areas) and bridge parapets (lines): nothing stands in them. */
  solid: Shapes;
  /** Rivers, ponds and basins: only monuments stand in them (Fonske, Fiere Margriet). */
  water: Shapes;
  /** Edges to line up with where no kerb is near: paths, walls, squares, the road's edge. */
  edges: EdgeIndex;
  /** Squares: a bench on one faces into it. */
  squares: RingIndex;
  /** Tree trunks (x, z, radius) mapped in OSM. */
  trunks: readonly (readonly [number, number, number])[];
}

/** The order props claim their ground: monuments first, the largest first, then what the street needs most. */
const PRIORITY: readonly PropKind[] = [
  'needle',
  'column',
  'fountain',
  'pump',
  'group',
  'statue',
  'bust',
  'sculpture',
  'stone',
  'shelter',
  'busstop',
  'lamp',
  'bench',
  'bikes',
];
/**
 * How far a rack may go to get off the road (m): across a parking lane to its pavement, as a
 * rack mapped in the road is meant to be seen standing by it, not in the traffic.
 */
const RACK_NUDGE = 12;
/** Room a rack keeps from the road's edge (m): less than from a wall, or few pavements would do. */
const KERB_ROOM = 0.08;
/**
 * How far a mapped prop may be moved off something it collides with (m); further, it goes. A
 * monument moves a metre at most (the needle half that).
 */
const NUDGE: Partial<Record<PropKind, number>> = {
  needle: 0.5,
  shelter: 2,
  busstop: 1.5,
  lamp: 1.5,
  bench: 1.5,
  bikes: RACK_NUDGE,
};
/** Free ground kept round each footprint, so props stand apart and off walls and kerbs (m). */
export const CLEARANCE = 0.25;
/** Nudges are tried in rings this far apart, in this many directions. */
const STEP = 0.25;
const DIRECTIONS = 16;
/** A lamp, shelter or bus stop turns to a kerb this close (m); further, to any edge. */
const KERB_REACH = 8;
/** How far a prop looks for something to line up with (m). Further out it keeps its own turn. */
const REACH = 25;
/** A bench with a wall this close on one side only turns its back to it (m). */
const WALL_BEHIND = 3;
/** How far a bench looks to see whether a square lies in front (m). */
const SQUARE_AHEAD = 3;

export interface PropPoint {
  x: number;
  z: number;
  tags: Tags;
}

export interface PlacedProps {
  props: Prop[];
  /** The tags each prop was read from, in the same order: a rack's `access` sets its fill. */
  tags: Tags[];
  /** Mapped props moved off a kerb, a wall, a trunk or another prop. */
  nudged: number;
  /** Props with no room within their nudge: a second mapping of one prop, or walled in. */
  dropped: number;
  /** Bike racks moved (they are in `nudged`), those with nowhere to go, and those mapped twice. */
  racksMoved: number;
  racksDropped: number;
  racksTwin: number;
  /** Racks with no room as mapped drawn shorter, or across the pavement, in their stead. */
  resized: number;
}

/** The OSM node id (`_osm: node/123`), so props settle in the same order on every bake. */
const osmId = (tags: Tags): number => Number(/(\d+)$/.exec(tags['_osm'] ?? '')?.[1] ?? Infinity);

/**
 * The props among the points, placed by rule:
 *
 * - Turned: lamps (head over the road), shelters (open side to it) and bus stops (sign across it)
 *   square to the nearest kerb; bike racks along the nearest kerb, wall or path; benches and
 *   monuments along the nearest edge, facing away from a wall close behind, into a square, or
 *   else towards the edge. A bench or rack drawn as a way faces across it, to the side its rule
 *   picks; a bench line's `side`, or a tagged `direction`, wins.
 * - Placed in priority order (monuments, shelters, bus stops, lamps, benches, racks), then by OSM
 *   id: each keeps clear of buildings, water, tanks, parapets, mapped trunks and the props placed
 *   before it, and of the carriageway unless it was mapped there (a median); never a bike rack,
 *   which goes to the pavement beside it, shorter or across if that's what fits there. A prop
 *   that collides is moved to the nearest free spot within its nudge, or dropped: one of the same
 *   kind standing on it is the same prop mapped twice.
 */
export function placeProps(points: readonly PropPoint[], around: Surroundings): PlacedProps {
  const candidates = points
    .flatMap((point, index) => {
      const style = propFromOsm(point.tags);
      return style ? [{ ...point, ...style, id: osmId(point.tags), index }] : [];
    })
    .toSorted(
      (a, b) =>
        PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind) || a.id - b.id || a.index - b.index,
    );
  const trunks = new Map<number, (readonly [number, number, number])[]>();
  const TRUNK_CELL = 8;
  for (const t of around.trunks) {
    const k = key(Math.floor(t[0] / TRUNK_CELL), Math.floor(t[1] / TRUNK_CELL));
    trunks.set(k, [...(trunks.get(k) ?? []), t]);
  }
  const PROP_CELL = 16;
  const placed = new Map<number, { kind: PropKind; f: Footprint }[]>();
  /** The furthest any placed footprint reaches from its centre. */
  let widest = 0;
  const near = function* <T>(grid: Map<number, T[]>, size: number, f: Footprint, reach: number) {
    for (const k of cellsAround(size, f.x, f.z, reach)) yield* grid.get(k) ?? [];
  };

  const result: PlacedProps = {
    props: [],
    tags: [],
    nudged: 0,
    dropped: 0,
    racksMoved: 0,
    racksDropped: 0,
    racksTwin: 0,
    resized: 0,
  };
  for (const c of candidates) {
    const angle = c.facing ?? turnOf(c.kind, c.x, c.z, around, c.axis);
    const prop: Prop = { kind: c.kind, x: c.x, z: c.z, angle, size: c.size };
    if (c.kind === 'bikes') Object.assign(prop, { rack: c.rack, covered: c.covered });
    if (c.material) Object.assign(prop, { width: c.width, depth: c.depth, material: c.material });
    const body = { kind: c.kind, f: propFootprint(prop) };
    // Monuments are twins whatever their kind: one sculpture mapped twice, at a pump and as it.
    const monument = isMonument(c.kind);
    // A twin's footprint, grown by the clearance, reaches its corner that much further out.
    const twin = [...near(placed, PROP_CELL, body.f, widest + CLEARANCE * Math.SQRT2)].some(
      (other) =>
        (other.kind === c.kind || (monument && isMonument(other.kind))) &&
        discInFootprint(grow(other.f, CLEARANCE), c.x, c.z, 0),
    );
    if (twin) {
      result.dropped++;
      if (c.kind === 'bikes') result.racksTwin++;
      continue;
    }
    const onRoad = around.roads.contains(c.x, c.z);
    const onCyclePath = around.cyclePaths.contains(c.x, c.z);
    // Mapped inside a footprint, its one way out is through the wall.
    const walledIn = around.solid.contains(c.x, c.z);
    const clear = (f: Footprint, strict: boolean) => {
      // A rack is never left on the road, wherever it was mapped: it goes to the pavement, the
      // kerb itself all the room it needs from the road (a pavement is narrow enough), along the
      // street, never through a house to the garden behind it.
      if (c.kind === 'bikes') {
        if (!strict) return false;
        const room = grow(f, KERB_ROOM);
        if (
          onDrawnRoad(room, around.roads, around.squares) ||
          onDrawnRoad(room, around.cyclePaths, around.squares)
        ) {
          return false;
        }
        if (!walledIn && edgeBetween(around.solid, c.x, c.z, f.x, f.z)) return false;
        // Mapped off the road it stays on its own side of it: the pavement across a carriageway
        // is someone else's rack.
        if (!onRoad && edgeBetween(around.roads, c.x, c.z, f.x, f.z)) return false;
        if (!onCyclePath && edgeBetween(around.cyclePaths, c.x, c.z, f.x, f.z)) return false;
      }
      const room = grow(f, CLEARANCE);
      const reach = radius(room);
      if (
        [...near(placed, PROP_CELL, room, reach + widest)].some((o) => footprintsOverlap(room, o.f))
      )
        return false;
      if (around.solid.touches(room)) return false;
      if (!monument) {
        for (const [x, z, r] of near(trunks, TRUNK_CELL, room, reach + 3)) {
          if (discInFootprint(room, x, z, r)) return false;
        }
        if (around.water.touches(room)) return false;
      }
      if (c.kind === 'bikes') return true;
      if (strict) return !around.roads.touches(room);
      return onRoad || !around.roads.contains(f.x, f.z);
    };
    let [shape, spot] = [body.f, settle(body.f, NUDGE[c.kind] ?? 1, clear)];
    if (!spot && c.kind === 'bikes') {
      // No room as mapped: a shorter rack, or one standing across the pavement, before none.
      for (const { stands, across } of rackLayouts(c.size)) {
        const fitted = { ...prop, size: stands, angle: angle + (across ? Math.PI / 2 : 0) };
        const f = propFootprint(fitted);
        spot = settle(f, NUDGE.bikes!, clear);
        if (!spot) continue;
        Object.assign(prop, { size: stands, angle: fitted.angle });
        shape = f;
        result.resized++;
        break;
      }
    }
    if (!spot) {
      result.dropped++;
      if (c.kind === 'bikes') result.racksDropped++;
      continue;
    }
    if (spot.x !== c.x || spot.z !== c.z) {
      result.nudged++;
      if (c.kind === 'bikes') {
        result.racksMoved++;
        // Where it landed it lines up with the kerb there, if that still fits.
        if (c.facing === null && c.axis === null) {
          const aligned = { ...prop, ...spot, angle: turnOf(c.kind, spot.x, spot.z, around) };
          const f = propFootprint(aligned);
          if (clear(f, true)) [prop.angle, shape] = [aligned.angle, f];
        }
      }
    }
    Object.assign(prop, { x: spot.x, z: spot.z });
    const f = { ...shape, x: spot.x, z: spot.z };
    const k = key(Math.floor(f.x / PROP_CELL), Math.floor(f.z / PROP_CELL));
    placed.set(k, [...(placed.get(k) ?? []), { kind: c.kind, f }]);
    widest = Math.max(widest, radius(f));
    result.props.push(prop);
    result.tags.push(c.tags);
  }
  return result;
}

/** Fewer stands for a rack that doesn't fit as mapped, the longest row first. */
const SHORTER = [ROW, 8, 6, 4] as const;
/** Stands in a row that stands across the pavement: it takes up its width. */
const ACROSS = [4, 3, 2] as const;

/** What to try for a rack of `stands` with no room as mapped, in order: shorter rows, then across. */
export function rackLayouts(stands: number): { stands: number; across: boolean }[] {
  return [
    ...SHORTER.filter((n) => n < stands).map((n) => ({ stands: n, across: false })),
    ...ACROSS.filter((n) => n <= stands).map((n) => ({ stands: n, across: true })),
  ];
}

/** Offsets to try, nearest first: rings of STEP, each in DIRECTIONS directions. */
function* offsets(reach: number): Generator<[number, number]> {
  yield [0, 0];
  for (let r = STEP; r <= reach + 1e-9; r += STEP) {
    for (let k = 0; k < DIRECTIONS; k++) {
      const t = (k / DIRECTIONS) * Math.PI * 2;
      yield [Math.cos(t) * r, Math.sin(t) * r];
    }
  }
}

/**
 * The nearest spot within `reach` where `clear` holds: first clear of the roads too, then of the
 * rest only. Offsets turn with the prop, so a rack slides along its kerb the same way anywhere.
 */
function settle(
  f: Footprint,
  reach: number,
  clear: (f: Footprint, strict: boolean) => boolean,
): { x: number; z: number } | null {
  for (const strict of [true, false]) {
    for (const [u, v] of offsets(reach)) {
      const moved = { ...f, x: f.x - f.fz * u + f.fx * v, z: f.z + f.fx * u + f.fz * v };
      if (clear(moved, strict)) return { x: moved.x, z: moved.z };
    }
  }
  return null;
}

/** The turn (radians) that faces along `n`. */
const turn = ([x, z]: readonly [number, number]) => Math.atan2(z, x);

/** The normal of an edge, pointing at it from where we stand (across it, when right on it). */
function towards(edge: Nearest): [number, number] {
  const n: [number, number] = [-edge.uz, edge.ux];
  if (edge.distance < 0.05) return n;
  return n[0] * edge.dx + n[1] * edge.dz >= 0 ? n : [-n[0], -n[1]];
}

const nearer = (a: Nearest | null, b: Nearest | null) =>
  !a ? b : !b ? a : a.distance <= b.distance ? a : b;

/** A normal of a run (a turn), the one on the edge's side when there is an edge. */
function normalOf(axis: number, edge: Nearest | null): [number, number] {
  const n: [number, number] = [-Math.sin(axis), Math.cos(axis)];
  return edge && n[0] * edge.dx + n[1] * edge.dz < 0 ? [-n[0], -n[1]] : n;
}

/**
 * Which way a prop turns where it was mapped, by its kind's rule (see `placeProps`). With an
 * `axis`, the way it was drawn along, it faces across that instead of across the nearest edge.
 */
export function turnOf(
  kind: PropKind,
  x: number,
  z: number,
  around: Surroundings,
  axis: number | null = null,
): number {
  if (kind === 'lamp' || kind === 'shelter' || kind === 'busstop') {
    const edge = around.roads.edges.nearest(x, z, KERB_REACH) ?? around.edges.nearest(x, z, REACH);
    return edge ? turn(towards(edge)) : 0;
  }
  const edge = nearer(around.roads.edges.nearest(x, z, REACH), around.edges.nearest(x, z, REACH));
  const n = axis === null ? edge && towards(edge) : normalOf(axis, edge);
  if (!n) return 0;
  if (kind === 'bikes') return turn(n);
  // Benches and monuments: back to a wall, else into a square, else towards the edge.
  const wall = (s: number) => {
    for (let d = 0.5; d <= WALL_BEHIND; d += 0.5) {
      if (around.solid.contains(x + n[0] * d * s, z + n[1] * d * s)) return true;
    }
    return false;
  };
  const [ahead, behind] = [wall(1), wall(-1)];
  if (ahead !== behind) return turn(ahead ? [-n[0], -n[1]] : n);
  if (around.squares.contains(x, z)) {
    const square = (s: number) =>
      around.squares.contains(x + n[0] * SQUARE_AHEAD * s, z + n[1] * SQUARE_AHEAD * s);
    if (!square(1) && square(-1)) return turn([-n[0], -n[1]]);
  }
  return turn(n);
}
