/**
 * How far the map may zoom out, derived from what a frame may cost rather than from a number.
 * A frame costs what is in view, and what is in view is ground area: the most the map draws
 * smoothly (about 620k triangles at 1280×800, well within `FRAME_TRIANGLES`) is about 2 km² of
 * Leuven's centre. A wide
 * window sees that much ground at a nearer zoom than a phone held upright, so each gets the
 * farthest zoom that keeps the view within it: 0.5 at 1280×800 (where the limit used to be a
 * flat 0.5), about 0.27 on a 390×844 phone. The cells in view, and so everything built, drawn and
 * shadowed for the map, are bounded by it.
 */

/** The most ground a map view may show (m²), at the city's heaviest. */
export const MAX_VIEW_AREA = 2.0e6;
/** Never nearer than the first view (zoom 1), nor further than this. */
const FARTHEST = 0.2;

/** The lowest zoom for a view `aspect` (width over height) wide, `viewHeight` m tall at zoom 1. */
export function minZoomFor(aspect: number, viewHeight: number): number {
  const height = Math.sqrt(MAX_VIEW_AREA / Math.max(aspect, 0.1));
  return Math.min(1, Math.max(FARTHEST, viewHeight / height));
}
