/**
 * The insides of a few well-known landmarks: rooms the avatar walks into through a door, in
 * the same world space as the street, at real coordinates inside the real footprint. Authored by
 * hand in public/data/rooms.json, keyed by the building's GRB id (OIDN, stable across rebakes),
 * fetched the first time the avatar comes near one. A room is a stack of floors, each a slab
 * ring with holes (stairwells, atriums), its walls (with gaps for doors), its furnishings and
 * the stairs up from it. This module reads and checks the file and answers where a floor is;
 * room-grid.ts walks it and room-mesh.ts draws it.
 */

import { inRing } from './cell-grid.ts';

/** A stretch of wall from (x0, z0) to (x1, z1), with doorways: [from, to] metres along it. */
export interface RoomWall {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  gaps: [number, number][];
  /** How high it stands over its floor (m), if not the floor's whole height: a balustrade. */
  height?: number;
}

/** A furnishing: a pew, an altar, a pillar, a table…, at a spot, turned by `angle` (radians). */
export interface RoomProp {
  kind: string;
  x: number;
  z: number;
  angle: number;
}

/**
 * A flight of stairs up from its floor to floor `to`: a rectangle `width` across and `depth`
 * long, centred at (x, z), climbing toward `angle` (radians, 0 toward +z, π/2 toward +x).
 */
export interface Stair {
  to: number;
  x: number;
  z: number;
  width: number;
  depth: number;
  angle: number;
}

export interface Floor {
  level: number;
  /** What the sign calls it: the nave, the gallery. */
  name: string;
  /** Metres above the building's foot, and how tall the room is up to the next floor. */
  y: number;
  height: number;
  /** Ring, flat [x, z, …], world metres, counter-clockwise. */
  slab: number[];
  /** Stairwells and atriums: where the floor isn't. */
  holes: number[][];
  walls: RoomWall[];
  props: RoomProp[];
  stairs: Stair[];
}

export interface Room {
  oidn: number;
  /** A short id for the page and the smoke test. */
  id: string;
  name: string;
  /** Where the door is, on the slab's edge, and which way you face going in (radians). */
  door: { x: number; z: number; facing: number };
  floors: Floor[];
}

/**
 * The furnishings a room may hold: how wide across their front, how deep along the way they
 * face (`angle`) and how tall they stand (m; 0 reaches the ceiling). The grid closes their
 * footprint and bodies meet its outline; the mesh draws them at the same size.
 */
export const PROP_SIZES: Record<string, readonly [across: number, deep: number, tall: number]> = {
  pew: [3.2, 0.7, 1.0],
  altar: [2.6, 1.2, 1.1],
  pulpit: [1.4, 1.4, 2.8],
  pillar: [1.1, 1.1, 0],
  organ: [6, 1.8, 3.4],
  font: [1.2, 1.2, 1.0],
  chair: [0.6, 0.6, 0.9],
  candles: [0.5, 0.5, 1.6],
};

/** A furnishing's footprint, flat [x, z, …], counter-clockwise. */
export function propFootprint(p: RoomProp): number[] {
  const [across, deep] = PROP_SIZES[p.kind] ?? [1, 1, 1];
  const [fx, fz] = [Math.sin(p.angle), Math.cos(p.angle)];
  const [rx, rz] = [fz, -fx];
  const at = (a: number, d: number) => [p.x + rx * a + fx * d, p.z + rz * a + fz * d];
  const [ha, hd] = [across / 2, deep / 2];
  return [...at(-ha, -hd), ...at(ha, -hd), ...at(ha, hd), ...at(-ha, hd)];
}

/** Where rooms.json is served, under the site's base. */
export const ROOMS_FILE = 'data/rooms.json';

/**
 * A room couldn't be fetched or read: said in words, and its door stays shut. The street is
 * unaffected.
 */
export class RoomLoadError extends Error {
  constructor(cause?: unknown) {
    super('The insides of the buildings couldn’t load, so their doors stay shut for now.', {
      cause,
    });
    this.name = 'RoomLoadError';
  }
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const numbers = (v: unknown): v is number[] => Array.isArray(v) && v.every(isNumber);

const fail = (what: string) => new RoomLoadError(new Error(`rooms.json: ${what}`));

/** Reads rooms.json, checking its shape; anything malformed is a `RoomLoadError`. */
export function parseRooms(json: unknown): Room[] {
  if (!Array.isArray(json)) throw fail('not a list');
  return json.map((room: Room, i) => {
    const where = `room ${i}`;
    if (!isNumber(room?.oidn) || typeof room.id !== 'string' || typeof room.name !== 'string')
      throw fail(`${where} needs an oidn, an id and a name`);
    if (!isNumber(room.door?.x) || !isNumber(room.door?.z) || !isNumber(room.door?.facing))
      throw fail(`${where} needs a door`);
    if (!Array.isArray(room.floors) || !room.floors.length) throw fail(`${where} has no floors`);
    for (const f of room.floors) {
      const ok =
        isNumber(f?.level) &&
        typeof f.name === 'string' &&
        isNumber(f.y) &&
        isNumber(f.height) &&
        numbers(f.slab) &&
        Array.isArray(f.holes) &&
        f.holes.every(numbers) &&
        Array.isArray(f.walls) &&
        f.walls.every(
          (w) =>
            [w?.x0, w?.z0, w?.x1, w?.z1].every(isNumber) &&
            Array.isArray(w.gaps) &&
            w.gaps.every((g) => numbers(g) && g.length === 2) &&
            (w.height === undefined || isNumber(w.height)),
        ) &&
        Array.isArray(f.props) &&
        f.props.every((p) => typeof p?.kind === 'string' && [p.x, p.z, p.angle].every(isNumber)) &&
        Array.isArray(f.stairs) &&
        f.stairs.every((s) => [s?.to, s?.x, s?.z, s?.width, s?.depth, s?.angle].every(isNumber));
      if (!ok) throw fail(`${where} has a malformed floor`);
    }
    return room;
  });
}

/** Which side of p→q the point r is: positive to the left. */
const side = (px: number, pz: number, qx: number, qz: number, rx: number, rz: number) =>
  (qx - px) * (rz - pz) - (qz - pz) * (rx - px);

/** Whether a segment a→b crosses c→d, strictly inside both. */
function crosses(
  [ax, az, bx, bz]: readonly number[],
  [cx, cz, dx, dz]: readonly number[],
): boolean {
  const [d1, d2] = [side(cx!, cz!, dx!, dz!, ax!, az!), side(cx!, cz!, dx!, dz!, bx!, bz!)];
  const [d3, d4] = [side(ax!, az!, bx!, bz!, cx!, cz!), side(ax!, az!, bx!, bz!, dx!, dz!)];
  return d1 * d2 < -1e-9 && d3 * d4 < -1e-9;
}

/** Whether a ring's edges cross each other anywhere but where neighbours meet. */
export function selfIntersects(ring: ArrayLike<number>): boolean {
  const n = ring.length / 2;
  const edge = (i: number) => [
    ring[i * 2]!,
    ring[i * 2 + 1]!,
    ring[((i + 1) % n) * 2]!,
    ring[((i + 1) % n) * 2 + 1]!,
  ];
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (crosses(edge(i), edge(j))) return true;
    }
  }
  return false;
}

/** The four corners of a stair, flat [x, z, …]: bottom left, bottom right, top right, top left. */
export function stairCorners(s: Stair): number[] {
  const [ux, uz] = [Math.sin(s.angle), Math.cos(s.angle)];
  const [rx, rz] = [uz, -ux];
  const [hd, hw] = [s.depth / 2, s.width / 2];
  const at = (d: number, w: number) => [s.x + ux * d + rx * w, s.z + uz * d + rz * w];
  return [...at(-hd, -hw), ...at(-hd, hw), ...at(hd, hw), ...at(hd, -hw)];
}

/**
 * How far up a stair (x, z) is, 0 at its foot to 1 at its top, or NaN off it. `margin` widens
 * the rectangle's sides (not its ends).
 */
export function stairAt(s: Stair, x: number, z: number, margin = 0): number {
  const [ux, uz] = [Math.sin(s.angle), Math.cos(s.angle)];
  const [dx, dz] = [x - s.x, z - s.z];
  const along = dx * ux + dz * uz;
  const across = dx * uz - dz * ux;
  if (Math.abs(along) > s.depth / 2 || Math.abs(across) > s.width / 2 + margin) return Number.NaN;
  return along / s.depth + 0.5;
}

/** A floor by its level. */
export const floorAt = (room: Room, level: number) => room.floors.find((f) => f.level === level);

/** The stairs that touch a floor: up from it, and up to it from below, with their lower floor. */
export function stairsOf(room: Room, level: number): { stair: Stair; from: Floor }[] {
  return room.floors.flatMap((from) =>
    from.stairs
      .filter((stair) => from.level === level || stair.to === level)
      .map((stair) => ({ stair, from })),
  );
}

/**
 * Where the avatar is in a room at (x, z) on floor `level`: on a stair, the floor it counts as
 * (the lower until halfway up, the upper after: the switch happens mid-flight, where no seam
 * shows) and its height over the building's foot along the ramp; elsewhere its floor's own.
 */
export function standing(
  room: Room,
  level: number,
  x: number,
  z: number,
): { level: number; y: number } {
  for (const { stair, from } of stairsOf(room, level)) {
    const t = stairAt(stair, x, z);
    if (Number.isNaN(t)) continue;
    const to = floorAt(room, stair.to);
    if (!to) continue;
    return { level: t < 0.5 ? from.level : to.level, y: from.y + (to.y - from.y) * t };
  }
  return { level, y: floorAt(room, level)?.y ?? 0 };
}

/** How high a room's walls stand once its roof is lifted: the top of its tallest floor (m). */
export const ceiling = (room: Room) => Math.max(...room.floors.map((f) => f.y + f.height));

/** How far along a wall (m) the point nearest (x, z) lies, and how far off it that is. */
function onWall(w: RoomWall, x: number, z: number): [along: number, off: number] {
  const [dx, dz] = [w.x1 - w.x0, w.z1 - w.z0];
  const length = Math.hypot(dx, dz) || 1;
  const along = ((x - w.x0) * dx + (z - w.z0) * dz) / length;
  const off = Math.abs((x - w.x0) * dz - (z - w.z0) * dx) / length;
  return [along, along < 0 || along > length ? Infinity : off];
}

/** What a building looks like to the checks: its id, its footprint and whether it's a landmark. */
export interface RoomBuilding {
  id: number;
  ring: ArrayLike<number>;
  landmark: boolean;
}

/**
 * Everything wrong with a room, against the city (empty if nothing): the building exists and is
 * a landmark, every floor's rings lie inside the footprint and none crosses itself, the door is
 * in a gap of a wall of the ground floor, and every stair joins two floors that exist, starting
 * on its own floor's slab and arriving on the next.
 */
export function roomProblems(room: Room, building: RoomBuilding | undefined): string[] {
  const problems: string[] = [];
  const say = (what: string) => problems.push(`${room.name}: ${what}`);
  if (!building) return [`${room.name}: no building ${room.oidn} in the city`];
  if (!building.landmark) say(`building ${room.oidn} is not a landmark footprint`);
  const inside = (ring: ArrayLike<number>) => {
    for (let i = 0; i < ring.length; i += 2) {
      if (!inRing(building.ring, ring[i]!, ring[i + 1]!)) return false;
    }
    return true;
  };
  const levels = new Set(room.floors.map((f) => f.level));
  if (levels.size !== room.floors.length) say('two floors share a level');
  if (!levels.has(0)) say('no ground floor (level 0)');
  for (const f of room.floors) {
    for (const ring of [f.slab, ...f.holes]) {
      if (ring.length < 6) say(`a ring on floor ${f.level} has under three corners`);
      else if (selfIntersects(ring)) say(`a ring on floor ${f.level} crosses itself`);
      if (!inside(ring)) say(`a ring on floor ${f.level} reaches out of the footprint`);
    }
    for (const p of f.props) {
      if (!Object.hasOwn(PROP_SIZES, p.kind))
        say(`floor ${f.level} has a ${p.kind}, which isn't a furnishing`);
      else if (!inRing(f.slab, p.x, p.z))
        say(`a ${p.kind} on floor ${f.level} stands off its slab`);
    }
    for (const s of f.stairs) {
      const to = floorAt(room, s.to);
      if (!to || s.to <= f.level) {
        say(`a stair on floor ${f.level} leads to no floor above it (${s.to})`);
        continue;
      }
      const corners = stairCorners(s);
      const foot = [(corners[0]! + corners[2]!) / 2, (corners[1]! + corners[3]!) / 2] as const;
      const top = [(corners[4]! + corners[6]!) / 2, (corners[5]! + corners[7]!) / 2] as const;
      if (!inRing(f.slab, ...foot) || !inside(corners))
        say(`a stair on floor ${f.level} doesn't start on its slab`);
      // Its top lands on the floor above, past the stairwell it rises through.
      const [ux, uz] = [Math.sin(s.angle) * 0.5, Math.cos(s.angle) * 0.5];
      const landing = [top[0] + ux, top[1] + uz] as const;
      const inHole = to.holes.some((h) => inRing(h, ...landing));
      if (!inRing(to.slab, ...landing) || inHole)
        say(`a stair on floor ${f.level} doesn't arrive on floor ${s.to}`);
    }
  }
  const ground = floorAt(room, 0);
  const { x, z } = room.door;
  const inGap = ground?.walls.some((w) => {
    const [along, off] = onWall(w, x, z);
    return off <= 0.6 && w.gaps.some(([a, b]) => along >= a && along <= b);
  });
  if (!inGap) say('the door is in no gap of a ground-floor wall');
  return problems;
}
