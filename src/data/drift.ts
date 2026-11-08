/**
 * The recentre arrow's direction: where the city's heart (Grote Markt) lies, as a screen
 * direction (radians, 0 pointing right, y down), or null while it is in view. `ndcX` and `ndcY`
 * are its place on screen from -1 to 1 (y up), `w` and `h` the view's size in px, `margin` how much
 * of the edge counts as out of view (0.1: the outer tenth).
 */
export function homeDirection(
  ndcX: number,
  ndcY: number,
  w: number,
  h: number,
  margin = 0.1,
): number | null {
  const limit = 1 - margin;
  if (Math.abs(ndcX) <= limit && Math.abs(ndcY) <= limit) return null;
  return Math.atan2(0 - ndcY * h, ndcX * w); // `0 -` keeps +0 (not -0), so due west is π, never -π;
}

/** The arrow turns in steps of this many radians: no state change for a smaller pan. */
export const DRIFT_STEP = 0.05;

/** Whether the arrow has to be told: it appeared or went, or turned by a step or more. */
export function driftChanged(prev: number | null, next: number | null): boolean {
  if (next === null || prev === null) return next !== prev;
  return Math.abs(next - prev) >= DRIFT_STEP;
}

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
