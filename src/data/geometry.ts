/** Pure 2D polygon helpers on flat [x0, z0, x1, z1, …] rings. */

import type { Bounds } from './city.ts';

/** Shoelace area in (x, z); positive means counter-clockwise in this project's convention. */
export function signedArea(ring: ArrayLike<number>): number {
  let sum = 0;
  const n = ring.length;
  for (let i = 0; i < n; i += 2) {
    const j = (i + 2) % n;
    sum += ring[i]! * ring[j + 1]! - ring[j]! * ring[i + 1]!;
  }
  return sum / 2;
}

/** Returns the ring counter-clockwise, dropping a closing duplicate point. */
export function normalizeRing(ring: readonly number[]): number[] {
  let pts = ring.slice();
  const n = pts.length;
  if (n >= 4 && pts[0] === pts[n - 2] && pts[1] === pts[n - 1]) pts = pts.slice(0, n - 2);
  if (signedArea(pts) < 0) {
    const reversed: number[] = [];
    for (let i = pts.length - 2; i >= 0; i -= 2) reversed.push(pts[i]!, pts[i + 1]!);
    pts = reversed;
  }
  return pts;
}

/** Even-odd test: whether (x, z) lies inside the ring. */
export function pointInRing(ring: ArrayLike<number>, x: number, z: number): boolean {
  let inside = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, zi, xj, zj] = [ring[i * 2]!, ring[i * 2 + 1]!, ring[j * 2]!, ring[j * 2 + 1]!];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** The smallest rectangle around all of them. */
export function boundsOf(rects: readonly Bounds[]): Bounds {
  return {
    minX: Math.min(...rects.map((r) => r.minX)),
    minZ: Math.min(...rects.map((r) => r.minZ)),
    maxX: Math.max(...rects.map((r) => r.maxX)),
    maxZ: Math.max(...rects.map((r) => r.maxZ)),
  };
}

const inBounds = (x: number, z: number, b: Bounds) =>
  x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ;

/** Index of the area rectangle that holds (x, z), or -1. */
export function areaIndex(area: readonly Bounds[], x: number, z: number): number {
  return area.findIndex((b) => inBounds(x, z, b));
}

/** Whether every vertex lies in one of the area's rectangles. */
export function ringInArea(ring: ArrayLike<number>, area: readonly Bounds[]): boolean {
  for (let i = 0; i < ring.length; i += 2) {
    if (areaIndex(area, ring[i]!, ring[i + 1]!) < 0) return false;
  }
  return true;
}

/** Clips a ring to an area of abutting rectangles: one piece per rectangle it reaches. */
export function clipRingToArea(ring: readonly number[], area: readonly Bounds[]): number[][] {
  return area.map((b) => clipRing(ring, b)).filter((piece) => piece.length >= 6);
}

/** The point of the area closest to (x, z): where the camera may look. */
export function clampToArea(area: readonly Bounds[], x: number, z: number): [number, number] {
  let best: [number, number] = [x, z];
  let bestDistance = Infinity;
  for (const b of area) {
    const cx = Math.min(Math.max(x, b.minX), b.maxX);
    const cz = Math.min(Math.max(z, b.minZ), b.maxZ);
    const d = Math.hypot(cx - x, cz - z);
    if (d < bestDistance) [best, bestDistance] = [[cx, cz], d];
  }
  return best;
}

export interface OutlineEdge {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** Outward normal: one of (±1, 0) or (0, ±1). */
  nx: number;
  nz: number;
}

/**
 * The outer boundary of an area of abutting, non-overlapping rectangles: each rectangle side
 * minus the stretches where a neighbour continues the area. The diorama's earth sides hang here.
 */
export function areaOutline(area: readonly Bounds[]): OutlineEdge[] {
  const edges: OutlineEdge[] = [];
  for (const b of area) {
    const sides = [
      { fixed: b.maxZ, from: b.minX, to: b.maxX, nx: 0, nz: 1 },
      { fixed: b.minZ, from: b.minX, to: b.maxX, nx: 0, nz: -1 },
      { fixed: b.maxX, from: b.minZ, to: b.maxZ, nx: 1, nz: 0 },
      { fixed: b.minX, from: b.minZ, to: b.maxZ, nx: -1, nz: 0 },
    ];
    for (const { fixed, from, to, nx, nz } of sides) {
      // Stretches of this side that a neighbour across it covers.
      const covered = area
        .filter((o) =>
          nz === 1
            ? o.minZ === fixed
            : nz === -1
              ? o.maxZ === fixed
              : nx === 1
                ? o.minX === fixed
                : o.maxX === fixed,
        )
        .map((o) => (nz !== 0 ? [o.minX, o.maxX] : [o.minZ, o.maxZ]) as [number, number])
        .toSorted((p, q) => p[0] - q[0]);
      let at = from;
      const open: [number, number][] = [];
      for (const [lo, hi] of covered) {
        if (hi <= at || lo >= to) continue;
        if (lo > at) open.push([at, lo]);
        at = Math.max(at, hi);
      }
      if (at < to) open.push([at, to]);
      for (const [lo, hi] of open) {
        edges.push(
          nz !== 0
            ? { x0: lo, z0: fixed, x1: hi, z1: fixed, nx, nz }
            : { x0: fixed, z0: lo, x1: fixed, z1: hi, nx, nz },
        );
      }
    }
  }
  return edges;
}

/**
 * Drops vertices that sit within `tolerance` of the straight line through their neighbours.
 * Survey footprints are full of them, and each costs two wall triangles and a roof triangle.
 */
export function simplifyRing(ring: ArrayLike<number>, tolerance: number): number[] {
  let pts = Array.from(ring);
  for (let changed = true; changed && pts.length > 6;) {
    changed = false;
    const n = pts.length / 2;
    const kept: number[] = [];
    for (let i = 0; i < n; i++) {
      const [px, pz] = kept.length
        ? [kept.at(-2)!, kept.at(-1)!]
        : [pts[((i + n - 1) % n) * 2]!, pts[((i + n - 1) % n) * 2 + 1]!];
      const [x, z] = [pts[i * 2]!, pts[i * 2 + 1]!];
      const [qx, qz] = [pts[((i + 1) % n) * 2]!, pts[((i + 1) % n) * 2 + 1]!];
      const length = Math.hypot(qx - px, qz - pz);
      const offset =
        length > 0 ? Math.abs((qx - px) * (z - pz) - (qz - pz) * (x - px)) / length : 0;
      if (offset < tolerance && kept.length / 2 + (n - i - 1) >= 3) {
        changed = true;
        continue;
      }
      kept.push(x, z);
    }
    pts = kept;
  }
  return pts;
}

export function ringInside(ring: ArrayLike<number>, b: Bounds): boolean {
  for (let i = 0; i < ring.length; i += 2) {
    const x = ring[i]!;
    const z = ring[i + 1]!;
    if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) return false;
  }
  return true;
}

type Edge = (x: number, z: number) => number;

/** Sutherland–Hodgman clip of a polygon against an axis-aligned rectangle. */
export function clipRing(ring: readonly number[], b: Bounds): number[] {
  // Each edge returns a signed distance; >= 0 is inside.
  const edges: Edge[] = [
    (x) => x - b.minX,
    (x) => b.maxX - x,
    (_, z) => z - b.minZ,
    (_, z) => b.maxZ - z,
  ];
  let out = ring.slice();
  for (const edge of edges) {
    const input = out;
    out = [];
    const n = input.length;
    for (let i = 0; i < n; i += 2) {
      const ax = input[i]!;
      const az = input[i + 1]!;
      const bx = input[(i + 2) % n]!;
      const bz = input[(i + 3) % n]!;
      const da = edge(ax, az);
      const db = edge(bx, bz);
      if (da >= 0) out.push(ax, az);
      if (da >= 0 !== db >= 0) {
        const t = da / (da - db);
        out.push(ax + t * (bx - ax), az + t * (bz - az));
      }
    }
    if (out.length < 6) return [];
  }
  return out;
}

export interface OrientedRect {
  cx: number;
  cz: number;
  /** Unit vector along the long side. */
  ux: number;
  uz: number;
  halfLength: number;
  halfWidth: number;
  /** Footprint area divided by rectangle area: 1 for a perfect rectangle. */
  fill: number;
}

type Point = [number, number];

const cross = (o: Point, a: Point, c: Point) =>
  (a[0] - o[0]) * (c[1] - o[1]) - (a[1] - o[1]) * (c[0] - o[0]);

function convexHull(ring: ArrayLike<number>): number[] {
  const pts: Point[] = [];
  for (let i = 0; i < ring.length; i += 2) pts.push([ring[i]!, ring[i + 1]!]);
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const lower: Point[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)].flat();
}

/** Minimum-area bounding rectangle (rotating calipers over the hull's edge directions). */
export function orientedRect(ring: ArrayLike<number>): OrientedRect {
  const hull = convexHull(ring);
  const n = hull.length;
  let best: OrientedRect | null = null;
  let bestArea = Infinity;
  for (let i = 0; i < n; i += 2) {
    let ex = hull[(i + 2) % n]! - hull[i]!;
    let ez = hull[(i + 3) % n]! - hull[i + 1]!;
    const len = Math.hypot(ex, ez);
    if (len < 1e-9) continue;
    ex /= len;
    ez /= len;
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (let j = 0; j < n; j += 2) {
      const u = hull[j]! * ex + hull[j + 1]! * ez;
      const v = -hull[j]! * ez + hull[j + 1]! * ex;
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
    const area = (maxU - minU) * (maxV - minV);
    if (area >= bestArea) continue;
    bestArea = area;
    const cu = (minU + maxU) / 2;
    const cv = (minV + maxV) / 2;
    const alongU = maxU - minU >= maxV - minV;
    best = {
      cx: cu * ex - cv * ez,
      cz: cu * ez + cv * ex,
      ux: alongU ? ex : -ez,
      uz: alongU ? ez : ex,
      halfLength: Math.max(maxU - minU, maxV - minV) / 2,
      halfWidth: Math.min(maxU - minU, maxV - minV) / 2,
      fill: 0,
    };
  }
  if (!best) return { cx: 0, cz: 0, ux: 1, uz: 0, halfLength: 0, halfWidth: 0, fill: 0 };
  best.fill = bestArea > 0 ? Math.abs(signedArea(ring)) / bestArea : 0;
  return best;
}

/**
 * Clips a polyline (flat [x0, z0, …]) to a rectangle. A line that leaves and re-enters comes
 * back as several pieces; pieces shorter than one segment are dropped.
 */
export function clipLine(line: ArrayLike<number>, b: Bounds): number[][] {
  const pieces: number[][] = [];
  let current: number[] = [];
  const flush = () => {
    if (current.length >= 4) pieces.push(current);
    current = [];
  };
  for (let i = 0; i + 3 < line.length; i += 2) {
    const [ax, az, bx, bz] = [line[i]!, line[i + 1]!, line[i + 2]!, line[i + 3]!];
    // Liang–Barsky: the part of a→b inside, as parameters t0..t1.
    let t0 = 0;
    let t1 = 1;
    const dx = bx - ax;
    const dz = bz - az;
    const sides: [number, number][] = [
      [-dx, ax - b.minX],
      [dx, b.maxX - ax],
      [-dz, az - b.minZ],
      [dz, b.maxZ - az],
    ];
    let outside = false;
    for (const [p, q] of sides) {
      if (p === 0) {
        if (q < 0) outside = true;
        continue;
      }
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
    }
    if (outside || t0 > t1) {
      flush();
      continue;
    }
    const [sx, sz] = [ax + dx * t0, az + dz * t0];
    if (t0 > 0 || current.length === 0) {
      flush();
      current.push(sx, sz);
    }
    current.push(ax + dx * t1, az + dz * t1);
    if (t1 < 1) flush();
  }
  flush();
  return pieces;
}

/**
 * The pieces of a polyline (flat [x0, z0, …]) that `covered` doesn't hide, found by sampling
 * every `step` metres: a cut lands within a step of where the line goes under. Pieces keep the
 * line's own vertices between their cut points; pieces shorter than `step` are dropped.
 */
export function uncoveredPieces(
  line: ArrayLike<number>,
  covered: (x: number, z: number) => boolean,
  step = 1,
): number[][] {
  const pieces: number[][] = [];
  let current: number[] = [];
  let run = 0;
  const flush = () => {
    if (current.length >= 4 && run >= step) pieces.push(current);
    [current, run] = [[], 0];
  };
  for (let i = 0; i + 3 < line.length; i += 2) {
    const [ax, az, bx, bz] = [line[i]!, line[i + 1]!, line[i + 2]!, line[i + 3]!];
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.ceil(len / step));
    for (let k = i === 0 ? 0 : 1; k <= n; k++) {
      const [x, z] = [ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n];
      if (covered(x, z)) {
        flush();
        continue;
      }
      // Keep the line's vertices, and any sample where a piece starts or ends.
      const ends =
        k === n ||
        current.length === 0 ||
        covered(ax + ((bx - ax) * (k + 1)) / n, az + ((bz - az) * (k + 1)) / n);
      if (current.length) run += len / n;
      if (ends) current.push(x, z);
    }
  }
  flush();
  return pieces;
}
