import type { Bounds } from './city.ts';

/**
 * How far the view's middle is from the city, and the nearest spot of it, for the recentre
 * arrow. Zero inside any of the abutting rectangles.
 */
export function nearestInArea(
  x: number,
  z: number,
  area: readonly Bounds[],
): { x: number; z: number; distance: number } {
  let best = { x, z, distance: Infinity };
  for (const a of area) {
    const nx = Math.min(a.maxX, Math.max(a.minX, x));
    const nz = Math.min(a.maxZ, Math.max(a.minZ, z));
    const distance = Math.hypot(nx - x, nz - z);
    if (distance < best.distance) best = { x: nx, z: nz, distance };
  }
  return best;
}

/** The arrow shows once the middle of the view is this far outside the city (m). */
export const DRIFT_FROM = 40;

/**
 * Where the arrow sits, from a direction on screen (radians, 0 pointing right, y down) in a
 * view `w` × `h` px with `inset` px of margin: the point on the inset rectangle.
 */
export function edgePoint(
  angle: number,
  w: number,
  h: number,
  inset: number,
): { x: number; y: number } {
  const [hw, hh] = [w / 2 - inset, h / 2 - inset];
  const [dx, dy] = [Math.cos(angle), Math.sin(angle)];
  const kx = Math.abs(dx) > 1e-9 ? hw / Math.abs(dx) : Infinity;
  const ky = Math.abs(dy) > 1e-9 ? hh / Math.abs(dy) : Infinity;
  const k = Math.min(kx, ky);
  return { x: w / 2 + dx * k, y: h / 2 + dy * k };
}
