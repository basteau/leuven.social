/**
 * Where the diamond that marks the avatar goes on screen. Over its head when the view is too far
 * out for its figure to read, pointing down at it; at the edge of the screen, pointing toward it,
 * when it's off screen or under the controls round it, where it doubles as the way back. Pure, so
 * the shell only places it.
 */

/**
 * How far in from each edge the edge diamond's disc (22 px radius, its shadow under it) keeps its
 * middle (px): clear of the view's controls down the end edge and of the menu button along the
 * bottom. Along the top it stays this far under whatever the top edge holds just then (the street
 * plate, the credit, the hint): the shell adds the height of that row.
 */
export const EDGE_INSET = { top: 28, right: 96, bottom: 96, left: 32 } as const;
export type Inset = { top: number; right: number; bottom: number; left: number };

export interface Pointer {
  /** Where its tip goes (px from the map's top left). */
  x: number;
  y: number;
  /** Which way it points, clockwise from straight down (radians). */
  angle: number;
  /** Off screen, or under the controls: pinned to the edge, pointing the way. */
  edge: boolean;
}

/**
 * The diamond for an avatar at (x, y) on a map `width` by `height` (px), whose figure is drawn
 * (`figure`) or not; null when the figure is on screen and needs no diamond. Within the insets
 * counts as off screen: a diamond over its head would sit under the menu button or off the edge.
 */
export function pointerFor(
  x: number,
  y: number,
  width: number,
  height: number,
  figure: boolean,
  inset: Inset = EDGE_INSET,
): Pointer | null {
  const [left, right] = [inset.left, width - inset.right];
  const [top, bottom] = [inset.top, height - inset.bottom];
  const inside = x >= left && y >= top && x <= right && y <= bottom;
  if (inside) return figure ? null : { x, y, angle: 0, edge: false };
  if (!(Number.isFinite(x) && Number.isFinite(y))) return null;
  // From the middle of the inset rectangle toward the avatar, out to its edge.
  const [cx, cy] = [(left + right) / 2, (top + bottom) / 2];
  const [dx, dy] = [x - cx, y - cy];
  const reach = Math.min(
    dx === 0 ? Infinity : ((dx > 0 ? right : left) - cx) / dx,
    dy === 0 ? Infinity : ((dy > 0 ? bottom : top) - cy) / dy,
  );
  return { x: cx + dx * reach, y: cy + dy * reach, angle: Math.atan2(-dx, dy), edge: true };
}

/** The pin over the end of a route is gone with the avatar this near it, whole this far (px). */
const PIN_ARRIVED = 18;
const PIN_APART = 52;
/** How far past the map's edge the pin's spot may be and its head still show (px). */
const PIN_MARGIN = 32;

/**
 * How much of the pin to draw for a route ending at (x, y) on a map `width` by `height` (px), for
 * `far`, how much the zoom asks for one: none off the map, and fading as the avatar at (ax, ay)
 * gets there, or it would stand on top of the diamond that marks you.
 */
export function pinOpacity(
  far: number,
  x: number,
  y: number,
  ax: number,
  ay: number,
  width: number,
  height: number,
): number {
  if (x < -PIN_MARGIN || y < 0 || x > width + PIN_MARGIN || y > height + PIN_MARGIN * 2) return 0;
  const apart = (Math.hypot(x - ax, y - ay) - PIN_ARRIVED) / (PIN_APART - PIN_ARRIVED);
  return far * Math.min(1, Math.max(0, apart));
}
