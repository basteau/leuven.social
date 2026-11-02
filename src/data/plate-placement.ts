/**
 * Where the bake hangs house numbers and street-name plates (docs/DATA.md): on the drawn GRB
 * footprints, on the wall that faces the street they name, read from OpenStreetMap's addresses
 * and street centre lines. Pure: scripts/bake.ts feeds it and writes what it returns.
 */

import { pointInRing } from './geometry.ts';
import { HOUSE_PLATE_HEIGHT, PROUD } from './plates.ts';
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
/** Space (m) kept between two house numbers' plates. */
const NUMBER_GAP = 0.1;
/** How far (m) a number may move along its wall to clear one already there, either way. */
const SLIDES = [0, 0.25, -0.25, 0.5, -0.5, 0.75, -0.75, 1, -1];
/** A mapped door this far (m) off a front wall's line is in it (OSM's outlines and the GRB's differ). */
const DOOR_OFF = 1;
/** ...and is its address's door when this far along the wall (m) from the address, at most. */
const DOOR_ALONG = 6;
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
/** Buildings lower than this (m) take no street plate: garages, sheds, kiosks. */
export const MIN_EAVE = 3;
/** Plates of one street on opposite sides: their walls face at least this far apart (cosine). */
const OPPOSITE = -0.5;
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

/** A house number's plate width (m), estimated the same way: its caps and bold figures. */
export const housePlateWidth = (text: string, height = HOUSE_PLATE_HEIGHT) =>
  height * Math.max(1.45, 0.56 + 0.36 * text.length);

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

/**
 * The drawn footprint a point (an address, a shop) belongs to: the one it lies in, else the one
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

/** A building's front: its wall, and the point on it nearest the address. */
export interface Front {
  w: number;
  px: number;
  pz: number;
  how: Facing;
}

/**
 * The wall of `building` that a door at (x, z) opens from, where the point meets it (kept
 * NUMBER_MARGIN from its ends): the one on its square, else the nearest that faces its street
 * and sees it past the other buildings, else (a house down a lane or in a court) the one nearest
 * its street that opens onto public ground. House numbers and shop fronts share it.
 */
export function frontWall(
  facades: Facades,
  building: number,
  x: number,
  z: number,
  street: {
    /** The street's centre lines (`streetSegments`). */
    segments: readonly number[];
    /** The square's outlines, when the address is on a named square. */
    square: readonly ArrayLike<number>[];
    /** Whether (x, z) is public ground: a road, a square. */
    open: (x: number, z: number) => boolean;
  },
): Front | null {
  const { segments, square, open } = street;
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
  const found = options.find((o) =>
    o.onSquare
      ? inFront(o)
      : o.d <= NUMBER_REACH &&
        facesStreet(facades, o.w, o.px, o.pz, segments, NUMBER_REACH, NUMBER_FACING) >= 0,
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
  /** Whether a plate `half` wide either side of (x, z) would touch one filed with its half width. */
  touches(x: number, z: number, half: number, gap: number): boolean {
    const [ci, cj] = [Math.floor(x / 8), Math.floor(z / 8)];
    for (let i = ci - 1; i <= ci + 1; i++) {
      for (let j = cj - 1; j <= cj + 1; j++) {
        for (const [sx, sz, h] of this.#cells.get(key(i, j)) ?? []) {
          if (Math.hypot(sx - x, sz - z) < half + h + gap) return true;
        }
      }
    }
    return false;
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

/** A door OSM maps on a building (`entrance`), with the number it carries, if any. */
export interface Door {
  x: number;
  z: number;
  number: string | null;
}

/** Mapped doors filed by square, each taken by one number at most. */
class Doors {
  readonly #doors: readonly Door[];
  readonly #cells = new Map<number, number[]>();
  readonly #taken = new Set<number>();

  constructor(doors: readonly Door[]) {
    this.#doors = doors;
    for (const [i, { x, z }] of doors.entries())
      push(this.#cells, key(Math.floor(x / 8), Math.floor(z / 8)), i);
  }

  /**
   * The door in wall `w` for the number `text` whose address meets the wall `t` metres along:
   * one carrying that number, else the nearest within DOOR_ALONG. Returns how far along the wall
   * it is, and takes it, or null.
   */
  take(facades: Facades, w: number, t: number, text: string): number | null {
    const { ax, az, ux, uz, nx, nz, length } = facades.walls[w]!;
    let best: { i: number; along: number; rank: number } | undefined;
    const [x0, z0, x1, z1] = [ax, az, ax + ux * length, az + uz * length];
    for (
      let ci = Math.floor((Math.min(x0, x1) - DOOR_OFF) / 8);
      ci <= Math.floor((Math.max(x0, x1) + DOOR_OFF) / 8);
      ci++
    ) {
      for (
        let cj = Math.floor((Math.min(z0, z1) - DOOR_OFF) / 8);
        cj <= Math.floor((Math.max(z0, z1) + DOOR_OFF) / 8);
        cj++
      ) {
        for (const i of this.#cells.get(key(ci, cj)) ?? []) {
          if (this.#taken.has(i)) continue;
          const door = this.#doors[i]!;
          const along = (door.x - ax) * ux + (door.z - az) * uz;
          const off = Math.abs((door.x - ax) * nx + (door.z - az) * nz);
          if (off > DOOR_OFF || along < 0 || along > length) continue;
          const rank = door.number === text ? -1 : Math.abs(along - t);
          if (rank > DOOR_ALONG) continue;
          if (!best || rank < best.rank || (rank === best.rank && i < best.i))
            best = { i, along, rank };
        }
      }
    }
    if (!best) return null;
    this.#taken.add(best.i);
    return best.along;
  }
}

/**
 * Hangs each address's number on its footprint: the drawn footprint it lies in (or the nearest
 * within FOOTPRINT_REACH), over its door where OSM maps one in that wall, else where the address's
 * own point meets the wall (so a block with several addresses spreads them along its front). The
 * wall is the one on its square, else the nearest that faces its street and sees it past the
 * other buildings, else (a house down a lane or in a court) the one nearest its street that opens
 * onto public ground. A number that would touch one already there moves along its wall to clear
 * it, a metre at most. Duplicates (a building and a shop inside it with the same address) hang
 * once.
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
    /** The doors OSM maps on buildings. */
    doors?: readonly Door[];
  } = {},
): Placed<HousePlate> {
  const { squares = new Map<number, ArrayLike<number>[]>(), open = () => false } = around;
  const { skip = new Set<number>() } = around;
  const doors = new Doors(around.doors ?? []);
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
    const building = footprintOf(facades, x, z);
    if (building < 0) {
      miss('no footprint');
      continue;
    }
    if (skip.has(building)) {
      miss('landmark');
      continue;
    }
    const found = frontWall(facades, building, x, z, {
      segments: streets.get(street) ?? [],
      square: squares.get(street) ?? [],
      open,
    });
    if (!found) {
      miss('no wall facing the street');
      continue;
    }
    const { nx, nz, length } = facades.walls[found.w]!;
    const half = housePlateWidth(text) / 2;
    const margin = Math.min(length / 2, Math.max(NUMBER_MARGIN, half + NUMBER_GAP));
    const door = doors.take(facades, found.w, facades.project(found.w, found.px, found.pz), text);
    const t = door ?? facades.project(found.w, found.px, found.pz);
    const clear = SLIDES.map((o) => Math.min(length - margin, Math.max(margin, t + o)))
      .map((u) => {
        const [px, pz] = facades.along(found.w, u);
        return [px + nx * PROUD, pz + nz * PROUD] as const;
      })
      .find(([px, pz]) => !spots.touches(px, pz, half, NUMBER_GAP));
    if (!clear) {
      miss('crowded');
      continue;
    }
    const [px, pz] = clear;
    seen.add(id);
    spots.add(px, pz, half);
    placed[found.how] = (placed[found.how] ?? 0) + 1;
    if (door !== null) placed['over a mapped door'] = (placed['over a mapped door'] ?? 0) + 1;
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
  /** Each building's eave (m), by its place in the list: a low one takes no plate. */
  eaves: ArrayLike<number>;
  /** A street plate's height (m), for its width. */
  height: number;
  skip?: ReadonlySet<number>;
}

/**
 * Plates for each street at each junction, on the corner buildings nearest it: the wall that
 * faces that street squarely, the point on it nearest the junction (its ends kept clear), and
 * then one on the street's other side, so the name reads coming up the crossing street either
 * way. A side that has a plate of the name within SAME_NAME_GAP already takes none. Then one
 * wherever a street runs STRETCH metres without one.
 */
export function placeStreetPlates(input: StreetPlateInput): Placed<StreetPlate> {
  const { facades, streets, names, eaves, height, skip = new Set() } = input;
  const plates: StreetPlate[] = [];
  const skipped: Record<string, number> = {};
  const counts = { junction: 0, stretch: 0 };
  const spots = new Spots();
  /** Plates placed per street, for the gap between plates of one name (on one side). */
  const byName = new Map<number, StreetPlate[]>();
  const nearSame = (name: number, x: number, z: number, gap: number, nx?: number, nz = 0) =>
    (byName.get(name) ?? []).some(
      (p) =>
        Math.hypot(p.x - x, p.z - z) < gap &&
        (nx === undefined || Math.cos(p.angle) * nx + Math.sin(p.angle) * nz > 0.5),
    );

  /** The best wall near (x, z) for a plate of `name` whose facing `fits`, or null. */
  function hang(
    name: number,
    x: number,
    z: number,
    fits: (nx: number, nz: number) => boolean = () => true,
  ): StreetPlate | null {
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
      if (!fits(nx, nz) || (eaves[building] ?? 0) < MIN_EAVE) continue;
      const [sx, sz] = [px + nx * PROUD, pz + nz * PROUD];
      if (spots.near(sx, sz, half * 2)) continue;
      return { x: sx, z: sz, angle: Math.atan2(nz, nx), name };
    }
    return null;
  }
  const add = (plate: StreetPlate) => {
    plates.push(plate);
    spots.add(plate.x, plate.z, plate.name);
    const list = byName.get(plate.name) ?? [];
    list.push(plate);
    byName.set(plate.name, list);
  };

  for (const j of input.junctions) {
    for (const name of j.names) {
      if (nearSame(name, j.x, j.z, SAME_NAME_GAP)) {
        // One side has its plate: the other may still want one.
        const had = (byName.get(name) ?? []).find(
          (p) => Math.hypot(p.x - j.x, p.z - j.z) < SAME_NAME_GAP,
        );
        const [hx, hz] = [Math.cos(had!.angle), Math.sin(had!.angle)];
        const other = hang(
          name,
          j.x,
          j.z,
          (nx, nz) =>
            nx * hx + nz * hz < OPPOSITE && !nearSame(name, j.x, j.z, SAME_NAME_GAP, nx, nz),
        );
        if (other) {
          add(other);
          counts.junction++;
        }
        continue;
      }
      const first = hang(name, j.x, j.z);
      if (!first) {
        skipped['no corner wall'] = (skipped['no corner wall'] ?? 0) + 1;
        continue;
      }
      add(first);
      counts.junction++;
      const [fx, fz] = [Math.cos(first.angle), Math.sin(first.angle)];
      const other = hang(name, j.x, j.z, (nx, nz) => nx * fx + nz * fz < OPPOSITE);
      if (other) {
        add(other);
        counts.junction++;
      }
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
