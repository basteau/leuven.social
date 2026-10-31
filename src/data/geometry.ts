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
