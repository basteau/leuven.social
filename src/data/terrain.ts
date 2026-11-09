/**
 * The ground's height across the map: the landform the bake takes from the DHMV II DTM, smoothed
 * so kerbs, quay walls and cuttings are gone (docs/DATA.md), on a square grid anchored at Grote
 * Markt. It is read as triangles: each square split along one fixed diagonal, from its (i, j)
 * corner to (i + 1, j + 1). Heights are metres above the ground at Grote Markt, so the map's
 * centre stays at y = 0.
 *
 * What lies on the ground follows those triangles exactly: a flat layer is cut along their edges
 * (`clip`, `cut`) and each piece lifted corner by corner, so layers stacked a few millimetres
 * apart stay parallel. Rigid things (a house, a tree) stand at one height instead (`height`,
 * `base`).
 */

import type { Bounds, TerrainGrid } from './city.ts';

/** A point to cut: x, y, z, then any values carried along, each interpolated where it's cut. */
export type Corner = readonly number[];
export type Polygon = readonly Corner[];

/** Cuts that come this close to a corner (in steps) leave it whole. */
const EPSILON = 1e-9;

export class Terrain {
  readonly step: number;
  readonly minX: number;
  readonly minZ: number;
  readonly cols: number;
  readonly rows: number;
  readonly heights: Float32Array;
  readonly lowest: number;
  readonly highest: number;
  /** All one height: nothing to cut. */
  readonly #flat: boolean;
  /** The ground tracks lie on: only their own ramps move them (`landform`). */
  rails: Terrain = this;
  /** The surface of the decks, held up over this ground (`landform`). */
  decks: Terrain = this;

  /** A grid of 2 × 2 nodes or more, as the city file holds (format.ts checks it). */
  constructor({ step, minX, minZ, cols, rows, heights }: TerrainGrid) {
    this.step = step;
    this.minX = minX;
    this.minZ = minZ;
    this.cols = cols;
    this.rows = rows;
    this.heights = heights;
    let [lowest, highest] = [Infinity, -Infinity];
    for (const h of heights) [lowest, highest] = [Math.min(lowest, h), Math.max(highest, h)];
    this.lowest = lowest;
    this.highest = highest;
    this.#flat = lowest === highest;
  }

  /** The square (i, j) holding (x, z), and where in it (u, v from 0 to 1); clamped to the grid. */
  #locate(x: number, z: number): [number, number, number, number] {
    const fx = (x - this.minX) / this.step;
    const fz = (z - this.minZ) / this.step;
    const i = Math.min(this.cols - 2, Math.max(0, Math.floor(fx)));
    const j = Math.min(this.rows - 2, Math.max(0, Math.floor(fz)));
    return [i, j, Math.min(1, Math.max(0, fx - i)), Math.min(1, Math.max(0, fz - j))];
  }

  /** The ground at (x, z), as it is drawn: the landform, plus any earthworks there. */
  height(x: number, z: number): number {
    return this.plain(x, z);
  }

  /** The landform alone at (x, z). Off the grid, the height at its nearest edge. */
  plain(x: number, z: number): number {
    const [i, j, u, v] = this.#locate(x, z);
    const [a, b, c, d] = this.#square(i, j);
    return u >= v ? a + (b - a) * u + (d - b) * v : a + (d - c) * u + (c - a) * v;
  }

  /** Heights at the square's corners (i, j), (i + 1, j), (i, j + 1), (i + 1, j + 1). */
  #square(i: number, j: number): [number, number, number, number] {
    const h = this.heights;
    const k = j * this.cols + i;
    return [h[k]!, h[k + 1]!, h[k + this.cols]!, h[k + this.cols + 1]!];
  }

  /** The steepest grade of any triangle (rise per metre), for what's drawn off its own one. */
  get steepest(): number {
    let steepest = 0;
    for (let j = 0; j + 1 < this.rows; j++) {
      for (let i = 0; i + 1 < this.cols; i++) {
        const [a, b, c, d] = this.#square(i, j);
        steepest = Math.max(steepest, Math.hypot(b - a, d - b), Math.hypot(d - c, c - a));
      }
    }
    return steepest / this.step;
  }

  /**
   * The lowest ground under a ring's corners (flat [x0, z0, x1, z1, …]): where a rigid thing stands.
   * The landform's, never a ramp's: a house beside a cutting doesn't go down into it.
   */
  base(ring: ArrayLike<number>): number {
    let lowest = Infinity;
    for (let i = 0; i + 1 < ring.length; i += 2) {
      lowest = Math.min(lowest, this.plain(ring[i]!, ring[i + 1]!));
    }
    return lowest;
  }

  /** The lowest and highest ground anywhere within `bounds`. */
  range({ minX, minZ, maxX, maxZ }: Bounds): [number, number] {
    // The nodes round the bounds: the ground between them is never outside theirs.
    const node = (v: number, from: number, count: number, round: (v: number) => number) =>
      Math.min(count - 1, Math.max(0, round((v - from) / this.step)));
    const [i0, i1] = [
      node(minX, this.minX, this.cols, Math.floor),
      node(maxX, this.minX, this.cols, Math.ceil),
    ];
    const [j0, j1] = [
      node(minZ, this.minZ, this.rows, Math.floor),
      node(maxZ, this.minZ, this.rows, Math.ceil),
    ];
    let [lowest, highest] = [Infinity, -Infinity];
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const h = this.heights[j * this.cols + i]!;
        [lowest, highest] = [Math.min(lowest, h), Math.max(highest, h)];
      }
    }
    return [lowest, highest];
  }

  /**
   * A polygon cut along the triangles' edges: the lines x = minX + i · step, z = minZ + j · step
   * and their diagonals. Each piece lies in one triangle, so lifting its corners by the ground
   * puts it flat on it. A convex polygon gives convex pieces; a concave one may give pieces that
   * fold back along a cut, as a triangulation's bridges do. Corners carry any values after x,
   * y, z along, interpolated where they're cut, and a cut point is the same numbers in both
   * pieces either side of it.
   */
  clip(polygon: Polygon): Polygon[] {
    if (this.#flat) return [polygon];
    const { minX, minZ, step } = this;
    let pieces: Polygon[] = [polygon];
    for (const across of [
      (p: Corner) => (p[0]! - minX) / step,
      (p: Corner) => (p[2]! - minZ) / step,
      (p: Corner) => (p[0]! - minX - p[2]! + minZ) / step,
    ]) {
      const next: Polygon[] = [];
      for (const piece of pieces) split(piece, across, next);
      pieces = next;
    }
    return pieces;
  }

  /** The segment from a to b as points where it crosses the triangles' edges, its ends included. */
  cut(a: Corner, b: Corner): Corner[] {
    if (this.#flat) return [a, b];
    const { minX, minZ, step } = this;
    const [ax, az] = [(a[0]! - minX) / step, (a[2]! - minZ) / step];
    const [dx, dz] = [(b[0]! - minX) / step - ax, (b[2]! - minZ) / step - az];
    const at: number[] = [];
    for (const [from, delta] of [
      [ax, dx],
      [az, dz],
      [ax - az, dx - dz],
    ] as const) {
      if (Math.abs(delta) < EPSILON) continue;
      const [lo, hi] = [Math.min(from, from + delta), Math.max(from, from + delta)];
      for (let k = Math.floor(lo + EPSILON) + 1; k < hi - EPSILON; k++) at.push((k - from) / delta);
    }
    at.sort((s, t) => s - t);
    const points: Corner[] = [a];
    let last = 0;
    for (const t of at) {
      // A node is where three edges cross: one point for it.
      if (t - last < EPSILON || t + EPSILON > 1) continue;
      points.push(a.map((v, k) => v + (b[k]! - v) * t));
      last = t;
    }
    points.push(b);
    return points;
  }
}

/**
 * Where the edge from p to q crosses the line, from how far each end is past it (`cp`, `cq`):
 * worked out from the same end whichever way round the edge comes, so the pieces either side of
 * it get the same numbers, and share a vertex.
 */
function crossing(p: Corner, q: Corner, cp: number, cq: number): Corner {
  const forward = p[0]! < q[0]! || (p[0] === q[0] && p[2]! <= q[2]!);
  const [s, e, t] = forward ? [p, q, cp / (cp - cq)] : [q, p, cq / (cq - cp)];
  return s.map((v, k) => v + (e[k]! - v) * t);
}

/** `clipRing` for corners that carry values: the part of a flat, convex polygon inside a rectangle. */
export function clipPolygon(polygon: Polygon, b: Bounds): Polygon {
  let out = polygon;
  for (const inside of [
    (p: Corner) => p[0]! - b.minX,
    (p: Corner) => b.maxX - p[0]!,
    (p: Corner) => p[2]! - b.minZ,
    (p: Corner) => b.maxZ - p[2]!,
  ]) {
    const kept: Corner[] = [];
    for (const [i, p] of out.entries()) {
      const q = out[(i + 1) % out.length]!;
      const [dp, dq] = [inside(p), inside(q)];
      if (dp >= 0) kept.push(p);
      if (dp >= 0 !== dq >= 0) kept.push(crossing(p, q, dp, dq));
    }
    out = kept;
  }
  return out;
}

/**
 * Cuts a polygon along every line where `across` (in steps) is a whole number, adding the pieces
 * to `out`, lowest first: a sweep that keeps what lies below each line and carries the rest on.
 */
function split(polygon: Polygon, across: (p: Corner) => number, out: Polygon[]): void {
  let [lo, hi] = [Infinity, -Infinity];
  const values = polygon.map(across);
  for (const v of values) [lo, hi] = [Math.min(lo, v), Math.max(hi, v)];
  const [k0, k1] = [Math.floor(lo + EPSILON), Math.ceil(hi - EPSILON)];
  if (k1 - k0 <= 1) {
    out.push(polygon);
    return;
  }
  let rest = polygon;
  let at = values;
  for (let k = k0 + 1; k < k1 && rest.length >= 3; k++) {
    const below: Corner[] = [];
    const above: Corner[] = [];
    const n = rest.length;
    for (let i = 0; i < n; i++) {
      const [p, q] = [rest[i]!, rest[(i + 1) % n]!];
      const [cp, cq] = [at[i]! - k, at[(i + 1) % n]! - k];
      if (cp <= 0) below.push(p);
      if (cp >= 0) above.push(p);
      if ((cp < 0 && cq > 0) || (cp > 0 && cq < 0)) {
        const m = crossing(p, q, cp, cq);
        below.push(m);
        above.push(m);
      }
    }
    if (below.length >= 3) out.push(below);
    rest = above;
    at = rest.map(across);
  }
  if (rest.length >= 3) out.push(rest);
}

/** A length of ground lifted or sunk: its centre line, its rise at each point, its half width. */
export interface Strip {
  line: ArrayLike<number>;
  rise: ArrayLike<number>;
  half: number;
}

/** A piece of a strip between two of its points: a convex quad, its corners counter-clockwise. */
interface Quad {
  x: readonly [number, number, number, number];
  z: readonly [number, number, number, number];
  /** Which corners (a, b) make each end's cross-section: 0–3 at the start, 1–2 at the end. */
  rises: readonly [number, number];
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  /** How far it moves the ground at most: the strongest wins where strips overlap. */
  strength: number;
  /** The last piece of ground asked about, so a quad in two buckets is cut once. */
  seen: number;
}

/** How far a piece of a line may be mitred past its width at a bend. */
const MITRE = 1.6;
/** Buckets of quads (m). */
const QUAD_BUCKET = 64;
const bucketOf = (v: number) => Math.floor(v / QUAD_BUCKET);
/** One number per bucket: the map is a few hundred buckets either way of its middle. */
const bucketKey = (i: number, j: number) => i * 4096 + j;
/** Corners this close to an edge count as on it (m). */
const ON_EDGE = 1e-6;

/**
 * Where a strip's two sides lie at each point of its line, as a flat [dx, dz, …] from the line to
 * its side (the other side is minus that): mitred at bends, so neighbouring segments share one
 * cross-section. What carves the ground, the walls drawn along it and those walked into all ask.
 */
export function mitres(line: ArrayLike<number>, half: number): Float32Array {
  const n = line.length / 2;
  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const [px, pz] = i > 0 ? [line[i * 2 - 2]!, line[i * 2 - 1]!] : [line[0]!, line[1]!];
    const [qx, qz] =
      i < n - 1 ? [line[i * 2 + 2]!, line[i * 2 + 3]!] : [line[i * 2]!, line[i * 2 + 1]!];
    const [cx, cz] = [line[i * 2]!, line[i * 2 + 1]!];
    const [ax, az] = unit(cx - px, cz - pz, qx - cx, qz - cz);
    const [bx, bz] = unit(qx - cx, qz - cz, cx - px, cz - pz);
    const [mx, mz] = unit(ax + bx, az + bz, bx, bz);
    const scale = half / Math.max(1 / MITRE, Math.abs(mx * bx + mz * bz));
    out[i * 2] = mz * scale;
    out[i * 2 + 1] = -mx * scale;
  }
  return out;
}

/** The quads of a strip, one per segment. */
function stripQuads({ line, rise, half }: Strip): Quad[] {
  const n = line.length / 2;
  const across = mitres(line, half);
  const quads: Quad[] = [];
  for (let i = 0; i + 1 < n; i++) {
    const [ox, oz, px, pz] = [
      across[i * 2]!,
      across[i * 2 + 1]!,
      across[i * 2 + 2]!,
      across[i * 2 + 3]!,
    ];
    const [ax, az, bx, bz] = [line[i * 2]!, line[i * 2 + 1]!, line[i * 2 + 2]!, line[i * 2 + 3]!];
    let x = [ax + ox, bx + px, bx - px, ax - ox] as const;
    let z = [az + oz, bz + pz, bz - pz, az - oz] as const;
    let rises: [number, number] = [rise[i]!, rise[i + 1]!];
    const area = (x[1] - x[0]) * (z[2] - z[0]) - (x[2] - x[0]) * (z[1] - z[0]);
    if (Math.abs(area) < 1e-6) continue;
    if (area < 0) {
      x = [x[3], x[2], x[1], x[0]];
      z = [z[3], z[2], z[1], z[0]];
      rises = [rises[1], rises[0]];
    }
    if (!convex(x, z)) continue;
    quads.push({
      x,
      z,
      rises,
      minX: Math.min(...x),
      minZ: Math.min(...z),
      maxX: Math.max(...x),
      maxZ: Math.max(...z),
      strength: Math.max(Math.abs(rise[i]!), Math.abs(rise[i + 1]!)),
      seen: 0,
    });
  }
  return quads;
}

const unit = (dx: number, dz: number, fx: number, fz: number): [number, number] => {
  const length = Math.hypot(dx, dz);
  if (length > 1e-9) return [dx / length, dz / length];
  const other = Math.hypot(fx, fz) || 1;
  return [fx / other, fz / other];
};

function convex(x: readonly number[], z: readonly number[]): boolean {
  for (let i = 0; i < 4; i++) {
    const [a, b, c] = [i, (i + 1) % 4, (i + 2) % 4];
    if ((x[b]! - x[a]!) * (z[c]! - z[a]!) - (x[c]! - x[a]!) * (z[b]! - z[a]!) <= 0) return false;
  }
  return true;
}

/** How far past the line from corner a to corner b (x, z) lies, to its left: inside a quad. */
const leftOf = (q: Quad, a: number, x: number, z: number) => {
  const b = (a + 1) % 4;
  return (q.x[b]! - q.x[a]!) * (z - q.z[a]!) - (q.z[b]! - q.z[a]!) * (x - q.x[a]!);
};

/** The rise of a quad at a point in it: as far between its two ends as the point lies. */
function riseIn(q: Quad, x: number, z: number): number {
  const [rise0, rise1] = q.rises;
  if (rise0 === rise1) return rise0;
  // Corners 3 and 0 are the first end's cross-section, 1 and 2 the last's, and each is shared
  // with the quad next along, so two quads meet at the same height there.
  const from = Math.abs(leftOf(q, 3, x, z));
  const to = Math.abs(leftOf(q, 1, x, z));
  return rise0 + (rise1 - rise0) * (from / (from + to || 1));
}

/** Whether every corner of `piece` lies outside one of a quad's edges: it can't touch the quad. */
function whollyOutside(piece: Polygon, q: Quad): boolean {
  for (let a = 0; a < 4; a++) {
    if (piece.every((p) => leftOf(q, a, p[0]!, p[2]!) <= ON_EDGE)) return true;
  }
  return false;
}

/** The part of `piece` on each side of a quad's edge from corner a. */
function splitAt(piece: Polygon, q: Quad, a: number): [Polygon, Polygon] {
  const n = piece.length;
  const inside: Corner[] = [];
  const outside: Corner[] = [];
  const sides = piece.map((p) => leftOf(q, a, p[0]!, p[2]!));
  for (let i = 0; i < n; i++) {
    const [p, side] = [piece[i]!, sides[i]!];
    const [q2, next] = [piece[(i + 1) % n]!, sides[(i + 1) % n]!];
    if (side >= -ON_EDGE) inside.push(p);
    if (side <= ON_EDGE) outside.push(p);
    if ((side > ON_EDGE && next < -ON_EDGE) || (side < -ON_EDGE && next > ON_EDGE)) {
      const m = crossing(p, q2, side, next);
      inside.push(m);
      outside.push(m);
    }
  }
  return [inside, outside];
}

/**
 * The terrain, with strips of it lifted or sunk: the approaches to the bridges and tunnels. A
 * strip is a hard-edged step (a retaining wall stands on it), so ground laid over one edge is cut
 * along it, and each piece follows its own side. Pieces are cut and given their rise in `clip`;
 * only what they need of the bare landform is asked for by `plain`.
 */
class Carved extends Terrain {
  /** Each bucket's quads, strongest first. */
  readonly #buckets = new Map<number, Quad[]>();
  #cuts = 0;

  constructor(grid: TerrainGrid, strips: readonly Strip[]) {
    super(grid);
    const quads = strips.flatMap(stripQuads).toSorted((a, b) => b.strength - a.strength);
    for (const q of quads) {
      for (let i = bucketOf(q.minX); i <= bucketOf(q.maxX); i++) {
        for (let j = bucketOf(q.minZ); j <= bucketOf(q.maxZ); j++) {
          const key = bucketKey(i, j);
          const bucket = this.#buckets.get(key);
          if (bucket) bucket.push(q);
          else this.#buckets.set(key, [q]);
        }
      }
    }
  }

  /** The quads that overlap a box, strongest first. Most of the ground has none: it costs nothing. */
  #near(minX: number, minZ: number, maxX: number, maxZ: number): readonly Quad[] {
    const query = ++this.#cuts;
    const found: Quad[] = [];
    let buckets = 0;
    for (let i = bucketOf(minX); i <= bucketOf(maxX); i++) {
      for (let j = bucketOf(minZ); j <= bucketOf(maxZ); j++) {
        const bucket = this.#buckets.get(bucketKey(i, j));
        if (!bucket) continue;
        buckets++;
        for (const q of bucket) {
          if (q.seen === query) continue;
          q.seen = query;
          if (q.minX <= maxX && q.maxX >= minX && q.minZ <= maxZ && q.maxZ >= minZ) found.push(q);
        }
      }
    }
    return buckets > 1 ? found.toSorted((a, b) => b.strength - a.strength) : found;
  }

  /** The strongest quad over (x, z), if any: one bucket, nothing allocated. */
  #quadAt(x: number, z: number): Quad | undefined {
    return this.#buckets
      .get(bucketKey(bucketOf(x), bucketOf(z)))
      ?.find(
        (q) =>
          leftOf(q, 0, x, z) >= -ON_EDGE &&
          leftOf(q, 1, x, z) >= -ON_EDGE &&
          leftOf(q, 2, x, z) >= -ON_EDGE &&
          leftOf(q, 3, x, z) >= -ON_EDGE,
      );
  }

  /** How far the strips move the ground at (x, z): the strongest over it, 0 off them. */
  rise(x: number, z: number): number {
    const q = this.#quadAt(x, z);
    return q ? riseIn(q, x, z) : 0;
  }

  override height(x: number, z: number): number {
    return this.plain(x, z) + this.rise(x, z);
  }

  override clip(polygon: Polygon): Polygon[] {
    return super.clip(polygon).flatMap((piece) => this.#carve(piece));
  }

  #carve(piece: Polygon): Polygon[] {
    let [minX, minZ, maxX, maxZ] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const p of piece) {
      [minX, maxX] = [Math.min(minX, p[0]!), Math.max(maxX, p[0]!)];
      [minZ, maxZ] = [Math.min(minZ, p[2]!), Math.max(maxZ, p[2]!)];
    }
    const out: Polygon[] = [];
    let rest = [piece];
    for (const q of this.#near(minX, minZ, maxX, maxZ)) {
      const next: Polygon[] = [];
      for (let part of rest) {
        // A box that overlaps isn't ground that does: most pieces stop here, uncut.
        if (whollyOutside(part, q)) {
          next.push(part);
          continue;
        }
        for (let a = 0; a < 4 && part.length >= 3; a++) {
          const [inside, outside] = splitAt(part, q, a);
          if (outside.length >= 3) next.push(outside);
          part = inside;
        }
        if (part.length >= 3) {
          out.push(part.map((p) => p.map((v, k) => (k === 1 ? v + riseIn(q, p[0]!, p[2]!) : v))));
        }
      }
      rest = next;
      if (!rest.length) break;
    }
    return [...out, ...rest];
  }

  override cut(a: Corner, b: Corner): Corner[] {
    const points = super.cut(a, b);
    const quads = this.#near(
      Math.min(a[0]!, b[0]!),
      Math.min(a[2]!, b[2]!),
      Math.max(a[0]!, b[0]!),
      Math.max(a[2]!, b[2]!),
    );
    if (!quads.length) return points;
    const stops: Corner[] = [];
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!;
      const q = points[i + 1];
      stops.push(p);
      if (!q) continue;
      const at: number[] = [];
      for (const quad of quads) {
        for (let e = 0; e < 4; e++) {
          const [sp, sq] = [leftOf(quad, e, p[0]!, p[2]!), leftOf(quad, e, q[0]!, q[2]!)];
          if (sp * sq < 0) at.push(sp / (sp - sq));
        }
      }
      for (const s of at.toSorted((u, v) => u - v))
        stops.push(p.map((v, k) => v + (q[k]! - v) * s));
    }
    // A point on a step counts as the piece of the line after it.
    return stops.map((m, i) => {
      const next = stops[i + 1] ?? m;
      const lifted = m.slice();
      const on = this.#quadAt((m[0]! + next[0]!) / 2, (m[2]! + next[2]!) / 2);
      lifted[1] = m[1]! + (on ? riseIn(on, m[0]!, m[2]!) : 0);
      return lifted;
    });
  }
}

/**
 * The ground the city stands on: the landform with `ramps` carved into it, its tracks on the
 * ramps that carry them (`rails`), and its decks' surface (`decks`).
 */
export function landform(
  grid: TerrainGrid,
  ramps: readonly (Strip & { rail?: boolean })[],
  decks: readonly Strip[],
): Terrain {
  const ground = new Carved(grid, ramps);
  ground.rails = new Carved(
    grid,
    ramps.filter((r) => r.rail),
  );
  ground.decks = new Carved(grid, decks);
  return ground;
}

/** Level ground everywhere: nothing cut, nothing lifted. For tests and tools. */
export const FLAT_GRID: TerrainGrid = {
  step: 1,
  minX: 0,
  minZ: 0,
  cols: 2,
  rows: 2,
  heights: new Float32Array(4),
};
export const FLAT = new Terrain(FLAT_GRID);
