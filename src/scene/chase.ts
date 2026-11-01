/**
 * The walking camera: a perspective camera on a boom behind the walker, turned by dragging,
 * pulled in when a house stands between it and the walker, and flown in from the map's
 * isometric view and back. Pure maths, so the glue in walk.ts only feeds it input and time.
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
  /** Length the person chose, and the length free of walls right now. */
  distance: number;
  reach: number;
}

export const createBoom = (yaw: number): Boom => ({
  yaw,
  pitch: PITCH,
  distance: DISTANCE,
  reach: DISTANCE,
});

const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v));
export const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Turns the boom by the given angles, keeping its pitch between looking up and straight down. */
export function turnBoom(boom: Boom, yaw: number, pitch: number): void {
  boom.yaw = wrap(boom.yaw + yaw);
  boom.pitch = clamp(boom.pitch + pitch, PITCH_RANGE);
}

/** Lengthens the boom by `factor`, within its limits. */
export function stretchBoom(boom: Boom, factor: number): void {
  boom.distance = clamp(boom.distance * factor, DISTANCE_RANGE);
}

/** The vertical field of view for a screen's aspect: wider on tall screens (degrees). */
export function chaseFov(aspect: number): number {
  const side = Math.tan((MIN_SIDE_FOV * Math.PI) / 360) / aspect;
  return Math.max(CHASE_FOV, (Math.atan(side) * 360) / Math.PI);
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
 * inside a building or under the ground: the first step whose point is lower than the roof
 * under it, less a margin. Never less than one step.
 */
export function freeLength(
  heightAt: (x: number, z: number) => number,
  from: Vec3,
  dir: Vec3,
  max: number,
): number {
  for (let t = STEP; t <= max; t += STEP) {
    const y = from[1] + dir[1] * t;
    // Rising above every roof, it's clear the rest of the way.
    if (dir[1] >= 0 && y > ROOF_LIMIT) return max;
    if (y < heightAt(from[0] + dir[0] * t, from[2] + dir[2] * t) + CLEARANCE) {
      return Math.max(STEP, t - STEP);
    }
  }
  return max;
}

/** Eases the boom toward a free length: in at once, so no wall cuts the view, out gently. */
export function settleReach(reach: number, free: number, dt: number, rate = 4): number {
  if (free <= reach) return free;
  return free - (free - reach) * Math.exp(-rate * dt);
}

/** Swings the boom behind a walker facing `heading`, at up to `rate` rad/s, for routes. */
export function swingBehind(boom: Boom, heading: number, rate: number, dt: number): void {
  const behind = wrap(heading + Math.PI - boom.yaw);
  boom.yaw = wrap(boom.yaw + Math.sign(behind) * Math.min(Math.abs(behind), rate * dt));
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
  out.pitch = a.pitch + (b.pitch - a.pitch) * s;
  out.fov = a.fov + (b.fov - a.fov) * s;
  const span = Math.exp(Math.log(a.span) + (Math.log(b.span) - Math.log(a.span)) * s);
  out.distance = span / spanAt(1, out.fov);
  return out;
}

/** The isometric map's yaw nearest a walk's camera: the map only turns in quarters. */
export const mapYaw = (yaw: number) =>
  Math.round((yaw - Math.PI / 4) / (Math.PI / 2)) * (Math.PI / 2) + Math.PI / 4;
