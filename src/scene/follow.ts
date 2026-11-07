import { decay } from './motion.ts';

/**
 * How the one camera keeps the avatar in view without ever being mounted on it. Panning is always
 * the person's: it pauses following, and a while after the last pan (or at once on a recentre)
 * the camera's target eases back to the avatar, by half-lives (motion.ts), so it glides the same
 * at any frame rate. The camera only translates: its pitch is the map's and its yaw stays in
 * quarter turns. Pure maths; the glue in avatar-layer.ts feeds it time and input.
 */

/** After the last pan or zoom by hand (s), the camera leaves the view alone this long, then ramps in over this long. */
export const FOLLOW_WAIT = 2;
const FOLLOW_RAMP = 0.6;
/** Half-life (s) of the target's glide to the avatar once following fully. */
export const FOLLOW_EASE = 0.18;
/** Close enough (m): the glide has arrived. */
const ARRIVED = 0.01;
/** The target leads the avatar by this much of its travel (s), so the street ahead shows. */
export const LEAD = 0.35;

/** How much the camera follows (0 to 1), `since` seconds after the view was last moved by hand. */
export function followStrength(since: number): number {
  const t = Math.min(1, Math.max(0, (since - FOLLOW_WAIT) / FOLLOW_RAMP));
  return t * t * (3 - 2 * t);
}

/** A point on the ground the camera looks at. */
export interface Target {
  x: number;
  z: number;
}

/**
 * Eases the camera's target toward (x, z) for `dt` seconds, at `strength` of the full glide (0
 * leaves it be). Returns whether it is still on its way.
 */
export function recentre(at: Target, x: number, z: number, strength: number, dt: number): boolean {
  if (strength <= 0) return false;
  // A weaker follow is a longer half-life: the glide eases in rather than starting at full pace.
  const halfLife = FOLLOW_EASE / strength;
  at.x = decay(at.x, x, halfLife, dt);
  at.z = decay(at.z, z, halfLife, dt);
  const off = Math.hypot(x - at.x, z - at.z);
  if (off < ARRIVED) [at.x, at.z] = [x, z];
  return off >= ARRIVED;
}

/**
 * The world direction (x, z) of a key or stick held toward `right` and `up` on screen, for a camera
 * at `yaw` (radians, 0 looking toward -z from the +z side): up is away from the camera. With the
 * map's yaw in quarter turns, W walks up the screen whichever way the map is turned.
 */
export function screenSteer(yaw: number, right: number, up: number): [x: number, z: number] {
  const [fx, fz] = [-Math.sin(yaw), -Math.cos(yaw)];
  return [-fz * right + fx * up, fx * right + fz * up];
}
