/**
 * One camera, and one number for what's worth drawing: the height of the view in metres where it
 * looks (`span`, VIEW_HEIGHT / zoom). The map is an orthographic camera at the true isometric
 * pitch that only ever pans, turns and zooms, from the whole city down to a street,
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
 * How tall a figure is drawn at a zoom in a window `height` CSS px tall (px). People are the one
 * thing that doesn't go by the span: a phone shows the same span in fewer pixels, and whether
 * someone reads as a figure depends on the pixels. Everything about them is a function of this.
 */
export const figurePixels = (height: number, zoom: number) => (height * zoom) / 352;

const ramp = (p: number, from: number, to: number) =>
  Math.min(1, Math.max(0, (p - from) / (to - from)));

/**
 * Where each way of drawing someone gives way, in `figurePixels`. The full figure dithers into a
 * crowd's figure as they are much alike; a marker fades in over the crowd's little figure, with
 * real alpha in the 2D layer, and the figure goes only once a whole marker hides it, as dithering
 * something six pixels tall reads as noise.
 */
export const PEOPLE = {
  /** A full figure, whole at or over this, gone by `rigGone`. */
  rig: 14,
  rigGone: 10,
  /** A marker starts here, whole by `markerWhole`; the crowd's figure is whole down to that. */
  markerFrom: 9,
  markerWhole: 7.5,
  /** Under the whole marker, gone by this, and with it the cost of drawing it. */
  figureGone: 6,
} as const;

/** How much of a full figure is drawn, at `figurePixels`. */
export const rigAlpha = (p: number) => ramp(p, PEOPLE.rigGone, PEOPLE.rig);
/** How much of a crowd's figure, or of the avatar's own, is drawn, at `figurePixels`. */
export const figureAlpha = (p: number) => ramp(p, PEOPLE.figureGone, PEOPLE.markerWhole);
/** How much of a marker, the avatar's diamond among them, at `figurePixels`. */
export const markerAlpha = (p: number) => 1 - ramp(p, PEOPLE.markerWhole, PEOPLE.markerFrom);

/**
 * How much of someone the crowd's figure draws, as `motion.z` wants it: `rigPart` is how much a full
 * figure takes of them, `fits` whether the cap leaves them a crowd's figure (0 to 1), `figures` the
 * zoom's `figureAlpha`, `comeGo` coming, going and doors. While all of it is whole but the rig, it
 * is the rig's own complement, negative: the two together draw every pixel once. Otherwise a plain
 * fade of what the rig leaves, which nobody can tell apart in a fifth of a second.
 */
export function crowdFade(rigPart: number, fits: number, figures: number, comeGo: number): number {
  if (rigPart > 0 && fits === 1 && figures === 1 && comeGo === 1) return -rigPart;
  return figures * fits * comeGo * (1 - rigPart);
}

/**
 * How much of someone's marker to stamp: what's left after a full figure's share, taken by a
 * marker either for the zoom (`markers`, `markerAlpha`) or for those the cap left no figure.
 * With `crowdFade`, a swap's shares add up to one person: `rigPart`, the rest for figure or marker.
 */
export const markShare = (rigPart: number, fits: number, markers: number) =>
  Math.max(markers, 1 - fits) * (1 - rigPart);

/** The ground a view sees, as its window turns it: a rectangle, not a circle. */
export interface GroundRect {
  x: number;
  z: number;
  rightX: number;
  rightZ: number;
  /** Its half sizes along the screen (m): across, and up it. */
  halfWidth: number;
  halfDepth: number;
  /** Half its diagonal (m): how far from its middle it reaches. */
  reach: number;
}

/**
 * What a view at (x, z) sees of the ground, a `span` tall (m), `aspect` wide for each of it tall,
 * turned to `yaw`. A little more than the window, by `margin` metres each way: what rises off the
 * ground (a figure, a hill) shows from just past the edge. The true half-diagonal of it is `reach`.
 */
export function groundRect(
  x: number,
  z: number,
  span: number,
  aspect: number,
  yaw: number,
  margin = 0,
  out: GroundRect = {} as GroundRect,
): GroundRect {
  // Up the screen, a metre of ground is shortened to the sine of the pitch.
  const halfDepth = span / 2 / Math.sin(PITCH) + margin;
  const halfWidth = (span * aspect) / 2 + margin;
  out.x = x;
  out.z = z;
  out.rightX = Math.cos(yaw);
  out.rightZ = -Math.sin(yaw);
  out.halfWidth = halfWidth;
  out.halfDepth = halfDepth;
  out.reach = Math.hypot(halfWidth, halfDepth);
  return out;
}

/** Whether (x, z) lies in a `GroundRect`. */
export function inGround(r: GroundRect, x: number, z: number): boolean {
  const [dx, dz] = [x - r.x, z - r.z];
  // Up the screen is at a right angle to across it, on the ground.
  const across = dx * r.rightX + dz * r.rightZ;
  if (across < -r.halfWidth || across > r.halfWidth) return false;
  const up = dx * r.rightZ - dz * r.rightX;
  return up >= -r.halfDepth && up <= r.halfDepth;
}

/** The same person's chance at a full figure: won at this rank (the nearest first, from 1). */
export const RIG_WIN = 24;
/** Lost only past this rank, so that someone at the edge of the 24 doesn't flip each step. */
export const RIG_LOSE = 30;
/** Nobody gives a figure back sooner than this after getting it (ms). */
export const RIG_HOLD = 1000;

/**
 * Whether someone ranked `rank` (1 is nearest, 0 or beyond `RIG_LOSE` not among the nearest)
 * should hold on to a figure they've had for `heldMs` (or, with `holding` false, get one).
 * Together with the hold, the band between `RIG_WIN` and `RIG_LOSE` makes a tie at the edge a
 * small matter: nobody flips.
 */
export function wantsRig(rank: number, holding: boolean, heldMs: number): boolean {
  const near = rank >= 1 && rank <= (holding ? RIG_LOSE : RIG_WIN);
  return near || (holding && heldMs < RIG_HOLD);
}

/**
 * Where each kind of detail starts, as the span it shows at or under (m). In the order a zoom in
 * meets them:
 *
 * | span (m) | drawn                                                                     |
 * | -------- | ------------------------------------------------------------------------- |
 * | > 280    | the cells in view: the city only                                          |
 * | ≤ 280    | + street furniture, parked bikes, awnings (from 280)                      |
 * | ≤ 60     | + trunks and furniture cast, rooms prewarmed                              |
 * | < 20     | the street up close: nothing new, the same meshes nearer                  |
 *
 * The avatar and other people aren't in it: they go by the pixels of a figure, `figurePixels`.
 */
export const SPANS = {
  /** Street furniture, parked bikes, shop fronts' awnings and signs (from zoom 2). */
  furniture: 280,
  /** The street: shadows of trunks and furniture, and the rooms near the avatar built ahead. */
  street: 60,
} as const;

export interface Detail {
  furniture: boolean;
  /** The avatar's figure is what shows of it, for all that depends on that: it isn't yet the diamond alone. */
  figure: boolean;
  /** Trunks and furniture cast into the shadow map: from above their shadows are under a texel. */
  streetShadows: boolean;
  /** Rooms within reach of the avatar are built while the page is idle. */
  prewarm: boolean;
}

/** What is drawn at a span (m) in a window `height` CSS px tall, as the viewer reads it each frame. */
export function detailAt(span: number, height: number): Detail {
  const street = span <= SPANS.street;
  return {
    furniture: span <= SPANS.furniture,
    // Under a whole marker the avatar's figure no longer reads: the map's way of finding it takes over.
    figure: figurePixels(height, VIEW_HEIGHT / span) >= PEOPLE.markerWhole,
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
