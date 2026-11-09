/**
 * How far the map may zoom out, derived from what a frame may cost rather than from a number.
 * A frame costs what is in view, and what is in view is ground area: the most the map draws
 * smoothly (500k to 650k triangles and 85 to 100 draw calls at 1440×900, panning, well within
 * `FRAME_TRIANGLES`) is about 1 km² of Leuven's centre: 2 km² took 670k and 145. A wide window sees
 * that much ground at a nearer zoom than a phone held upright, so each gets the farthest zoom that
 * keeps the view within it: 0.71 at 1280×800, about 0.38 on a 390×844 phone. The cells in view, and
 * so everything drawn and shadowed for the map, are bounded by it.
 */

/** The most ground a map view may show (m²), at the city's heaviest. */
export const MAX_VIEW_AREA = 1e6;
/** Never nearer than the first view (zoom 1), nor further than this. */
const FARTHEST = 0.2;

/** The lowest zoom for a view `aspect` (width over height) wide, `viewHeight` m tall at zoom 1. */
export function minZoomFor(aspect: number, viewHeight: number): number {
  const height = Math.sqrt(MAX_VIEW_AREA / Math.max(aspect, 0.1));
  return Math.min(1, Math.max(FARTHEST, viewHeight / height));
}
