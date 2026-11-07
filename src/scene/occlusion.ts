/**
 * Keeping the avatar in sight from 35° up, where a house across a six-metre street hides it most
 * of the time. Whatever stands between the camera and the avatar dithers away: a cylinder round
 * the line of sight, from the avatar's chest toward the camera, drops a share of each fragment
 * in it (all of it near the line, none at its rim) in the ordered dither the city already uses
 * for its lamps. Dither, never alpha: no sorting and no overdraw. The street underfoot is spared,
 * and everything behind the avatar. Where the dither leaves a part of the figure hidden anyway,
 * its x-ray silhouette shows (character-material.ts). One rule, here twice: as TypeScript for
 * the tests, and as GLSL for the city's materials, kept in step by test.
 */

/** The point the line of sight is drawn from: the avatar's chest, this high over its feet (m). */
export const CHEST = 1.2;
/** The cylinder's radius at street zoom (m), widening with the view so it stays a few % of it. */
const RADIUS = 2.4;
const RADIUS_SHARE = 0.03;
/** Fully gone inside this share of the radius, fading to nothing at the rim. */
const CORE = 0.6;
/** What lies less than this nearer the camera than the chest is the avatar's own neighbourhood (m). */
const IN_FRONT = 0.3;
/** Fragments under this height over the avatar's feet are its street: never dithered (m). */
const STREET = 0.4;

/** How wide the opening is for a view this tall (m). */
export const ditherRadius = (span: number) => RADIUS + span * RADIUS_SHARE;

export type Vec3 = readonly [number, number, number];

/**
 * The share of the fragment at `p` that drops out (0 to 1), for an avatar whose feet are at
 * `feet`, seen along `view` (unit, from the camera into the scene) through an opening `radius`
 * wide. 0 for a radius of 0: the dither is off.
 */
export function ditherShare(p: Vec3, feet: Vec3, view: Vec3, radius: number): number {
  if (radius <= 0 || p[1] < feet[1] + STREET) return 0;
  const [dx, dy, dz] = [p[0] - feet[0], p[1] - feet[1] - CHEST, p[2] - feet[2]];
  const along = dx * view[0] + dy * view[1] + dz * view[2];
  if (along > -IN_FRONT) return 0;
  const lateral = Math.hypot(dx - along * view[0], dy - along * view[1], dz - along * view[2]);
  const t = Math.min(1, Math.max(0, (lateral - CORE * radius) / ((1 - CORE) * radius)));
  return 1 - t * t * (3 - 2 * t);
}

const f = (v: number) => v.toFixed(4);

/**
 * The same, in GLSL: uniforms `uAvatar` (feet xyz, radius in w) and `uView`, and
 * `avatarDither(world)` returning the share to drop. Needs nothing else.
 */
export const DITHER_GLSL = `uniform vec4 uAvatar;
uniform vec3 uView;
float avatarDither(vec3 p) {
  if (uAvatar.w <= 0.0 || p.y < uAvatar.y + ${f(STREET)}) return 0.0;
  vec3 d = p - uAvatar.xyz - vec3(0.0, ${f(CHEST)}, 0.0);
  float along = dot(d, uView);
  if (along > -${f(IN_FRONT)}) return 0.0;
  float lateral = length(d - along * uView);
  return 1.0 - smoothstep(${f(CORE)} * uAvatar.w, uAvatar.w, lateral);
}`;
