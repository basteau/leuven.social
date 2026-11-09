/**
 * The drawn GRB footprints' walls, for what the bake puts on a building's front: which wall of a
 * building faces the street (or square) a shop opens onto, read from OpenStreetMap's street
 * centre lines. Pure: scripts/bake.ts feeds it, and src/data/shops.ts places the fronts with it.
 */

import { pointInRing } from './geometry.ts';

/** Walls shorter than this (m) front nothing: corners, bay windows, survey noise. */
const MIN_WALL = 1;
/** A front's point stays this far (m) from its wall's ends: half of MIN_WALL at most. */
const MARGIN = 0.5;
/** How far a point may lie outside every footprint (m) and still take the nearest one. */
const FOOTPRINT_REACH = 3;
/** A front wall lies within this distance (m) of its street's centre line. */
const FRONT_REACH = 40;
/** A wall fronts its square, or public ground, when this far in front of it (m) is. */
const FRONT = 2;
/** A wall faces a street when its normal is within 60° of the way to the street. */
const FACING = 0.5;
/** Line of sight from a wall to its street is checked every this many metres. */
const SIGHT_STEP = 1;

const key = (i: number, j: number) => (i + 32768) * 65536 + (j + 32768);

/** A wall of a footprint, outward normal included. */
export interface Wall {
  building: number;
  /** Which edge of its ring it is: from corner `edge` to the next. */
  edge: number;
  ax: number;
  az: number;
  /** Along the wall, unit. */
  ux: number;
  uz: number;
  /** Out of the building, unit. */
  nx: number;
  nz: number;
  length: number;
}

/**
 * The drawn footprints' walls and insides, filed by square: which building a point is in,
 * which walls are near, and whether a line between two points stays outside them all.
 */
export class Facades {
  readonly walls: Wall[] = [];
  /** Each building's walls, by its place in the list. */
  readonly byBuilding: number[][];
  readonly #rings: readonly ArrayLike<number>[];
  readonly #wallCells = new Map<number, number[]>();
  readonly #ringCells = new Map<number, number[]>();
  static readonly #WALL_CELL = 16;
  static readonly #RING_CELL = 32;

  /** Rings counter-clockwise (positive `signedArea`), as the bake stores them. */
  constructor(rings: readonly ArrayLike<number>[]) {
    this.#rings = rings;
    this.byBuilding = rings.map(() => []);
    const ws = Facades.#WALL_CELL;
    const rs = Facades.#RING_CELL;
    for (const [b, ring] of rings.entries()) {
      let [minX, minZ, maxX, maxZ] = [Infinity, Infinity, -Infinity, -Infinity];
      const n = ring.length;
      for (let i = 0; i < n; i += 2) {
        const [ax, az] = [ring[i]!, ring[i + 1]!];
        const [bx, bz] = [ring[(i + 2) % n]!, ring[(i + 3) % n]!];
        [minX, maxX] = [Math.min(minX, ax), Math.max(maxX, ax)];
        [minZ, maxZ] = [Math.min(minZ, az), Math.max(maxZ, az)];
        const length = Math.hypot(bx - ax, bz - az);
        if (length < MIN_WALL) continue;
        const [ux, uz] = [(bx - ax) / length, (bz - az) / length];
        const w =
          this.walls.push({ building: b, edge: i / 2, ax, az, ux, uz, nx: uz, nz: -ux, length }) -
          1;
        this.byBuilding[b]!.push(w);
        for (
          let ci = Math.floor(Math.min(ax, bx) / ws);
          ci <= Math.floor(Math.max(ax, bx) / ws);
          ci++
        ) {
          for (
            let cj = Math.floor(Math.min(az, bz) / ws);
            cj <= Math.floor(Math.max(az, bz) / ws);
            cj++
          ) {
            push(this.#wallCells, key(ci, cj), w);
          }
        }
      }
      for (let ci = Math.floor(minX / rs); ci <= Math.floor(maxX / rs); ci++) {
        for (let cj = Math.floor(minZ / rs); cj <= Math.floor(maxZ / rs); cj++) {
          push(this.#ringCells, key(ci, cj), b);
        }
      }
    }
  }

  /** The building (x, z) stands in, or -1. */
  buildingAt(x: number, z: number): number {
    const s = Facades.#RING_CELL;
    for (const b of this.#ringCells.get(key(Math.floor(x / s), Math.floor(z / s))) ?? []) {
      if (pointInRing(this.#rings[b]!, x, z)) return b;
    }
    return -1;
  }

  /** Walls with any part within `reach` of (x, z), in the order they were filed. */
  near(x: number, z: number, reach: number): number[] {
    const s = Facades.#WALL_CELL;
    const found = new Set<number>();
    for (let i = Math.floor((x - reach) / s); i <= Math.floor((x + reach) / s); i++) {
      for (let j = Math.floor((z - reach) / s); j <= Math.floor((z + reach) / s); j++) {
        for (const w of this.#wallCells.get(key(i, j)) ?? []) {
          const [px, pz] = this.along(w, this.project(w, x, z));
          if (Math.hypot(px - x, pz - z) <= reach) found.add(w);
        }
      }
    }
    return [...found].toSorted((a, b) => a - b);
  }

  /** How far along wall `w` (m) the point nearest (x, z) lies, within the wall. */
  project(w: number, x: number, z: number): number {
    const { ax, az, ux, uz, length } = this.walls[w]!;
    return Math.min(length, Math.max(0, (x - ax) * ux + (z - az) * uz));
  }

  /** The point `t` metres along wall `w`. */
  along(w: number, t: number): [number, number] {
    const { ax, az, ux, uz } = this.walls[w]!;
    return [ax + ux * t, az + uz * t];
  }

  /** Whether the line from (ax, az) to (bx, bz) stays outside every building. */
  clear(ax: number, az: number, bx: number, bz: number): boolean {
    const length = Math.hypot(bx - ax, bz - az);
    const steps = Math.ceil(length / SIGHT_STEP);
    for (let i = 0; i <= steps; i++) {
      const t = steps === 0 ? 0 : i / steps;
      if (this.buildingAt(ax + (bx - ax) * t, az + (bz - az) * t) >= 0) return false;
    }
    return true;
  }
}

function push(map: Map<number, number[]>, k: number, v: number): void {
  const list = map.get(k);
  if (list) list.push(v);
  else map.set(k, [v]);
}

/** Each street's centre lines as segments [ax, az, bx, bz, …], by its place in the name table. */
export function streetSegments(
  streets: readonly { name: number; line: ArrayLike<number> }[],
): Map<number, number[]> {
  const segments = new Map<number, number[]>();
  for (const { name, line } of streets) {
    const list = segments.get(name) ?? [];
    for (let i = 0; i + 3 < line.length; i += 2) {
      list.push(line[i]!, line[i + 1]!, line[i + 2]!, line[i + 3]!);
    }
    segments.set(name, list);
  }
  return segments;
}

/** The point on any of `segments` nearest (x, z), and how far it is. */
export function nearestOn(
  segments: readonly number[],
  x: number,
  z: number,
): [number, number, number] {
  let best: [number, number, number] = [x, z, Infinity];
  for (let i = 0; i + 3 < segments.length; i += 4) {
    const [ax, az, bx, bz] = [segments[i]!, segments[i + 1]!, segments[i + 2]!, segments[i + 3]!];
    const [ex, ez] = [bx - ax, bz - az];
    const length2 = ex * ex + ez * ez;
    const t = length2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * ex + (z - az) * ez) / length2)) : 0;
    const [qx, qz] = [ax + ex * t, az + ez * t];
    const d = Math.hypot(qx - x, qz - z);
    if (d < best[2]) best = [qx, qz, d];
  }
  return best;
}

/**
 * Whether the point (px, pz) on wall `w` faces a street (at most FRONT_REACH away, the normal
 * within FACING of the way there) and sees it past every other building.
 */
function facesStreet(
  facades: Facades,
  w: number,
  px: number,
  pz: number,
  segments: readonly number[],
): boolean {
  const { nx, nz } = facades.walls[w]!;
  const [qx, qz, d] = nearestOn(segments, px, pz);
  if (d > FRONT_REACH || d < 1e-3) return false;
  if ((nx * (qx - px) + nz * (qz - pz)) / d < FACING) return false;
  return facades.clear(px + nx * 0.3, pz + nz * 0.3, qx, qz);
}

/**
 * The drawn footprint a point (a shop) belongs to: the one it lies in, else the one
 * with a wall nearest it within FOOTPRINT_REACH. -1 when there is none.
 */
export function footprintOf(facades: Facades, x: number, z: number): number {
  const inside = facades.buildingAt(x, z);
  if (inside >= 0) return inside;
  const nearest = facades
    .near(x, z, FOOTPRINT_REACH)
    .map((w) => {
      const [px, pz] = facades.along(w, facades.project(w, x, z));
      return { w, d: Math.hypot(px - x, pz - z) };
    })
    .toSorted((a, b) => a.d - b.d || a.w - b.w)[0];
  return nearest ? facades.walls[nearest.w]!.building : -1;
}

/** How a front's wall was chosen (see `frontWall`). */
export type Facing = 'facing its street' | 'facing its square' | 'onto public ground';

/** A building's front: its wall, and the point on it nearest the door. */
export interface Front {
  w: number;
  px: number;
  pz: number;
  how: Facing;
}

/**
 * The wall of `building` that a door at (x, z) opens from, where the point meets it (kept
 * MARGIN from its ends): the one on its square, else the nearest that faces its street and sees
 * it past the other buildings, else (a house down a lane or in a court) the one nearest its
 * street that opens onto public ground.
 */
export function frontWall(
  facades: Facades,
  building: number,
  x: number,
  z: number,
  street: {
    /** The street's centre lines (`streetSegments`). */
    segments: readonly number[];
    /** The square's outlines, when the door opens onto a named square. */
    square: readonly ArrayLike<number>[];
    /** Whether (x, z) is public ground: a road, a square. */
    open: (x: number, z: number) => boolean;
  },
): Front | null {
  const { segments, square, open } = street;
  const options = facades.byBuilding[building]!.map((w) => {
    const { length, nx, nz } = facades.walls[w]!;
    // Walls are at least MIN_WALL long, so both margins fit.
    const t = Math.min(length - MARGIN, Math.max(MARGIN, facades.project(w, x, z)));
    const [px, pz] = facades.along(w, t);
    const [fx, fz] = [px + nx * FRONT, pz + nz * FRONT];
    const onSquare = square.some((ring) => pointInRing(ring, fx, fz));
    const d = onSquare ? 0 : segments.length > 0 ? nearestOn(segments, px, pz)[2] : Infinity;
    return { w, px, pz, fx, fz, d, onSquare, away: Math.hypot(px - x, pz - z) };
  });
  options.sort((a, b) => a.d - b.d || a.away - b.away || a.w - b.w);
  const inFront = (o: (typeof options)[number]) => {
    const { nx, nz } = facades.walls[o.w]!;
    return facades.clear(o.px + nx * 0.3, o.pz + nz * 0.3, o.fx, o.fz);
  };
  const found = options.find((o) =>
    o.onSquare ? inFront(o) : o.d <= FRONT_REACH && facesStreet(facades, o.w, o.px, o.pz, segments),
  );
  if (found) {
    return {
      w: found.w,
      px: found.px,
      pz: found.pz,
      how: found.onSquare ? 'facing its square' : 'facing its street',
    };
  }
  // A house down a lane or a court: the wall whose door opens onto public ground.
  const lane = options.find((o) => open(o.fx, o.fz) && inFront(o));
  return lane ? { w: lane.w, px: lane.px, pz: lane.pz, how: 'onto public ground' } : null;
}
