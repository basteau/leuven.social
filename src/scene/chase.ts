import { decay, decayAngle } from './motion.ts';

/**
 * The walking camera: a perspective camera on a boom behind the walker, turned by dragging,
 * and flown in from the map's isometric view and back. Pure maths, so the glue in walk.ts only
 * feeds it input and time. Input moves where the boom aims; the boom eases there by half-lives
 * (motion.ts), so it moves the same at any frame rate and pointer events that arrive unevenly
 * don't judder. The boom keeps the length the person chose: a house or a tree in the way may
 * hide the walker for a moment (its x-ray silhouette shows through), and what comes right up
 * against the lens dithers away in the city's shader (facade-material.ts), rather than the
 * camera zooming in and out on its own.
 */

export type Vec3 = [number, number, number];

/** Field of view while walking, and at the ends of the flight to and from the map (degrees). */
export const CHASE_FOV = 50;
export const MAP_FOV = 6;
/** Tall screens see at least this much side to side (degrees), so phones keep the street. */
const MIN_SIDE_FOV = 44;
/** Where the camera looks: a little above the walker's head (m). */
export const LOOK_HEIGHT = 2.6;
/** Boom pitch (radians, down is positive) and length (m): default and limits. */
export const PITCH = 0.32;
export const PITCH_RANGE = [-0.22, 1.3] as const;
export const DISTANCE = 7.5;
export const DISTANCE_RANGE = [2.5, 40] as const;
/**
 * Where the zoom buttons and keys stop (m): over the shoulder, close, the default, then higher
 * follow views, each about 1.7× the last, so one press is a step anyone can see.
 */
export const ZOOM_STOPS = [2.5, 4.4, 7.5, 13, 23, 40] as const;
/**
 * Zoomed out to the far limit the boom looks this much further down (radians), as map and
 * globe apps tilt toward the ground from higher up; zoomed in, a little nearer level.
 */
const ZOOM_TILT = 0.45;
/** The camera stays at least this high over the street (m), whatever the pitch and length. */
const EYE_FLOOR = 1;
/** A run widens the lens by this much (degrees) and lengthens the boom by this share. */
const RUN_FOV = 5;
const RUN_PULL = 0.12;
/** Half-lives (s): the boom turning to where it's aimed, and changing length. */
const AIM_EASE = 0.035;
const LENGTH_EASE = 0.09;
/** How close the flight's camera may come to a roof or the ground (m). */
const CLEARANCE = 0.5;
/** Steps the flight's line of sight is checked in (m). */
const STEP = 0.5;
/** Above this (m) nothing in the city stands: the tallest roof is 74 m, heights stop at 90. */
const ROOF_LIMIT = 100;

export interface Boom {
  /** Direction from the walker to the camera, in radians: 0 is toward +z, π/2 toward +x. */
  yaw: number;
  pitch: number;
  /** Where input and recentring point the boom; yaw and pitch ease there. */
  aimYaw: number;
  aimPitch: number;
  /** Length the person chose, and the length it is easing to that. */
  distance: number;
  length: number;
}

export const createBoom = (yaw: number): Boom => ({
  yaw,
  pitch: PITCH,
  aimYaw: yaw,
  aimPitch: PITCH,
  distance: DISTANCE,
  length: DISTANCE,
});

const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v));
export const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Aims the boom further round by the given angles, its pitch between looking up and down. */
export function turnBoom(boom: Boom, yaw: number, pitch: number): void {
  boom.aimYaw = wrap(boom.aimYaw + yaw);
  boom.aimPitch = clamp(boom.aimPitch + pitch, PITCH_RANGE);
}

/**
 * Eases the boom toward its aim and its length toward the one chosen, a little longer at a
 * run (`run`, 0 to 1). Returns whether it is still on its way.
 */
export function easeBoom(boom: Boom, run: number, dt: number): boolean {
  boom.yaw = decayAngle(boom.yaw, boom.aimYaw, AIM_EASE, dt);
  boom.pitch = decay(boom.pitch, boom.aimPitch, AIM_EASE, dt);
  const length = boom.distance * (1 + RUN_PULL * run);
  boom.length = decay(boom.length, length, LENGTH_EASE, dt);
  return (
    Math.abs(wrap(boom.aimYaw - boom.yaw)) > 1e-4 ||
    Math.abs(boom.aimPitch - boom.pitch) > 1e-4 ||
    Math.abs(boom.length - length) > 1e-3
  );
}

/** Lengthens the boom by `factor`, within its limits. */
export function stretchBoom(boom: Boom, factor: number): void {
  boom.distance = clamp(boom.distance * factor, DISTANCE_RANGE);
}

/** The next zoom stop from `distance`, closer or further; past the last, the last. */
export function zoomStop(distance: number, closer: boolean): number {
  const stops = closer ? ZOOM_STOPS.toReversed() : ZOOM_STOPS;
  const past = (stop: number) => (closer ? stop < distance * 0.95 : stop > distance * 1.05);
  return stops.find(past) ?? stops.at(-1)!;
}

/**
 * The pitch the boom is drawn at, from the one it's aimed at and its length: tilted down as it
 * lengthens (ZOOM_TILT), squeezed toward the top so that looking straight down stays the limit
 * and a drag never meets a dead end, and never so low that the camera sinks under EYE_FLOOR over
 * the street: `rise` is how much higher the ground under the camera is than under the walker.
 */
export function boomPitch(pitch: number, length: number, rise = 0): number {
  const top = PITCH_RANGE[1];
  const out = Math.log(length / DISTANCE) / Math.log(DISTANCE_RANGE[1] / DISTANCE);
  const tilt = ZOOM_TILT * clamp(out, [-1, 1]) * (out < 0 ? 0.5 : 1);
  const tilted = pitch + tilt * clamp((top - pitch) / (top - PITCH), [0, 1]);
  const floor = (EYE_FLOOR + rise - LOOK_HEIGHT) / length;
  return Math.max(tilted, Math.asin(Math.min(1, Math.max(-1, floor))));
}

/**
 * The vertical field of view for a screen's aspect: wider on tall screens, and a little wider
 * at a run (`run`, 0 to 1) for the sense of speed (degrees).
 */
export function chaseFov(aspect: number, run = 0): number {
  const side = Math.tan((MIN_SIDE_FOV * Math.PI) / 360) / aspect;
  return Math.max(CHASE_FOV, (Math.atan(side) * 360) / Math.PI) + RUN_FOV * run;
}

/** Unit direction from the look point out along the boom, written into `out`. */
export function boomDirection(yaw: number, pitch: number, out: Vec3): Vec3 {
  out[0] = Math.sin(yaw) * Math.cos(pitch);
  out[1] = Math.sin(pitch);
  out[2] = Math.cos(yaw) * Math.cos(pitch);
  return out;
}

/**
 * How far a camera can back away from `from` along `dir` (up to `max`) before it would sit
 * inside a building or under the ground, less a margin: for the flight, which climbs over the
 * roofs rather than cutting through them. It walks the line in steps, then halves the step it
 * hit a few times, so the length changes smoothly rather than a step at a time. Never less
 * than one step.
 */
export function freeLength(
  heightAt: (x: number, z: number) => number,
  from: Vec3,
  dir: Vec3,
  max: number,
): number {
  const blocked = (t: number) =>
    from[1] + dir[1] * t < heightAt(from[0] + dir[0] * t, from[2] + dir[2] * t) + CLEARANCE;
  for (let t = STEP; t <= max; t += STEP) {
    // Rising above every roof, it's clear the rest of the way.
    if (dir[1] >= 0 && from[1] + dir[1] * t > ROOF_LIMIT) return max;
    if (!blocked(t)) continue;
    let [clear, hit] = [t - STEP, t];
    for (let i = 0; i < 4; i++) {
      const mid = (clear + hit) / 2;
      if (blocked(mid)) hit = mid;
      else clear = mid;
    }
    return Math.max(STEP, clear - STEP / 2);
  }
  return max;
}

/** The walker's height and half its width, drawn 1.3× life size (m). */
const FIGURE_TOP = 2.4;
const FIGURE_RADIUS = 0.4;
/** The figure fades out as the camera comes from this far to this near it (m). */
const FADE_FROM = 1;
const FADE_TO = 0.3;

/**
 * How much of the figure to draw (0 to 1) with the camera at (dx, dy, dz) from its feet: all of
 * it until the camera is about a metre away, then less and less, so the closest zoom at a run
 * (the look point leads the walker toward the camera) never shows the inside of a head. It
 * follows the camera's own smooth motion.
 */
export function figureOpacity(dx: number, dy: number, dz: number): number {
  const up = dy < 0 ? dy : Math.max(0, dy - FIGURE_TOP);
  const gap = Math.hypot(dx, up, dz) - FIGURE_RADIUS;
  const t = Math.min(1, Math.max(0, (gap - FADE_TO) / (FADE_FROM - FADE_TO)));
  return t * t * (3 - 2 * t);
}

/**
 * Turns where the boom aims round behind a walker facing `heading`, by a share of the way each
 * second (`rate`): the camera following the walker's back. Its pitch eases back to the default
 * too. Returns how far it turned the aim (radians), so steering can leave that turn out.
 */
export function recentre(boom: Boom, heading: number, rate: number, dt: number): number {
  const keep = Math.exp(-rate * dt);
  const before = boom.aimYaw;
  boom.aimYaw = wrap(heading + Math.PI - wrap(heading + Math.PI - boom.aimYaw) * keep);
  boom.aimPitch = PITCH + (boom.aimPitch - PITCH) * keep;
  return wrap(boom.aimYaw - before);
}

/**
 * The camera follows fully a walker turned up to this far from its back (radians); turned all the
 * way round, toward the camera, it follows at this share, so an about-turn swings it round
 * behind more slowly than a turn to the side.
 */
const FOLLOW_FULL = (100 * Math.PI) / 180;
const ABOUT_TURN = 0.6;

/**
 * How much the boom should swing behind a walker going `heading` with the boom at `yaw`: fully
 * after a turn to either side, a little less after turning right round to walk at the camera.
 * Held keys keep the way they set off in while it swings (`steerYaw`), so the view coming round
 * never turns the controls with it.
 */
export function recentreWeight(heading: number, yaw: number): number {
  const off = Math.abs(wrap(heading + Math.PI - yaw));
  const t = Math.min(1, Math.max(0, (off - FOLLOW_FULL) / (Math.PI - FOLLOW_FULL)));
  return 1 - (1 - ABOUT_TURN) * t * t * (3 - 2 * t);
}

/** After someone last turned the view (s), the camera leaves it this long, then takes this long to follow fully. */
const FOLLOW_WAIT = 1;
const FOLLOW_RAMP = 0.6;

/** How much the camera follows (0 to 1), `since` seconds after the view was last turned by hand. */
export function followStrength(since: number): number {
  const t = Math.min(1, Math.max(0, (since - FOLLOW_WAIT) / FOLLOW_RAMP));
  return t * t * (3 - 2 * t);
}

/**
 * The frame keys and the stick steer in: the camera's aim, less however far following the
 * walker has swung it since the input last changed. Holding a key to walk sideways then walks
 * a straight line while the camera comes round behind, instead of a spiral. Pressing anything
 * new (or the stick swinging past ~30°) steers by where the camera is coming to rest, `settle`
 * (behind a walker it's following), or by the camera as it is now if it isn't following: letting
 * go of D while walking with W keeps the way you were going, rather than turning back toward
 * wherever the camera had got to. A look by hand turns the aim, so it turns the steering at once.
 */
export interface SteerFrame {
  /** How far following has turned the aim since the input changed (radians). */
  drift: number;
  /** The input's direction when it last changed (radians), NaN with nothing held. */
  input: number;
}

export const createSteerFrame = (): SteerFrame => ({ drift: 0, input: Number.NaN });

const RELATCH = 0.5;

/** The yaw to steer by for input `right` and `up`, the boom aiming at `aimYaw`. */
export function steerYaw(
  frame: SteerFrame,
  aimYaw: number,
  right: number,
  up: number,
  settle = Number.NaN,
): number {
  if (right === 0 && up === 0) {
    frame.input = Number.NaN;
    frame.drift = 0;
    return aimYaw;
  }
  const input = Math.atan2(right, up);
  if (!(Math.abs(wrap(input - frame.input)) <= RELATCH)) {
    frame.input = input;
    frame.drift = Number.isNaN(settle) ? 0 : wrap(aimYaw - settle);
  }
  return wrap(aimYaw - frame.drift);
}

/** Where the head turns, from where the camera looks: ahead, or back at the camera when it's in front. */
export function headLook(heading: number, boomYaw: number): number {
  const look = wrap(boomYaw + Math.PI - heading);
  return Math.abs(look) <= Math.PI / 2 ? look : wrap(look - Math.PI);
}

/** One end of the flight between the map and the walk. */
export interface Shot {
  look: Vec3;
  yaw: number;
  pitch: number;
  fov: number;
  /** Height of the view (m) at the look point. */
  span: number;
}

/** A camera placed for a moment of the flight: where it looks from and with which lens. */
export interface Lens {
  look: Vec3;
  yaw: number;
  pitch: number;
  fov: number;
  distance: number;
}

const smoother = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/** Height of the view at `distance` from the camera, with a vertical field of view in degrees. */
export const spanAt = (distance: number, fov: number) =>
  2 * distance * Math.tan((fov * Math.PI) / 360);

/** The steepest the flight looks down (radians): short of straight down, where yaw is lost. */
export const DIVE_LIMIT = 1.35;

/**
 * The camera `t` of the way (0 to 1) from shot `a` to shot `b`. The lens widens while the
 * camera closes in so the view's height at the look point shrinks steadily (in log scale):
 * at the narrow end it looks just like the isometric map. A `dive` (radians) tips the view
 * down over the middle of the way, so the camera drops onto the spot from above, as a game's
 * spawn camera does, before it swings in behind; flown backwards, it rises the same way.
 */
export function flight(a: Shot, b: Shot, t: number, out: Lens, dive = 0): Lens {
  const s = smoother(Math.min(1, Math.max(0, t)));
  for (let i = 0; i < 3; i++) out.look[i] = a.look[i]! + (b.look[i]! - a.look[i]!) * s;
  out.yaw = wrap(a.yaw + wrap(b.yaw - a.yaw) * s);
  // The tilt lags the rest, so the camera keeps sinking as it closes in: one arc down behind.
  out.pitch = a.pitch + (b.pitch - a.pitch) * s * s;
  out.pitch = Math.min(Math.max(out.pitch, DIVE_LIMIT), out.pitch + dive * 4 * s * (1 - s));
  out.fov = a.fov + (b.fov - a.fov) * s;
  const span = Math.exp(Math.log(a.span) + (Math.log(b.span) - Math.log(a.span)) * s);
  out.distance = span / spanAt(1, out.fov);
  return out;
}

/**
 * The lowest pitch, from `low` up to the boom's limit, at which a camera `distance` along the
 * boom from `look` sees `look` over every roof: the flight climbs over the houses round a
 * square instead of cutting in through them. Bisected, as a higher boom only clears more.
 */
export function clearPitch(
  heightAt: (x: number, z: number) => number,
  look: Vec3,
  yaw: number,
  distance: number,
  low: number,
): number {
  const dir: Vec3 = [0, 0, 0];
  const clear = (pitch: number) =>
    freeLength(heightAt, look, boomDirection(yaw, pitch, dir), distance) >= distance;
  let [lo, hi]: [number, number] = [low, PITCH_RANGE[1]];
  if (lo >= hi || clear(lo)) return lo;
  if (!clear(hi)) return hi;
  for (let i = 0; i < 8; i++) {
    const mid = (lo + hi) / 2;
    if (clear(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** How many headings round the walker `openYaw` tries, and how much climb still counts as open. */
const YAW_STEPS = 16;
const OPEN_CLIMB = 0.05;

/**
 * The heading nearest `yaw` from which a boom `distance` long at `pitch` sees `look` without
 * climbing over a roof (`clearPitch`): `yaw` itself if it does, else the nearest that does where
 * `ahead` says the walker, facing away from it, has somewhere to go, else the nearest that does;
 * failing all, the one that climbs least. A walk that starts
 * with a house behind the walker lands with the camera beside it instead of straight overhead.
 */
export function openYaw(
  heightAt: (x: number, z: number) => number,
  look: Vec3,
  yaw: number,
  distance: number,
  pitch: number,
  ahead: (yaw: number) => boolean = () => true,
): number {
  let [best, least, open] = [yaw, Infinity, Number.NaN];
  for (let k = 0; k <= YAW_STEPS / 2; k++) {
    for (const side of k === 0 || k === YAW_STEPS / 2 ? [1] : [1, -1]) {
      const at = wrap(yaw + (side * k * 2 * Math.PI) / YAW_STEPS);
      const climb = clearPitch(heightAt, look, at, distance, pitch) - pitch;
      // Open from behind already: the walker steps in facing away from the map, as ever.
      if (climb <= OPEN_CLIMB && (k === 0 || ahead(at))) return at;
      if (climb <= OPEN_CLIMB && Number.isNaN(open)) open = at;
      if (climb < least) [best, least] = [at, climb];
    }
  }
  return Number.isNaN(open) ? best : open;
}

/** The parts of a wheel event that tell a trackpad from a mouse. */
export interface Wheel {
  deltaMode: number;
  deltaX: number;
  deltaY: number;
  ctrlKey: boolean;
  /** Non-standard, but Chrome, Safari and Firefox all send it: ±120 a notch on a mouse. */
  wheelDeltaY?: number;
}

/**
 * What a wheel event is: a pinch (the browser sends trackpad pinches as ctrl + wheel), a
 * two-finger swipe on a trackpad, or a mouse wheel. Swipes look around, the others zoom.
 */
export function wheelKind(event: Wheel): 'pinch' | 'swipe' | 'wheel' {
  if (event.ctrlKey) return 'pinch';
  if (event.deltaMode !== 0) return 'wheel';
  if (event.deltaX !== 0) return 'swipe';
  const notch = event.wheelDeltaY;
  // Chrome and Safari give a trackpad's movement as -3 × its delta; a mouse's as 120 a notch.
  if (notch && Math.abs(notch + 3 * event.deltaY) < 1) return 'swipe';
  if (notch && Number.isInteger(notch / 120)) return 'wheel';
  return 'swipe';
}

/** Pixels in a line and a page of wheel movement, for browsers (Firefox) that count those. */
const LINE = 40;
const PAGE = 800;

/**
 * How much a wheel event that zooms (`wheelKind`) lengthens the boom: about a sixth a mouse
 * notch, whatever unit the browser counts it in, and as far as the fingers go in a pinch. One
 * event never more than halves or doubles it, however fast the wheel spins.
 */
export function wheelZoom(event: Wheel, pinch: boolean): number {
  const unit = event.deltaMode === 1 ? LINE : event.deltaMode === 2 ? PAGE : 1;
  return Math.exp(clamp(event.deltaY * unit * (pinch ? 0.01 : 0.0015), [-0.7, 0.7]));
}

/** The isometric map's yaw nearest a walk's camera: the map only turns in quarters. */
export const mapYaw = (yaw: number) =>
  Math.round((yaw - Math.PI / 4) / (Math.PI / 2)) * (Math.PI / 2) + Math.PI / 4;

/**
 * How the camera follows, which riding retunes: the look point's lead (s of travel) and lag
 * (half-life, s), how fast it comes round behind (a share a second), how much sooner after a look
 * by hand it starts to (s), and a wider lens (degrees) and a roll (radians) on top.
 */
export interface Follow {
  ahead: number;
  ease: number;
  rate: number;
  early: number;
  fov: number;
  roll: number;
}
