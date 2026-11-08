/**
 * One camera, and one number for what's worth drawing: the height of the view in metres where it
 * looks (`span`, VIEW_HEIGHT / zoom). The map is an orthographic camera at the true isometric
 * pitch that only ever pans, turns in quarters and zooms, from the whole city down to a street,
 * so every level-of-detail rule is a threshold on the span, read here, and nothing depends on a
 * mode. Pure, so the table is tested rather than read off the viewer.
 */

/** Metres of city shown top to bottom at zoom 1. */
export const VIEW_HEIGHT = 560;
/** Zoom limits: the whole city, and a street about three houses wide (≈ 14 m tall). */
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 40;
/** True isometric pitch, ≈ 35.26°, and how far the camera stands back from where it looks (m). */
export const PITCH = Math.atan(1 / Math.SQRT2);
export const CAMERA_DISTANCE = 2000;
/** The layer the puffs of leaves are on: quads the tap's depth pass can't place, so it skips them. */
export const PUFF_LAYER = 3;

export const spanOf = (zoom: number) => VIEW_HEIGHT / zoom;

/**
 * Where each kind of detail starts, as the span it shows at or under (m). In the order a zoom in
 * meets them:
 *
 * | span (m) | drawn                                                                    |
 * | -------- | ------------------------------------------------------------------------ |
 * | > 400    | the cells in view: the city only                                         |
 * | 120–400  | + the avatar as a marker                                                 |
 * | 60–280   | + street furniture, parked bikes, awnings (from 280)                      |
 * | 60–120   | + the avatar's figure                                                     |
 * | 20–60    | + trunks and furniture cast, rooms prewarmed                              |
 * | < 20     | the street up close: nothing new, the same meshes nearer                  |
 */
export const SPANS = {
  /** Above it, the city alone: the avatar isn't drawn at all. */
  city: 400,
  /** Street furniture, parked bikes, shop fronts' awnings and signs (PROP_ZOOM 2). */
  furniture: 280,
  /** The avatar's rigged figure; between this and `city`, a marker. */
  figure: 120,
  /** The street: shadows of trunks and furniture, and the rooms near the avatar built ahead. */
  street: 60,
} as const;

export type AvatarDetail = 'none' | 'marker' | 'figure';

export interface Detail {
  furniture: boolean;
  avatar: AvatarDetail;
  /** Trunks and furniture cast into the shadow map: from above their shadows are under a texel. */
  streetShadows: boolean;
  /** Rooms within reach of the avatar are built while the page is idle. */
  prewarm: boolean;
}

/** What is drawn at a span (m): the table above, as the viewer reads it each frame. */
export function detailAt(span: number): Detail {
  const street = span <= SPANS.street;
  return {
    furniture: span <= SPANS.furniture,
    avatar: span <= SPANS.figure ? 'figure' : span <= SPANS.city ? 'marker' : 'none',
    streetShadows: street,
    prewarm: street,
  };
}

/** The haze starts to come in under this span (m), and is all there under HAZE_FULL. */
const HAZE_FROM = 120;
const HAZE_FULL = 30;
/** Fog off: far past anything a camera this far back can draw. */
export const NO_FOG: readonly [number, number] = [1e7, 1e7 + 1];

/**
 * The fog's near and far (depth from the camera, m) at a span. On the map there is none; close
 * in, the far end of the street (the top of the screen) fades a little into the horizon, as a
 * street seen from the pavement does, so the zoom draws the haze nearer rather than a mode.
 * Smooth in the span, and off entirely (`NO_FOG`) once nothing on screen would be touched.
 */
export function fogRange(span: number): readonly [number, number] {
  const t = Math.min(1, Math.max(0, (HAZE_FROM - span) / (HAZE_FROM - HAZE_FULL)));
  if (t === 0) return NO_FOG;
  const haze = t * t * (3 - 2 * t);
  const near = CAMERA_DISTANCE + span * (6 + (0.5 - 6) * haze);
  const far = CAMERA_DISTANCE + span * (9 + (2.2 - 9) * haze);
  return [near, far];
}
