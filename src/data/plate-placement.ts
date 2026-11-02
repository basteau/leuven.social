/**
 * Where the bake hangs house numbers and street-name plates (docs/DATA.md): on the drawn GRB
 * footprints, on the wall that faces the street they name, read from OpenStreetMap's addresses
 * and street centre lines. Pure: scripts/bake.ts feeds it and writes what it returns.
 */

import { pointInRing } from './geometry.ts';
import { PROUD } from './plates.ts';
import type { HousePlate, StreetPlate } from './plates.ts';

/** Walls shorter than this (m) take no plate: corners, bay windows, survey noise. */
export const MIN_WALL = 1;
/** A house number stays this far (m) from its wall's ends: half of MIN_WALL at most. */
const NUMBER_MARGIN = 0.5;
/** How far an address may lie outside every footprint (m) and still take the nearest one. */
export const FOOTPRINT_REACH = 3;
/** A house number's wall lies within this distance (m) of its street's centre line. */
export const NUMBER_REACH = 40;
/** A house number faces its square, or public ground, when this far in front of it (m) is. */
const FRONT = 2;
/** A wall faces a street when its normal is within 60° of the way to the street. */
const NUMBER_FACING = 0.5;
/** Two house numbers closer than this (m) would overlap: the later one is left out. */
const CROWDED = 0.45;
/** Longer house numbers would make the plate a street sign. */
export const MAX_TEXT = 8;

/** Streets that meet within this distance (m) of each other form one junction. */
export const JUNCTION_MERGE = 20;
/** A street plate hangs within this distance (m) of its junction or stretch point. */
export const CORNER_REACH = 25;
/** A street plate's wall lies within this distance (m) of the street and faces it squarely. */
export const STREET_REACH = 20;
const STREET_FACING = 0.7;
/** Each street gets a plate along any stretch this long (m) without one. */
export const STRETCH = 150;
const STRETCH_STEP = 25;
/** Plates of one street are at least this far apart (m) at junctions. */
const SAME_NAME_GAP = 30;
/** A street plate hangs this high (m), or half a metre under a lower eave. */
export const STREET_PLATE_Y = 3;
/** Line of sight from a wall to its street is checked every this many metres. */
const SIGHT_STEP = 1;

/**
 * How a house number reads on its plate. OSM lists several numbers on one building with `;`
 * or `,` (`80;82;84`): the plate shows the first to the last, as a range. Ranges take an en
 * dash. Null when it is empty or too long to be a house number.
 */
export function plateText(raw: string): string | null {
  const parts = raw
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const text =
    parts.length === 1
      ? parts[0]!
      : `${parts[0]!.split('-')[0]!.trim()}-${parts.at(-1)!.split('-').at(-1)!.trim()}`;
  const ranged = text.replace(/\s*[-–]\s*/g, '–');
  return ranged.length <= MAX_TEXT ? ranged : null;
}

/**
 * A street plate's width (m) for its height, estimated from the name's length the way the
 * renderer sets it (about 0.3 heights a letter plus its rims): enough to know if a wall fits it.
 */
export const streetPlateWidth = (name: string, height: number) =>
  height * (0.6 + 0.3 * name.length);

const key = (i: number, j: number) => (i + 32768) * 65536 + (j + 32768);

/** A wall of a footprint, outward normal included. */
export interface Wall {
  building: number;
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
        const w = this.walls.push({ building: b, ax, az, ux, uz, nx: uz, nz: -ux, length }) - 1;
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
 * Whether a plate at (px, pz) on wall `w` faces a street (at most `reach` away, the normal within
 * `facing` of the way there) and sees it past every other building. Returns the distance, or -1.
 */
function facesStreet(
  facades: Facades,
  w: number,
  px: number,
  pz: number,
  segments: readonly number[],
  reach: number,
  facing: number,
): number {
  const { nx, nz } = facades.walls[w]!;
  const [qx, qz, d] = nearestOn(segments, px, pz);
  if (d > reach || d < 1e-3) return -1;
  if ((nx * (qx - px) + nz * (qz - pz)) / d < facing) return -1;
  return facades.clear(px + nx * 0.3, pz + nz * 0.3, qx, qz) ? d : -1;
}

/** An address: where OSM puts it (a building's middle, or a point), its street and number. */
export interface Address {
  x: number;
  z: number;
  /** Its `addr:street` in the name table, or -1 when no street of that name is on the map. */
  street: number;
  number: string;
}

export interface Placed<T> {
  plates: T[];
  /** How the plates were placed, and how many each way. */
  placed: Record<string, number>;
  /** Why the rest were left out, and how many of each. */
  skipped: Record<string, number>;
}

/** Files placed plates by square, for "is another one this close". */
class Spots {
  readonly #cells = new Map<number, [number, number, number][]>();
  add(x: number, z: number, tag: number): void {
    const k = key(Math.floor(x / 8), Math.floor(z / 8));
    const list = this.#cells.get(k);
    if (list) list.push([x, z, tag]);
    else this.#cells.set(k, [[x, z, tag]]);
  }
  /** Whether a spot (with this tag, unless -1) lies within `reach` (at most 8 m) of (x, z). */
  near(x: number, z: number, reach: number, tag = -1): boolean {
    const [ci, cj] = [Math.floor(x / 8), Math.floor(z / 8)];
    for (let i = ci - 1; i <= ci + 1; i++) {
      for (let j = cj - 1; j <= cj + 1; j++) {
        for (const [sx, sz, t] of this.#cells.get(key(i, j)) ?? []) {
          if ((tag < 0 || t === tag) && Math.hypot(sx - x, sz - z) < reach) return true;
        }
      }
    }
    return false;
  }
}

/**
 * Hangs each address's number on its footprint: the drawn footprint it lies in (or the nearest
 * within FOOTPRINT_REACH), where the address's own point meets the wall (so a block with several
 * addresses spreads them along its front). The wall is the one on its square, else the nearest
 * that faces its street and sees it past the other buildings, else (a house down a lane or in a
 * court) the one nearest its street that opens onto public ground. Duplicates (a building and a
 * shop inside it with the same address) hang once.
 */
export function placeHouseNumbers(
  addresses: readonly Address[],
  facades: Facades,
  streets: ReadonlyMap<number, readonly number[]>,
  around: {
    /** Each named square's outlines, by its name's place in the table. */
    squares?: ReadonlyMap<number, readonly ArrayLike<number>[]>;
    /** Whether (x, z) is public ground: a road, a square. */
    open?: (x: number, z: number) => boolean;
    /** Buildings that take no plate: landmark models stand proud of their footprints. */
    skip?: ReadonlySet<number>;
  } = {},
): Placed<HousePlate> {
  const { squares = new Map<number, ArrayLike<number>[]>(), open = () => false } = around;
  const { skip = new Set<number>() } = around;
  const plates: HousePlate[] = [];
  const skipped: Record<string, number> = {};
  const placed: Record<string, number> = {};
  const miss = (why: string) => (skipped[why] = (skipped[why] ?? 0) + 1);
  const seen = new Set<string>();
  const spots = new Spots();
  for (const { x, z, street, number } of addresses) {
    const text = plateText(number);
    if (!text) {
      miss('unreadable number');
      continue;
    }
    const id = `${street}\n${text}`;
    if (street >= 0 && seen.has(id)) {
      miss('duplicate');
      continue;
    }
    let building = facades.buildingAt(x, z);
    if (building < 0) {
      const nearest = facades
        .near(x, z, FOOTPRINT_REACH)
        .map((w) => {
          const [px, pz] = facades.along(w, facades.project(w, x, z));
          return { w, d: Math.hypot(px - x, pz - z) };
        })
        .toSorted((a, b) => a.d - b.d || a.w - b.w)[0];
      building = nearest ? facades.walls[nearest.w]!.building : -1;
    }
    if (building < 0) {
      miss('no footprint');
      continue;
    }
    if (skip.has(building)) {
      miss('landmark');
      continue;
    }
    const segments = streets.get(street) ?? [];
    const square = squares.get(street) ?? [];
    const options = facades.byBuilding[building]!.map((w) => {
      const { length, nx, nz } = facades.walls[w]!;
      // Walls are at least MIN_WALL long, so both margins fit.
      const t = Math.min(length - NUMBER_MARGIN, Math.max(NUMBER_MARGIN, facades.project(w, x, z)));
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
    let how = 'facing its street';
    let found = options.find((o) =>
      o.onSquare
        ? inFront(o)
        : o.d <= NUMBER_REACH &&
          facesStreet(facades, o.w, o.px, o.pz, segments, NUMBER_REACH, NUMBER_FACING) >= 0,
    );
    if (found?.onSquare) how = 'facing its square';
    if (!found) {
      // A house down a lane or a court: the wall whose door opens onto public ground.
      how = 'onto public ground';
      found = options.find((o) => open(o.fx, o.fz) && inFront(o));
    }
    if (!found) {
      miss('no wall facing the street');
      continue;
    }
    const { nx, nz } = facades.walls[found.w]!;
    const [px, pz] = [found.px + nx * PROUD, found.pz + nz * PROUD];
    if (spots.near(px, pz, CROWDED)) {
      miss('crowded');
      continue;
    }
    seen.add(id);
    spots.add(px, pz, 0);
    placed[how] = (placed[how] ?? 0) + 1;
    plates.push({ x: px, z: pz, angle: Math.atan2(nz, nx), text });
  }
  return { plates, skipped, placed };
}

export interface Junction {
  x: number;
  z: number;
  /** The streets that meet there, by their place in the name table, ascending. */
  names: number[];
}

/**
 * Where streets of different names meet: nodes their OSM ways share (before any simplifying),
 * merged within JUNCTION_MERGE metres, so a dual carriageway or a small roundabout is one
 * junction. In order of their first node, south to north strip by strip, west to east.
 */
export function junctions(ways: readonly { name: number; line: ArrayLike<number> }[]): Junction[] {
  const nodes = new Map<string, { x: number; z: number; names: Set<number> }>();
  for (const { name, line } of ways) {
    for (let i = 0; i + 1 < line.length; i += 2) {
      const k = `${line[i]},${line[i + 1]}`;
      const node = nodes.get(k);
      if (node) node.names.add(name);
      else nodes.set(k, { x: line[i]!, z: line[i + 1]!, names: new Set([name]) });
    }
  }
  const meeting = [...nodes.values()]
    .filter((n) => n.names.size >= 2)
    .toSorted((a, b) => a.z - b.z || a.x - b.x);
  const found: { x: number; z: number; names: Set<number> }[] = [];
  for (const node of meeting) {
    const into = found.find((j) => Math.hypot(j.x - node.x, j.z - node.z) <= JUNCTION_MERGE);
    if (into) for (const n of node.names) into.names.add(n);
    else found.push({ x: node.x, z: node.z, names: new Set(node.names) });
  }
  return found.map((j) => ({ x: j.x, z: j.z, names: [...j.names].toSorted((a, b) => a - b) }));
}

export interface StreetPlateInput {
  junctions: readonly Junction[];
  facades: Facades;
  streets: ReadonlyMap<number, readonly number[]>;
  /** Every street's centre lines, for plates along stretches without a junction. */
  lines: readonly { name: number; line: ArrayLike<number> }[];
  /** The name table, for each plate's width. */
  names: readonly string[];
  /** Each building's eave (m), by its place in the list: a plate hangs under it. */
  eaves: ArrayLike<number>;
  /** A street plate's height (m), for its width. */
  height: number;
  skip?: ReadonlySet<number>;
}

/**
 * A plate for each street at each junction, on the corner building nearest it: the wall that
 * faces that street squarely, the point on it nearest the junction (its ends kept clear). Then
 * one wherever a street runs STRETCH metres without one.
 */
export function placeStreetPlates(input: StreetPlateInput): Placed<StreetPlate> {
  const { facades, streets, names, eaves, height, skip = new Set() } = input;
  const plates: StreetPlate[] = [];
  const skipped: Record<string, number> = {};
  const counts = { junction: 0, stretch: 0 };
  const spots = new Spots();
  /** Plates placed per street, for the gap between plates of one name. */
  const byName = new Map<number, [number, number][]>();
  const nearSame = (name: number, x: number, z: number, gap: number) =>
    (byName.get(name) ?? []).some(([px, pz]) => Math.hypot(px - x, pz - z) < gap);

  /** The best wall near (x, z) for a plate of `name`, or null. */
  function hang(name: number, x: number, z: number): StreetPlate | null {
    const segments = streets.get(name);
    if (!segments) return null;
    const half = streetPlateWidth(names[name]!, height) / 2 + 0.15;
    const options = facades.near(x, z, CORNER_REACH).flatMap((w) => {
      const { building, length } = facades.walls[w]!;
      if (skip.has(building) || length < half * 2) return [];
      const t = Math.min(length - half, Math.max(half, facades.project(w, x, z)));
      const [px, pz] = facades.along(w, t);
      const d = Math.hypot(px - x, pz - z);
      return d <= CORNER_REACH ? [{ w, px, pz, d }] : [];
    });
    options.sort((a, b) => a.d - b.d || a.w - b.w);
    for (const { w, px, pz } of options) {
      if (facesStreet(facades, w, px, pz, segments, STREET_REACH, STREET_FACING) < 0) continue;
      const { nx, nz, building } = facades.walls[w]!;
      const [sx, sz] = [px + nx * PROUD, pz + nz * PROUD];
      if (spots.near(sx, sz, half * 2)) continue;
      const y = Math.min(STREET_PLATE_Y, (eaves[building] ?? 0) - 0.5);
      if (y < height) continue;
      return { x: sx, z: sz, y, angle: Math.atan2(nz, nx), name };
    }
    return null;
  }
  const add = (plate: StreetPlate) => {
    plates.push(plate);
    spots.add(plate.x, plate.z, plate.name);
    const list = byName.get(plate.name) ?? [];
    list.push([plate.x, plate.z]);
    byName.set(plate.name, list);
  };

  for (const j of input.junctions) {
    for (const name of j.names) {
      if (nearSame(name, j.x, j.z, SAME_NAME_GAP)) continue;
      const plate = hang(name, j.x, j.z);
      if (plate) {
        add(plate);
        counts.junction++;
      } else skipped['no corner wall'] = (skipped['no corner wall'] ?? 0) + 1;
    }
  }
  for (const { name, line } of input.lines) {
    let travelled = 0;
    for (let i = 0; i + 3 < line.length; i += 2) {
      const [ax, az, bx, bz] = [line[i]!, line[i + 1]!, line[i + 2]!, line[i + 3]!];
      const length = Math.hypot(bx - ax, bz - az);
      for (; travelled <= length; travelled += STRETCH_STEP) {
        const t = length > 0 ? travelled / length : 0;
        const [x, z] = [ax + (bx - ax) * t, az + (bz - az) * t];
        if (nearSame(name, x, z, STRETCH)) continue;
        const plate = hang(name, x, z);
        if (plate) {
          add(plate);
          counts.stretch++;
        }
      }
      travelled -= length;
    }
  }
  return {
    plates,
    skipped,
    placed: { 'at junctions': counts.junction, 'along stretches': counts.stretch },
  };
}

/** The middle of a polygon's area (its centroid), or of its points if it has none. */
export function centroid(ring: ArrayLike<number>): [number, number] {
  let [sx, sz, sa] = [0, 0, 0];
  const n = ring.length;
  for (let i = 0; i < n; i += 2) {
    const [ax, az, bx, bz] = [ring[i]!, ring[i + 1]!, ring[(i + 2) % n]!, ring[(i + 3) % n]!];
    const cross = ax * bz - bx * az;
    sa += cross;
    sx += (ax + bx) * cross;
    sz += (az + bz) * cross;
  }
  if (Math.abs(sa) > 1e-9) return [sx / (3 * sa), sz / (3 * sa)];
  let [mx, mz] = [0, 0];
  for (let i = 0; i < n; i += 2) [mx, mz] = [mx + ring[i]!, mz + ring[i + 1]!];
  return [(mx * 2) / n, (mz * 2) / n];
}
