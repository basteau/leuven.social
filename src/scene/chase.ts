import { decay, decayAngle } from './motion.ts';

/**
 * The walking camera: a perspective camera on a boom behind the walker, turned by dragging,
 * pulled in when a house stands between it and the walker, and flown in from the map's
 * isometric view and back. Pure maths, so the glue in walk.ts only feeds it input and time.
 * Input moves where the boom aims; the boom eases there by half-lives (motion.ts), so it
 * moves the same at any frame rate and pointer events that arrive unevenly don't judder.
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
/** A run widens the lens by this much (degrees) and lengthens the boom by this share. */
const RUN_FOV = 5;
const RUN_PULL = 0.12;
/** Half-lives (s): the boom turning to where it's aimed, and changing length. */
const AIM_EASE = 0.035;
const LENGTH_EASE = 0.15;
/** Half-lives (s) of pulling in for a wall, and letting out again once past it. */
const PULL_IN = 0.045;
const LET_OUT = 0.3;
/** How close the camera may come to a wall, a roof or the ground (m). */
const CLEARANCE = 0.5;
/** Steps the boom is checked in (m). */
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
  /** Length the person chose, the length it is easing to that, and the length free of walls. */
  distance: number;
  length: number;
  reach: number;
}

export const createBoom = (yaw: number): Boom => ({
  yaw,
  pitch: PITCH,
  aimYaw: yaw,
  aimPitch: PITCH,
  distance: DISTANCE,
  length: DISTANCE,
  reach: DISTANCE,
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
 * How far the camera can back away from `from` along `dir` (up to `max`) before it would sit
 * inside a building or under the ground, less a margin. It walks the boom in steps, then
 * halves the step it hit in a few times, so the length changes smoothly as the walker moves
 * rather than jumping a step at a time. Never less than one step.
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

/**
 * What length to ease the boom to, from the length free along it and along two whiskers
 * either side: a wall that reaches a whisker starts the pull in before it cuts the view, so
 * passing a corner is a short dolly, not a jump.
 */
export const reachGoal = (free: number, left: number, right: number) =>
  Math.min(free, (free + Math.min(left, right)) / 2);

/**
 * Eases the boom toward a free length: in quickly, out gently. `inside` says the camera,
 * where it is now, would sit in a house or under ground: then it is in at once.
 */
export function settleReach(reach: number, goal: number, dt: number, inside = false): number {
  if (inside && goal < reach) return goal;
  return decay(reach, goal, goal < reach ? PULL_IN : LET_OUT, dt);
}

/**
 * Turns where the boom aims round behind a walker facing `heading`, by a share of the way each
 * second (`rate`): the auto-recentre while walking. Its pitch eases back to the default too.
 */
export function recentre(boom: Boom, heading: number, rate: number, dt: number): void {
  const keep = Math.exp(-rate * dt);
  boom.aimYaw = wrap(heading + Math.PI - wrap(heading + Math.PI - boom.aimYaw) * keep);
  boom.aimPitch = PITCH + (boom.aimPitch - PITCH) * keep;
}

/**
 * How much the boom should recentre behind a walker going `heading` with the boom at `yaw`:
 * fully walking away from the camera, a little sideways, not at all walking toward it (that
 * would swing the camera round in front and turn the controls with it).
 */
export function recentreWeight(heading: number, yaw: number): number {
  const away = Math.cos(wrap(heading + Math.PI - yaw));
  return Math.min(1, Math.max(0, (away + 0.3) / 1.3)) ** 2;
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

/**
 * The camera `t` of the way (0 to 1) from shot `a` to shot `b`. The lens widens while the
 * camera closes in so the view's height at the look point shrinks steadily (in log scale):
 * at the narrow end it looks just like the isometric map.
 */
export function flight(a: Shot, b: Shot, t: number, out: Lens): Lens {
  const s = smoother(Math.min(1, Math.max(0, t)));
  for (let i = 0; i < 3; i++) out.look[i] = a.look[i]! + (b.look[i]! - a.look[i]!) * s;
  out.yaw = wrap(a.yaw + wrap(b.yaw - a.yaw) * s);
  // The tilt lags the rest, so the camera keeps sinking as it closes in: one arc down behind.
  out.pitch = a.pitch + (b.pitch - a.pitch) * s * s;
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

/** The isometric map's yaw nearest a walk's camera: the map only turns in quarters. */
export const mapYaw = (yaw: number) =>
  Math.round((yaw - Math.PI / 4) / (Math.PI / 2)) * (Math.PI / 2) + Math.PI / 4;
