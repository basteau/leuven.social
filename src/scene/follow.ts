import { decay } from './motion.ts';

/**
 * How the one camera keeps the avatar in view without ever being mounted on it: while pinned, its
 * target glides after the avatar by a half-life (motion.ts), so it moves the same at any frame
 * rate; a drag lets go of it, and the view is the person's until they bring it back. The camera
 * only translates: its pitch is the map's and its yaw stays in quarter turns. Pure maths; the
 * glue in avatar-layer.ts feeds it time and input.
 */

/** Half-life (s) of the target's glide to the avatar, or to a place. */
export const FOLLOW_EASE = 0.18;
/** Close enough (m): the glide has arrived. */
const ARRIVED = 0.01;
/** The target leads the avatar by this much of its travel (s), so the street ahead shows. */
export const LEAD = 0.35;

/** A point on the ground the camera looks at. */
export interface Target {
  x: number;
  z: number;
}

/** Eases the camera's target toward (x, z) for `dt` seconds. Returns whether it is still on its way. */
export function recentre(at: Target, x: number, z: number, dt: number): boolean {
  at.x = decay(at.x, x, FOLLOW_EASE, dt);
  at.z = decay(at.z, z, FOLLOW_EASE, dt);
  const off = Math.hypot(x - at.x, z - at.z);
  if (off < ARRIVED) [at.x, at.z] = [x, z];
  return off >= ARRIVED;
}

/**
 * The world direction (x, z) of keys held toward `right` and `up` on screen, for a camera
 * at `yaw` (radians, 0 looking toward -z from the +z side): up is away from the camera. With the
 * map's yaw in quarter turns, W walks up the screen whichever way the map is turned.
 */
export function screenSteer(yaw: number, right: number, up: number): [x: number, z: number] {
  const [fx, fz] = [-Math.sin(yaw), -Math.cos(yaw)];
  return [-fz * right + fx * up, fx * right + fz * up];
}
