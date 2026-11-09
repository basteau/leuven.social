/**
 * Where the arrow that marks the avatar goes on screen. Over its head when the view is too far
 * out for its figure to read, pointing down at it; at the edge of the screen, pointing toward it,
 * when it's off screen or under the controls round it, where it doubles as the way back. Pure, so
 * the shell only places it.
 */

/**
 * How far in from each edge the edge arrow stays (px): clear of the street plate and the credits
 * along the top, the view's controls down the end edge and the pills along the bottom.
 */
export const EDGE_INSET = { top: 76, right: 88, bottom: 88, left: 32 } as const;
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
 * The arrow for an avatar at (x, y) on a map `width` by `height` (px), whose figure is drawn
 * (`figure`) or not; null when the figure is on screen and needs no arrow. Within the insets
 * counts as off screen: an arrow over its head would sit under the menu button or off the edge.
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
