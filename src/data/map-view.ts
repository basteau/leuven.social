/**
 * The full map's maths: where a spot in the city lands on its canvas (north up, panned and
 * zoomed). Local metres: x east, z south; headings clockwise from north.
 */

/** Pixels of the pre-rendered raster per metre. */
export const RASTER_SCALE = 0.6;

export interface Frame {
  /** The city spot at the middle of the canvas. */
  cx: number;
  cz: number;
  /** Canvas pixels per metre. */
  scale: number;
}

/** A spot's offset from the middle of the canvas (px, y down). */
export function toScreen(f: Frame, x: number, z: number): [number, number] {
  return [(x - f.cx) * f.scale, (z - f.cz) * f.scale];
}

/** The city spot under an offset from the middle of the canvas. */
export function toCity(f: Frame, px: number, py: number): [number, number] {
  return [f.cx + px / f.scale, f.cz + py / f.scale];
}

/** Zoom limits of the full map, in pixels per metre. */
export const MAP_MIN_SCALE = 0.12;
export const MAP_MAX_SCALE = 2.4;
export const clampScale = (s: number): number =>
  Math.min(MAP_MAX_SCALE, Math.max(MAP_MIN_SCALE, s));

/**
 * A ring thinned to the corners that matter: Douglas–Peucker on a flat [x, z, …] ring, keeping
 * at least three points. Footprints drawn at map scale need not carry every vertex.
 */
export function simplifyRing(ring: ArrayLike<number>, tolerance: number): number[] {
  const n = ring.length / 2;
  if (n <= 3) return Array.from(ring);
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  const t2 = tolerance * tolerance;
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let [far, at] = [0, -1];
    const [ax, az, bx, bz] = [ring[a * 2]!, ring[a * 2 + 1]!, ring[b * 2]!, ring[b * 2 + 1]!];
    const [ex, ez] = [bx - ax, bz - az];
    const len2 = ex * ex + ez * ez;
    for (let i = a + 1; i < b; i++) {
      const [px, pz] = [ring[i * 2]! - ax, ring[i * 2 + 1]! - az];
      const t = len2 ? Math.min(1, Math.max(0, (px * ex + pz * ez) / len2)) : 0;
      const d = (px - ex * t) ** 2 + (pz - ez * t) ** 2;
      if (d > far) [far, at] = [d, i];
    }
    if (at >= 0 && far > t2) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(ring[i * 2]!, ring[i * 2 + 1]!);
  // Thinned to a sliver: keep the first three corners instead.
  return out.length >= 6 ? out : Array.from(ring).slice(0, 6);
}
