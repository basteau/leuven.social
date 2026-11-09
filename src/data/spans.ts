/**
 * What the bake holds up and sinks: OSM's bridges and tunnels, read against what they cross, as
 * decks, ramps and tunnels. Everything else on the map is draped on one smoothed landform, which
 * has no embankments or cuttings; so a structure's height is a clearance (what has to fit under
 * it), not a reading of the LiDAR, and it starts and ends at the ground the map draws.
 */

import { CYCLE_LANE } from './city.ts';
import type { Carries, Deck, Path, Ramp, Tunnel } from './city.ts';
import { pointInRing, signedArea, simplifyLine, uncoveredPieces } from './geometry.ts';

type Tags = Record<string, string | undefined>;

/** One OSM way: its centre line and tags. */
export interface SpanWay {
  line: ArrayLike<number>;
  tags: Tags;
}

/** What the bake knows of the ground, asked by the planner. */
export interface SpanGround {
  /** Whether (x, z) is water. */
  water(x: number, z: number): boolean;
  /** Half the width of the road surface round (x, z), at most `reach` (m), across (nx, nz). */
  roadHalf(x: number, z: number, nx: number, nz: number, reach: number): number;
  /** Whether a pier at (x, z) would stand on a carriageway. */
  roadway(x: number, z: number): boolean;
}

export interface SpanPlan {
  decks: Deck[];
  ramps: Ramp[];
  tunnels: Tunnel[];
  /** The GRB outlines the decks took: the rest stay at the ground. */
  taken: Set<number>;
  /** The road and path ways the decks and tunnels carry, which aren't drawn on the ground. */
  carried: Set<SpanWay>;
  /** Roads over GRB outlines that stay at the ground: their carriageway, which the GRB leaves out. */
  groundLanes: Path[];
}

/** What must fit under a deck (m over the terrain), or the height of the deck over water. */
const CLEARANCE = { rail: 7.5, road: 5.2, path: 3.4 } as const;
/** How deep a tunnel's floor lies (m). */
const DEPTH = { road: 5.4, path: 3.4, rail: 6.8 } as const;
/** Steepest a ramp is (rise per metre) when it has the room, and when it hasn't. */
const GRADE = { road: 0.06, path: 0.08, rail: 0.025 } as const;
const STEEPEST = 0.12;
/** How far past its end an approach is followed in a straight-ish line (m). */
const MOST_APPROACH = 170;
/** How much of a turn an approach follows (degrees). */
const MOST_TURN = 55;
/** A deck's height at a span over water: its crown, from the length it has to rise and fall in. */
const CROWN = { base: 0.5, perMetre: 0.045, most: 2.4 } as const;
/** How low a deck over nothing mapped stands (a boardwalk, a culvert) (m). */
const LOW_DECK = 0.45;
/**
 * How far a line may stray to lose a point (m). A ramp's rise is linear along it, so a point on a
 * straight stretch is a cross-section cut through all the ground for nothing.
 */
const TIDY = 0.3;
/** A path's ramp may stop at a carriageway once it has run this far: room to reach its depth (m). */
const PATH_RAMP = 30;
/** How far a ramp runs on under its deck or into its tunnel, so a walker steps between the two. */
const OVERLAP = 1.5;
/** Less room than this on either side for a ramp (m) and a deck stays just over the ground. */
const MIN_ROOM = 12;
/** An arched deck has a point at least this often (m). */
const ARCH_STEP = 4;
/** How far apart a deck's piers stand along it (m). */
const PIER_SPACING = 14;
/** Past the end of a deck's ring its axis still runs on, so the ring lies wholly over it (m). */
const AXIS_RUN = 1.5;
/** Grade separation over a road under this far from a rail bridge is the same span of it (m). */
const SAME_SPAN = 5;

const off = (value: string | undefined) => value === undefined || value === 'no';
const key = (x: number, z: number) => `${Math.round(x * 5)},${Math.round(z * 5)}`;
const layerOf = (tags: Tags) => {
  const layer = Number(tags.layer ?? 0);
  return Number.isFinite(layer) ? layer : 0;
};

const PATH_WAYS = new Set(['footway', 'path', 'cycleway', 'steps', 'pedestrian']);
/** What a highway way carries. */
export function carriesOf(tags: Tags): Carries | null {
  if (tags.railway === 'rail') return 'rail';
  const highway = tags.highway;
  if (!highway || highway === 'proposed' || highway === 'construction') return null;
  return PATH_WAYS.has(highway) ? 'path' : 'road';
}

const lanesWidth = (tags: Tags) => {
  const lanes = Number.parseFloat(tags.lanes ?? '');
  return (Number.isFinite(lanes) && lanes > 0 ? lanes : 2) * 3.2;
};

/** Length of a flat [x, z, …] line (m). */
export function lineLength(line: ArrayLike<number>): number {
  let total = 0;
  for (let i = 0; i + 3 < line.length; i += 2) {
    total += Math.hypot(line[i + 2]! - line[i]!, line[i + 3]! - line[i + 1]!);
  }
  return total;
}

/** Where along a flat line (m) the point nearest (x, z) is. */
function nearestAlong(line: ArrayLike<number>, x: number, z: number): number {
  let [run, best, nearest] = [0, 0, Infinity];
  for (let i = 0; i + 3 < line.length; i += 2) {
    const [ax, az] = [line[i]!, line[i + 1]!];
    const [dx, dz] = [line[i + 2]! - ax, line[i + 3]! - az];
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) continue;
    const t = Math.min(len, Math.max(0, ((x - ax) * dx + (z - az) * dz) / len));
    const d = Math.hypot(ax + (dx / len) * t - x, az + (dz / len) * t - z);
    if (d < nearest) [nearest, best] = [d, run + t];
    run += len;
  }
  return best;
}

/** A line of flat [x, z, …] points as a list of [x, z] pairs. */
const pairs = (line: ArrayLike<number>): [number, number][] =>
  Array.from({ length: line.length / 2 }, (_, i) => [line[i * 2]!, line[i * 2 + 1]!]);

/** The part of a flat line from `a` to `b` metres along it, its ends included. */
function sliceLine(line: ArrayLike<number>, a: number, b: number): number[] {
  const out: number[] = [];
  let run = 0;
  for (let i = 0; i + 3 < line.length; i += 2) {
    const [ax, az, bx, bz] = [line[i]!, line[i + 1]!, line[i + 2]!, line[i + 3]!];
    const len = Math.hypot(bx - ax, bz - az);
    const [t0, t1] = [(a - run) / (len || 1), (b - run) / (len || 1)];
    if (t1 >= 0 && t0 <= 1) {
      const [s, e] = [Math.max(0, t0), Math.min(1, t1)];
      if (!out.length) out.push(ax + (bx - ax) * s, az + (bz - az) * s);
      out.push(ax + (bx - ax) * e, az + (bz - az) * e);
    }
    run += len;
  }
  return out;
}

/** A flat line with a point at least every `step` metres. */
function resampled(line: ArrayLike<number>, step: number): number[] {
  const out = [line[0]!, line[1]!];
  for (let i = 0; i + 3 < line.length; i += 2) {
    const [ax, az, bx, bz] = [line[i]!, line[i + 1]!, line[i + 2]!, line[i + 3]!];
    const pieces = Math.ceil(Math.hypot(bx - ax, bz - az) / step);
    for (let k = 1; k <= pieces; k++) {
      out.push(ax + ((bx - ax) * k) / pieces, az + ((bz - az) * k) / pieces);
    }
  }
  return out;
}

/** The point `run` metres along a flat line, and the direction it is heading there. */
function pointAlong(line: ArrayLike<number>, run: number): [number, number, number, number] {
  let left = run;
  const n = line.length / 2;
  for (let i = 0; i + 1 < n; i++) {
    const [ax, az, bx, bz] = [line[i * 2]!, line[i * 2 + 1]!, line[i * 2 + 2]!, line[i * 2 + 3]!];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 1e-6) continue;
    if (left <= len || i + 2 === n) {
      const t = len ? Math.min(1, Math.max(0, left / len)) : 0;
      return [ax + (bx - ax) * t, az + (bz - az) * t, (bx - ax) / len, (bz - az) / len];
    }
    left -= len;
  }
  return [line[0]!, line[1]!, 1, 0];
}

function lineBox(line: ArrayLike<number>): [number, number, number, number] {
  let [minX, minZ, maxX, maxZ] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 1 < line.length; i += 2) {
    [minX, maxX] = [Math.min(minX, line[i]!), Math.max(maxX, line[i]!)];
    [minZ, maxZ] = [Math.min(minZ, line[i + 1]!), Math.max(maxZ, line[i + 1]!)];
  }
  return [minX, minZ, maxX, maxZ];
}

/** Whether two segments cross, and where along the first (0 to 1). */
function crossAt(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
  dx: number,
  dz: number,
): number | null {
  const [rx, rz, sx, sz] = [bx - ax, bz - az, dx - cx, dz - cz];
  const denom = rx * sz - rz * sx;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((cx - ax) * sz - (cz - az) * sx) / denom;
  const u = ((cx - ax) * rz - (cz - az) * rx) / denom;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}

/** Whether (x, z) lies within `reach` of any of the lines. */
function nearLine(
  x: number,
  z: number,
  lines: readonly ArrayLike<number>[],
  reach: number,
): boolean {
  for (const line of lines) {
    for (let k = 0; k + 3 < line.length; k += 2) {
      const [ax, az, bx, bz] = [line[k]!, line[k + 1]!, line[k + 2]!, line[k + 3]!];
      const [dx, dz] = [bx - ax, bz - az];
      const t = Math.min(
        1,
        Math.max(0, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)),
      );
      if (Math.hypot(ax + dx * t - x, az + dz * t - z) < reach) return true;
    }
  }
  return false;
}

/** Metres along `line` where it crosses any line of `others`. */
function crossings(line: ArrayLike<number>, others: readonly ArrayLike<number>[]): number[] {
  const found: number[] = [];
  let run = 0;
  for (let i = 0; i + 3 < line.length; i += 2) {
    const [ax, az, bx, bz] = [line[i]!, line[i + 1]!, line[i + 2]!, line[i + 3]!];
    const len = Math.hypot(bx - ax, bz - az);
    for (const other of others) {
      for (let k = 0; k + 3 < other.length; k += 2) {
        const t = crossAt(ax, az, bx, bz, other[k]!, other[k + 1]!, other[k + 2]!, other[k + 3]!);
        if (t !== null) found.push(run + t * len);
      }
    }
    run += len;
  }
  return found;
}

/** Lines by the 40 m cells their boxes touch, for asking what crosses a way. */
class LineIndex {
  readonly #cells = new Map<string, ArrayLike<number>[]>();

  add(line: ArrayLike<number>): void {
    const [minX, minZ, maxX, maxZ] = lineBox(line);
    for (let i = Math.floor(minX / 40); i <= Math.floor(maxX / 40); i++) {
      for (let j = Math.floor(minZ / 40); j <= Math.floor(maxZ / 40); j++) {
        const list = this.#cells.get(`${i},${j}`);
        if (list) list.push(line);
        else this.#cells.set(`${i},${j}`, [line]);
      }
    }
  }

  /** The lines that may cross `line`. */
  near(line: ArrayLike<number>): ArrayLike<number>[] {
    const [minX, minZ, maxX, maxZ] = lineBox(line);
    const found = new Set<ArrayLike<number>>();
    for (let i = Math.floor(minX / 40); i <= Math.floor(maxX / 40); i++) {
      for (let j = Math.floor(minZ / 40); j <= Math.floor(maxZ / 40); j++) {
        for (const l of this.#cells.get(`${i},${j}`) ?? []) found.add(l);
      }
    }
    return [...found];
  }
}

const reversed = (line: ArrayLike<number>) => {
  const out: number[] = [];
  for (let i = line.length - 2; i >= 0; i -= 2) out.push(line[i]!, line[i + 1]!);
  return out;
};

/** The ring's points in counter-clockwise order. */
function ccw(ring: ArrayLike<number>): number[] {
  return signedArea(ring) >= 0 ? Array.from(ring) : reversed(ring);
}

/** A ribbon `half` either side of a line, as a ring. */
function ribbon(line: ArrayLike<number>, half: number): Float32Array {
  const pts = pairs(line);
  const n = pts.length;
  const side = (sign: number) =>
    pts.flatMap(([x, z], i) => {
      const [px, pz] = pts[Math.max(0, i - 1)]!;
      const [qx, qz] = pts[Math.min(n - 1, i + 1)]!;
      const length = Math.hypot(qx - px, qz - pz) || 1;
      const [ux, uz] = [(qx - px) / length, (qz - pz) / length];
      return [x + uz * half * sign, z - ux * half * sign];
    });
  return Float32Array.from(ccw([...side(1), ...reversed(side(-1))]));
}

/** A ring's edges, each as a two-point line. */
const ringEdges = (ring: ArrayLike<number>): number[][] => {
  const n = ring.length / 2;
  return Array.from({ length: n }, (_, i) => [
    ring[i * 2]!,
    ring[i * 2 + 1]!,
    ring[((i + 1) % n) * 2]!,
    ring[((i + 1) % n) * 2 + 1]!,
  ]);
};

/** The piece of a line within `run` metres from its start, a point inserted at the cut. */
function truncate(line: readonly number[], run: number): number[] {
  const out = [line[0]!, line[1]!];
  let total = 0;
  for (let i = 0; i + 3 < line.length; i += 2) {
    const [ax, az, bx, bz] = [line[i]!, line[i + 1]!, line[i + 2]!, line[i + 3]!];
    const len = Math.hypot(bx - ax, bz - az);
    if (total + len >= run) {
      const t = (run - total) / (len || 1);
      out.push(ax + (bx - ax) * t, az + (bz - az) * t);
      return out;
    }
    out.push(bx, bz);
    total += len;
  }
  return out;
}

/** Rises from `peak` at the first point to 0 over the line's length (metres along, linear). */
function fallingRise(line: readonly number[], peak: number): Float32Array {
  const n = line.length / 2;
  const total = lineLength(line) || 1;
  const rise = new Float32Array(n);
  let run = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0)
      run += Math.hypot(line[i * 2]! - line[i * 2 - 2]!, line[i * 2 + 1]! - line[i * 2 - 1]!);
    rise[i] = peak * Math.max(0, 1 - run / total);
  }
  return rise;
}

/** Ways that follow on from one another, each as one line; a branch starts another. */
function chains(ways: readonly SpanWay[]): { ways: SpanWay[]; whole: SpanWay }[] {
  const left = ways.toSorted((a, b) => lineLength(b.line) - lineLength(a.line));
  const out: { ways: SpanWay[]; whole: SpanWay }[] = [];
  while (left.length) {
    const seed = left.shift()!;
    const members = [seed];
    const line = Array.from(seed.line);
    for (let grew = true; grew;) {
      grew = false;
      for (const [i, way] of left.entries()) {
        const other = Array.from(way.line);
        const [s, e] = [key(other[0]!, other[1]!), key(other.at(-2)!, other.at(-1)!)];
        const [head, tail] = [key(line[0]!, line[1]!), key(line.at(-2)!, line.at(-1)!)];
        if (s === tail) line.push(...other.slice(2));
        else if (e === tail) line.push(...reversed(other).slice(2));
        else if (e === head) line.unshift(...other.slice(0, -2));
        else if (s === head) line.unshift(...reversed(other).slice(0, -2));
        else continue;
        members.push(way);
        left.splice(i, 1);
        grew = true;
        break;
      }
    }
    out.push({ ways: members, whole: { line, tags: seed.tags } });
  }
  return out;
}

/** Plans what the bake holds up and sinks, read off OSM's ways and the GRB's bridge outlines. */
export function planSpans(
  roads: readonly SpanWay[],
  rails: readonly SpanWay[],
  rings: readonly ArrayLike<number>[],
  ground: SpanGround,
): SpanPlan {
  const surface = roads.filter(
    (w) => carriesOf(w.tags) && off(w.tags.bridge) && off(w.tags.tunnel) && layerOf(w.tags) <= 0,
  );
  const railLines = rails.filter((w) => off(w.tags.tunnel));
  const railBridges = railLines.filter((w) => !off(w.tags.bridge));
  const lower = new LineIndex();
  const surfaceOf = new Map(surface.map((way) => [way.line, way]));
  for (const { line } of surface) lower.add(line);
  const railsBelow = new LineIndex();
  for (const { line } of railLines)
    if (!railBridges.some((b) => b.line === line)) railsBelow.add(line);

  // The way each end of a way runs on into, per carrier.
  const ends = new Map<string, { way: SpanWay; start: boolean }[]>();
  const anywhere = [...roads, ...rails];
  for (const way of anywhere) {
    const n = way.line.length / 2;
    for (const [i, start] of [
      [0, true],
      [n - 1, false],
    ] as const) {
      const k = key(way.line[i * 2]!, way.line[i * 2 + 1]!);
      const list = ends.get(k);
      if (list) list.push({ way, start });
      else ends.set(k, [{ way, start }]);
    }
  }

  /** A line from (x, z) outward along whichever way carries on straightest, up to `length`. */
  const approach = (
    x: number,
    z: number,
    dirX: number,
    dirZ: number,
    carries: Carries,
    length: number,
  ): number[] => {
    const out = [x, z];
    let [cx, cz, hx, hz, left] = [x, z, dirX, dirZ, length];
    const used = new Set<SpanWay>();
    for (let step = 0; step < 24 && left > 0; step++) {
      // A junction stays at the ground: nothing branches off a ramp.
      if (step > 0 && (ends.get(key(cx, cz)) ?? []).length > 2) break;
      let next: { way: SpanWay; start: boolean } | undefined;
      let best = Math.cos((MOST_TURN * Math.PI) / 180);
      for (const c of ends.get(key(cx, cz)) ?? []) {
        if (used.has(c.way) || carriesOf(c.way.tags) !== carries) continue;
        if (!off(c.way.tags.tunnel) || !off(c.way.tags.bridge)) continue;
        const [ax, az] = pointAlong(c.start ? c.way.line : reversed(c.way.line), 0);
        const [bx, bz] = pointAlong(c.start ? c.way.line : reversed(c.way.line), 1);
        const len = Math.hypot(bx - ax, bz - az) || 1;
        const cos = ((bx - ax) * hx + (bz - az) * hz) / len;
        if (cos > best) [best, next] = [cos, c];
      }
      if (!next) break;
      used.add(next.way);
      const line = next.start ? Array.from(next.way.line) : reversed(next.way.line);
      for (let i = 2; i + 1 < line.length && left > 0; i += 2) {
        const [dx, dz] = [line[i]! - cx, line[i + 1]! - cz];
        const len = Math.hypot(dx, dz);
        if (len < 1e-6) continue;
        let take = Math.min(left, len);
        // A path's ramp stops short of a carriageway: the road beside it stays where it is.
        let onRoad = false;
        if (carries === 'path') {
          const before = length - left;
          for (let d = 1; d < take && !onRoad; d++) {
            onRoad =
              before + d > PATH_RAMP && ground.roadway(cx + (dx / len) * d, cz + (dz / len) * d);
            if (onRoad) take = d - 1;
          }
        }
        [cx, cz, hx, hz, left] = [
          cx + (dx / len) * take,
          cz + (dz / len) * take,
          dx / len,
          dz / len,
          left - take,
        ];
        out.push(cx, cz);
        if (onRoad) return out;
      }
    }
    return out;
  };

  const decks: Deck[] = [];
  const ramps: Ramp[] = [];
  const tunnels: Tunnel[] = [];
  const taken = new Set<number>();
  const carried = new Set<SpanWay>();

  /** The half width of a ramp along `line`, from the road surface or the way itself. */
  const widthOf = (line: readonly number[], way: SpanWay, carries: Carries) => {
    if (carries === 'rail') return 3;
    const pathHalf = (Number.parseFloat(way.tags.width ?? '') || 2.2) / 2 + 0.3;
    if (carries === 'path') return Math.max(1.4, pathHalf);
    const fallback = lanesWidth(way.tags) / 2 + 2;
    const run = lineLength(line);
    let widest = 0;
    for (const t of [0.15, 0.5, 0.85]) {
      const [x, z, ux, uz] = pointAlong(line, run * t);
      widest = Math.max(
        widest,
        Math.max(ground.roadHalf(x, z, uz, -ux, 14), ground.roadHalf(x, z, -uz, ux, 14)),
      );
    }
    return Math.min(fallback + 2.5, Math.max(1.8, widest > 0 ? widest + 0.2 : fallback));
  };

  /** A ramp from `tip` outward along the road, falling or rising to the ground, if it can. */
  const addRamp = (
    tip: [number, number],
    into: [number, number],
    peak: number,
    way: SpanWay,
    carries: Carries,
    overlap = OVERLAP,
    leadIn: readonly number[] = [],
  ) => {
    const need = Math.abs(peak) / GRADE[carries];
    const lead = leadIn.length ? [...tip, ...leadIn] : [tip[0], tip[1]];
    const [lastX, lastZ] = [lead[lead.length - 2]!, lead[lead.length - 1]!];
    const [fromX, fromZ] = leadIn.length
      ? [lead[lead.length - 4]!, lead[lead.length - 3]!]
      : [into[0], into[1]];
    const available = [
      ...lead,
      ...approach(lastX, lastZ, lastX - fromX, lastZ - fromZ, carries, MOST_APPROACH).slice(2),
    ];
    const room = lineLength(available);
    if (room < 3) return 0;
    const length = Math.min(room, Math.max(need, Math.abs(peak) / STEEPEST));
    const line = simplifyLine(truncate(available, length), TIDY);
    const rise = fallingRise(line, peak);
    const along = Math.hypot(tip[0] - into[0], tip[1] - into[1]) || 1;
    const [ix, iz] = [(into[0] - tip[0]) / along, (into[1] - tip[1]) / along];
    ramps.push({
      line: Float32Array.of(tip[0] + ix * overlap, tip[1] + iz * overlap, ...line),
      rise: Float32Array.of(peak, ...rise),
      half: widthOf(line, way, carries),
      rail: carries === 'rail',
    });
    return length;
  };

  // Bridges, ring by ring where the GRB drew one, else way by connected way.
  const bridges = roads.filter(
    (w) =>
      carriesOf(w.tags) &&
      !off(w.tags.bridge) &&
      off(w.tags.tunnel) &&
      off(w.tags.indoor) &&
      off(w.tags.covered) &&
      layerOf(w.tags) >= 0 &&
      layerOf(w.tags) <= 2 &&
      lineLength(w.line) >= 2,
  );
  const ringOf = (way: SpanWay) => {
    const [x, z] = pointAlong(way.line, lineLength(way.line) / 2);
    return rings.findIndex((r) => pointInRing(r, x, z));
  };
  const groups = new Map<string, SpanWay[]>();
  for (const way of bridges) {
    const ring = ringOf(way);
    const k = ring >= 0 ? `r${ring}` : `w${groups.size}`;
    const list = groups.get(k);
    if (list) list.push(way);
    else groups.set(k, [way]);
  }
  // Ways without a GRB outline merge with those they run into.
  const loose = [...groups.entries()].filter(([k]) => k.startsWith('w'));
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 0; i < loose.length; i++) {
      for (let j = i + 1; j < loose.length; j++) {
        const [a, b] = [loose[i]![1], loose[j]![1]];
        const endsOf = (w: SpanWay) => [
          key(w.line[0]!, w.line[1]!),
          key(w.line[w.line.length - 2]!, w.line[w.line.length - 1]!),
        ];
        const touches = a.some((wa) =>
          b.some((wb) => endsOf(wa).some((e) => endsOf(wb).includes(e))),
        );
        if (touches && carriesOf(a[0]!.tags) === carriesOf(b[0]!.tags)) {
          a.push(...b);
          groups.delete(loose[j]![0]);
          loose.splice(j, 1);
          changed = true;
          j--;
        }
      }
    }
  }

  // Without an outline, ways that follow on from one another are one deck along the whole of them.
  const decksOf = [...groups].flatMap(([id, ways]): [string, SpanWay[], SpanWay][] =>
    id.startsWith('r')
      ? [[id, ways, ways.reduce((a, b) => (lineLength(b.line) > lineLength(a.line) ? b : a))]]
      : chains(ways).map((chain): [string, SpanWay[], SpanWay] => [id, chain.ways, chain.whole]),
  );
  for (const [id, ways, longest] of decksOf) {
    const ringIndex = id.startsWith('r') ? Number(id.slice(1)) : -1;
    const carries = carriesOf(longest.tags)!;
    // Over the GRB's outline only: the way can run on past it, and that stretch is the ramp's.
    const outline = ringIndex >= 0 ? rings[ringIndex]! : null;
    const pieces = outline
      ? uncoveredPieces(longest.line, (x, z) => !pointInRing(outline, x, z))
      : [Array.from(longest.line)];
    const axisLine = simplifyLine(
      pieces.reduce((a, b) => (lineLength(b) > lineLength(a) ? b : a), [] as number[]),
      TIDY,
    );
    const length = lineLength(axisLine);
    if (length < 2) continue;

    // What runs below: tracks need the most room, then roads, then only paths.
    let clearance = 0;
    for (const { line } of ways) {
      if (crossings(line, railsBelow.near(line)).length)
        clearance = Math.max(clearance, CLEARANCE.rail);
      for (const other of lower.near(line)) {
        if (other === line || !crossings(line, [other]).length) continue;
        const under = surfaceOf.get(other)!;
        clearance = Math.max(
          clearance,
          CLEARANCE[carriesOf(under.tags) === 'path' ? 'path' : 'road'],
        );
      }
    }
    const samples = [0.1, 0.3, 0.5, 0.7, 0.9].map((t) => pointAlong(axisLine, length * t));
    const overWater = samples.some(([x, z]) => ground.water(x, z));

    const [ax, az, ux0, uz0] = pointAlong(axisLine, 0);
    const [bx, bz, ux1, uz1] = pointAlong(axisLine, length);
    const start: [number, number] = [ax, az];
    const stop: [number, number] = [bx, bz];
    const before: [number, number] = [ax + ux0, az + uz0];
    const after: [number, number] = [bx - ux1, bz - uz1];

    let rise = 0;
    let crown = 0;
    // The way's stretch from where it leaves the outline on to its end, at each end of the deck.
    const wayRun = (tip: [number, number], atStart: boolean): number[] => {
      const line = atStart ? reversed(longest.line) : Array.from(longest.line);
      const lead = sliceLine(line, nearestAlong(line, tip[0], tip[1]), lineLength(line)).slice(2);
      return lineLength([...tip, ...lead]) < 0.01 ? [] : lead;
    };
    if (clearance > 0) {
      // A deck stands no higher than its approaches can reach at the steepest a ramp goes.
      const room = (tip: [number, number], into: [number, number], atStart: boolean) => {
        const lead = wayRun(tip, atStart);
        const end = lead.length ? [lead[lead.length - 2]!, lead[lead.length - 1]!] : tip;
        const inner = lead.length >= 4 ? [lead[lead.length - 4]!, lead[lead.length - 3]!] : into;
        return (
          lineLength([...tip, ...lead]) +
          lineLength(
            approach(
              end[0]!,
              end[1]!,
              end[0]! - inner[0]!,
              end[1]! - inner[1]!,
              carries,
              MOST_APPROACH,
            ),
          )
        );
      };
      const roomAtStart = room(start, before, true);
      const roomAtStop = room(stop, after, false);
      if (Math.min(roomAtStart, roomAtStop) < MIN_ROOM) {
        // No way to climb to a clearance: a deck just over the ground.
        rise = LOW_DECK;
      } else {
        const limit = Math.min(roomAtStart, roomAtStop) * STEEPEST;
        rise = Math.min(clearance, Math.max(2.4, limit));
        addRamp(start, before, rise, longest, carries, OVERLAP, wayRun(start, true));
        addRamp(stop, after, rise, longest, carries, OVERLAP, wayRun(stop, false));
      }
    } else if (overWater) {
      crown = Math.min(CROWN.most, CROWN.base + length * CROWN.perMetre);
    } else {
      rise = LOW_DECK;
    }

    let ring: number[];
    if (ringIndex >= 0) {
      ring = ccw(rings[ringIndex]!);
      taken.add(ringIndex);
    } else {
      const tagged = Number.parseFloat(longest.tags.width ?? '');
      const half =
        carries === 'road'
          ? lanesWidth(longest.tags) / 2 + 1.6
          : Math.max(1.2, (tagged || 2.4) / 2 + 0.2);
      ring = Array.from(ribbon(axisLine, half));
    }

    // Past both ends, as far as the outline's corners reach, so all of it lies over the axis.
    const past = (px: number, pz: number, ux: number, uz: number) =>
      Math.max(AXIS_RUN, ...pairs(ring).map(([x, z]) => (x - px) * ux + (z - pz) * uz + AXIS_RUN));
    const before0 = past(ax, az, -ux0, -uz0);
    const after1 = past(bx, bz, ux1, uz1);
    const whole = [
      ax - ux0 * before0,
      az - uz0 * before0,
      ...axisLine,
      bx + ux1 * after1,
      bz + uz1 * after1,
    ];
    // An arch needs points to bend at; a flat deck doesn't.
    const axis = crown > 0 ? resampled(whole, ARCH_STEP) : whole;
    const profile = new Float32Array(axis.length / 2);
    let run = 0;
    for (let i = 0; i < profile.length; i++) {
      if (i > 0) {
        run += Math.hypot(axis[i * 2]! - axis[i * 2 - 2]!, axis[i * 2 + 1]! - axis[i * 2 - 1]!);
      }
      const t = Math.min(1, Math.max(0, (run - before0) / length));
      profile[i] = rise + crown * 4 * t * (1 - t);
    }

    const lanes = ways.flatMap((way): Path[] => {
      carried.add(way);
      const c = carriesOf(way.tags);
      const width =
        c === 'road'
          ? Math.max(4.5, lanesWidth(way.tags))
          : way.tags.highway === 'cycleway'
            ? CYCLE_LANE
            : 0;
      if (!width) return [];
      return uncoveredPieces(way.line, (x, z) => !pointInRing(ring, x, z)).map((piece) => ({
        width,
        surface: 'asphalt' as const,
        line: Float32Array.from(simplifyLine(piece, TIDY)),
      }));
    });

    const piers: number[] = [];
    if (rise > 1 || crown > 0) {
      for (let at = PIER_SPACING / 2; at < length; at += PIER_SPACING) {
        const [x, z, ux, uz] = pointAlong(axisLine, at);
        for (const side of [1, -1]) {
          // As far out along the cross-section as the outline goes.
          let edge = 0;
          for (
            let d = 0.5;
            d < 16 && pointInRing(ring, x + uz * side * d, z - ux * side * d);
            d += 0.5
          ) {
            edge = d;
          }
          if (edge < 1.5) continue;
          const [px, pz] = [x + uz * side * (edge - 0.8), z - ux * side * (edge - 0.8)];
          if (
            ground.roadway(px, pz) ||
            nearLine(px, pz, railsBelow.near([px - 4, pz - 4, px + 4, pz + 4]), 3)
          ) {
            continue;
          }
          piers.push(px, pz);
        }
      }
    }

    decks.push({
      carries,
      ring: Float32Array.from(ring),
      axis: Float32Array.from(axis),
      rise: profile,
      piers: Float32Array.from(piers),
      lanes,
    });
  }

  // Railway bridges keep the tracks at the terrain, a deck under them, and the road beneath sinks.
  for (let r = 0; r < rings.length; r++) {
    if (taken.has(r)) continue;
    const over = railBridges.filter((w) => {
      const [x, z] = pointAlong(w.line, lineLength(w.line) / 2);
      return pointInRing(rings[r]!, x, z);
    });
    if (!over.length) continue;
    taken.add(r);
    const longest = over.reduce((a, b) => (lineLength(b.line) > lineLength(a.line) ? b : a));
    decks.push({
      carries: 'rail',
      ring: Float32Array.from(ccw(rings[r]!)),
      axis: Float32Array.from(longest.line),
      rise: new Float32Array(longest.line.length / 2),
      piers: new Float32Array(0),
      lanes: [],
    });
  }

  // A surface road across an outline left at the ground (a tunnel under it): its carriageway.
  const groundLanes: Path[] = [];
  for (let r = 0; r < rings.length; r++) {
    if (taken.has(r)) continue;
    const ring = rings[r]!;
    for (const way of surface) {
      if (carriesOf(way.tags) !== 'road') continue;
      const [ax, az] = pointAlong(way.line, lineLength(way.line) / 2);
      const [bx, bz] = [way.line[0]!, way.line[1]!];
      const inside = pointInRing(ring, ax, az) || pointInRing(ring, bx, bz);
      if (!inside && !crossings(way.line, ringEdges(ring)).length) continue;
      for (const piece of uncoveredPieces(way.line, (x, z) => !pointInRing(ring, x, z))) {
        groundLanes.push({
          width: Math.max(4.5, lanesWidth(way.tags)),
          surface: 'asphalt',
          line: Float32Array.from(piece),
        });
      }
    }
  }

  // A road under a railway bridge drops into a cutting, the tracks staying where they are.
  const railBridgeIndex = new LineIndex();
  for (const { line } of railBridges) railBridgeIndex.add(line);
  for (const way of surface) {
    const near = railBridgeIndex.near(way.line);
    if (!near.length) continue;
    const hits = crossings(way.line, near);
    if (!hits.length) continue;
    hits.sort((a, b) => a - b);
    const carries = carriesOf(way.tags)!;
    const depth = carries === 'path' ? DEPTH.path : DEPTH.road;
    const from = Math.max(0, hits[0]! - SAME_SPAN);
    const to = Math.min(lineLength(way.line), hits.at(-1)! + SAME_SPAN);
    const run = lineLength(way.line);
    const [sx, sz] = pointAlong(way.line, from);
    const [ex, ez] = pointAlong(way.line, to);
    const [, , ux, uz] = pointAlong(way.line, (from + to) / 2);
    addRamp(
      [sx, sz],
      [sx + ux, sz + uz],
      -depth,
      way,
      carries,
      to - from,
      reversed(sliceLine(way.line, 0, from)).slice(2),
    );
    addRamp(
      [ex, ez],
      [ex - ux, ez - uz],
      -depth,
      way,
      carries,
      0,
      sliceLine(way.line, to, run).slice(2),
    );
  }

  // Tunnels with a way in at both ends: the rest are garages and service ramps of their own.
  const covered = [...roads, ...rails].filter(
    (w) =>
      carriesOf(w.tags) && w.tags.tunnel === 'yes' && off(w.tags.indoor) && layerOf(w.tags) >= -2,
  );
  const reachable = new Set<SpanWay>();
  const links = new Map<SpanWay, SpanWay[]>();
  const coveredEnds = new Map<string, SpanWay[]>();
  for (const way of covered) {
    for (const k of [
      key(way.line[0]!, way.line[1]!),
      key(way.line[way.line.length - 2]!, way.line[way.line.length - 1]!),
    ]) {
      const list = coveredEnds.get(k);
      if (list) list.push(way);
      else coveredEnds.set(k, [way]);
    }
  }
  for (const way of covered) {
    const neighbours = new Set<SpanWay>();
    for (const k of [
      key(way.line[0]!, way.line[1]!),
      key(way.line[way.line.length - 2]!, way.line[way.line.length - 1]!),
    ]) {
      for (const other of coveredEnds.get(k) ?? []) if (other !== way) neighbours.add(other);
    }
    links.set(way, [...neighbours]);
  }
  const mouths = (way: SpanWay) => {
    const open = [];
    for (const [i, line] of [
      [0, way.line],
      [way.line.length - 2, way.line],
    ] as const) {
      const near = (ends.get(key(line[i]!, line[i + 1]!)) ?? []).filter(
        (c) => c.way !== way && off(c.way.tags.tunnel),
      );
      if (near.length) open.push(i === 0);
    }
    return open;
  };
  for (const way of covered) {
    if (reachable.has(way) || !mouths(way).length) continue;
    // Follow connected covered ways to one line.
    const chain: SpanWay[] = [way];
    reachable.add(way);
    for (let i = 0; i < chain.length; i++) {
      for (const other of links.get(chain[i]!) ?? []) {
        if (!reachable.has(other) && carriesOf(other.tags) === carriesOf(way.tags)) {
          reachable.add(other);
          chain.push(other);
        }
      }
    }
    const openings = chain.flatMap((w) => mouths(w).map(() => w));
    if (openings.length < 2) continue;
    const carries = carriesOf(way.tags)!;
    const longest = chain.reduce((a, b) => (lineLength(b.line) > lineLength(a.line) ? b : a));
    const total = chain.reduce((sum, w) => sum + lineLength(w.line), 0);
    if (total > 600) continue;
    for (const w of chain) carried.add(w);
    const depth = DEPTH[carries];
    const half = carries === 'rail' ? 3 : widthOf(Array.from(longest.line), longest, carries);
    for (const w of chain) {
      const [sx, sz, ux, uz] = pointAlong(w.line, 0);
      const [ex, ez, vx, vz] = pointAlong(w.line, lineLength(w.line));
      const outward = (x: number, z: number) =>
        (ends.get(key(x, z)) ?? []).some((c) => c.way !== w && off(c.way.tags.tunnel));
      const open: [boolean, boolean] = [outward(sx, sz), outward(ex, ez)];
      tunnels.push({
        carries,
        line: Float32Array.from(simplifyLine(w.line, TIDY)),
        half,
        depth,
        mouths: open,
      });
      if (open[0]) addRamp([sx, sz], [sx + ux, sz + uz], -depth, w, carries);
      if (open[1]) addRamp([ex, ez], [ex - vx, ez - vz], -depth, w, carries);
    }
  }
  return { decks, ramps, tunnels, taken, carried, groundLanes };
}
