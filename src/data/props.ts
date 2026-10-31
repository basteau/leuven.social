/**
 * Street furniture and small monuments from OpenStreetMap points: lamps, benches, bike racks,
 * bus stops, statues, fountains and pumps. They are what makes a street read as a
 * street at zoom 2–4. A point has no direction, so each prop turns to face the nearest kerb,
 * path or wall, the way benches, racks and shelters really stand.
 */

import type { Prop, PropKind } from './city.ts';
import { pointInRing } from './geometry.ts';

type Tags = Record<string, string | undefined>;

/** Bike racks hold at most this many stands in the model: two rows of twelve. */
export const MAX_STANDS = 24;
/** Stands in a rack whose capacity isn't tagged: a typical Leuven pavement rack. */
export const DEFAULT_STANDS = 6;
/** Sculptures at least this tall (m) are needles, seen from across the city (Jan Fabre's Totem). */
export const NEEDLE_HEIGHT = 12;

const SCULPTURES = new Set(['statue', 'sculpture', 'bust']);
/** Racks we can't see from above: in a basement, a building or behind doors. */
const HIDDEN_RACKS = new Set(['underground', 'indoor']);

/** Which OSM points are props, and how big. A tagged height counts for monuments only. */
export function propFromOsm(tags: Tags): { kind: PropKind; size: number } | null {
  const tagged = Number.parseFloat(tags.height ?? '');
  const height = tagged > 0 && tagged < 60 ? tagged : 0;
  // A fountain that is also a sculpture (Fonske) is still a fountain: it gets a basin.
  if (tags.amenity === 'fountain') return { kind: 'fountain', size: 0 };
  const sculpture =
    tags.tourism === 'artwork'
      ? SCULPTURES.has(tags.artwork_type ?? '')
      : tags.memorial === 'statue';
  if (sculpture) return { kind: height >= NEEDLE_HEIGHT ? 'needle' : 'statue', size: height };
  if (tags.man_made === 'water_well') return { kind: 'pump', size: 0 };
  if (tags.amenity === 'bench') return { kind: 'bench', size: 0 };
  if (tags.amenity === 'bicycle_parking') {
    if (HIDDEN_RACKS.has(tags.location ?? '') || tags.bicycle_parking === 'building') return null;
    const capacity = Number.parseInt(tags.capacity ?? '', 10);
    const stands = capacity > 0 ? capacity : DEFAULT_STANDS;
    return { kind: 'bikes', size: Math.min(Math.max(stands, 2), MAX_STANDS) };
  }
  if (tags.highway === 'bus_stop')
    return { kind: tags.shelter === 'yes' ? 'shelter' : 'busstop', size: 0 };
  if (tags.highway === 'street_lamp') return { kind: 'lamp', size: 0 };
  return null;
}

const key = (i: number, j: number) => (i + 32768) * 65536 + (j + 32768);

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

  /**
   * The nearest point on any edge within `reach` metres: the offset to it from (x, z), and the
   * direction of its edge. Null when nothing is that close.
   */
  nearest(
    x: number,
    z: number,
    reach: number,
  ): { dx: number; dz: number; distance: number; ux: number; uz: number } | null {
    const s = this.#size;
    let best: { dx: number; dz: number; distance: number; ux: number; uz: number } | null = null;
    for (let i = Math.floor((x - reach) / s); i <= Math.floor((x + reach) / s); i++) {
      for (let j = Math.floor((z - reach) / s); j <= Math.floor((z + reach) / s); j++) {
        const list = this.#cells.get(key(i, j)) ?? [];
        for (let k = 0; k < list.length; k += 4) {
          const [ax, az, bx, bz] = [list[k]!, list[k + 1]!, list[k + 2]!, list[k + 3]!];
          const [ex, ez] = [bx - ax, bz - az];
          const length2 = ex * ex + ez * ez;
          if (length2 < 1e-12) continue;
          const t = Math.min(1, Math.max(0, ((x - ax) * ex + (z - az) * ez) / length2));
          const [dx, dz] = [ax + ex * t - x, az + ez * t - z];
          const distance = Math.hypot(dx, dz);
          if (distance > reach || (best && distance >= best.distance)) continue;
          const length = Math.sqrt(length2);
          best = { dx, dz, distance, ux: ex / length, uz: ez / length };
        }
      }
    }
    return best;
  }
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

/** How far a prop looks for something to face (m). Further out it keeps its default turn. */
const REACH = 25;
/** Two props of a kind closer than this are one point mapped twice (m). */
const SAME_PROP = 0.5;

export interface PropPoint {
  x: number;
  z: number;
  tags: Tags;
}

/**
 * The props among the points, each turned to face the nearest edge in `edges` (kerbs, paths,
 * walls) and dropped where `blocked` holds one (inside a building, or in the river).
 */
export function placeProps(
  points: readonly PropPoint[],
  edges: EdgeIndex,
  blocked: RingIndex,
): Prop[] {
  const props: Prop[] = [];
  const seen = new Map<string, Prop[]>();
  for (const { x, z, tags } of points) {
    const style = propFromOsm(tags);
    if (!style || blocked.contains(x, z)) continue;
    const near = `${style.kind}:${Math.round(x)},${Math.round(z)}`;
    const twins = seen.get(near) ?? [];
    if (twins.some((p) => Math.hypot(p.x - x, p.z - z) < SAME_PROP)) continue;
    const edge = edges.nearest(x, z, REACH);
    // Face the edge; a prop standing right on it faces across it instead.
    const angle = !edge
      ? 0
      : edge.distance > 0.05
        ? Math.atan2(edge.dz, edge.dx)
        : Math.atan2(edge.ux, -edge.uz);
    const prop = { kind: style.kind, x, z, angle, size: style.size };
    seen.set(near, [...twins, prop]);
    props.push(prop);
  }
  return props;
}
