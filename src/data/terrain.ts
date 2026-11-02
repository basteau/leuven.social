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

  constructor({ step, minX, minZ, cols, rows, heights }: TerrainGrid) {
    if (cols < 2 || rows < 2 || heights.length !== cols * rows || !(step > 0)) {
      throw new RangeError(`A terrain needs a grid of 2 × 2 nodes or more, not ${cols} × ${rows}.`);
    }
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

  /** The ground at (x, z). Off the grid, the height at its nearest edge. */
  height(x: number, z: number): number {
    const [i, j, u, v] = this.#locate(x, z);
    const [a, b, c, d] = this.#square(i, j);
    return u >= v ? a + (b - a) * u + (d - b) * v : a + (d - c) * u + (c - a) * v;
  }

  /**
   * The plane of the triangle under (x, z), as y = out[0] + out[1] · x + out[2] · z: the ground
   * there exactly, and near it within a few centimetres.
   */
  plane(x: number, z: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
    const [i, j, u, v] = this.#locate(x, z);
    const [a, b, c, d] = this.#square(i, j);
    const [sx, sz] = u >= v ? [b - a, d - b] : [d - c, c - a];
    out[1] = sx / this.step;
    out[2] = sz / this.step;
    out[0] = a - out[1] * (this.minX + i * this.step) - out[2] * (this.minZ + j * this.step);
    return out;
  }

  /** Heights at the square's corners (i, j), (i + 1, j), (i, j + 1), (i + 1, j + 1). */
  #square(i: number, j: number): [number, number, number, number] {
    const h = this.heights;
    const k = j * this.cols + i;
    return [h[k]!, h[k + 1]!, h[k + this.cols]!, h[k + this.cols + 1]!];
  }

  /** The lowest ground under a ring's corners (flat [x0, z0, x1, z1, …]): where a rigid thing stands. */
  base(ring: ArrayLike<number>): number {
    let lowest = Infinity;
    for (let i = 0; i + 1 < ring.length; i += 2) {
      lowest = Math.min(lowest, this.height(ring[i]!, ring[i + 1]!));
    }
    return lowest;
  }

  /** The lowest and highest ground anywhere within `bounds`. */
  range({ minX, minZ, maxX, maxZ }: Bounds): [number, number] {
    const [i0, j0] = this.#locate(minX, minZ);
    const [i1, j1] = this.#locate(maxX, maxZ);
    let [lowest, highest] = [Infinity, -Infinity];
    for (let j = j0; j <= j1 + 1; j++) {
      for (let i = i0; i <= i1 + 1; i++) {
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
