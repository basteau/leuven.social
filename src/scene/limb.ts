/**
 * The figure's limbs and the two-bone IK that places them: walking puts its feet on the ground
 * with it (character.ts), riding its feet on the pedals and its hands on the bars (rider-pose.ts).
 * A module of its own, so riding's chunk can pose the figure without the code that builds it.
 */

/** Hip to knee and knee to ankle (model metres). */
export const THIGH = 0.37;
export const SHIN = 0.36;
/** Shoulder to elbow, and elbow to the middle of the hand (model metres). */
export const UPPER_ARM = 0.24;
export const FOREARM = 0.27;

/** Angles for a two-bone limb: its root's swing and its middle joint's bend (radians). */
export interface Limb {
  root: number;
  joint: number;
}

/**
 * Two-bone inverse kinematics in a limb's plane: the swing of its root and the bend of its middle
 * joint that put the end of a limb (`upper` then `lower` long, hanging straight down at rest) at
 * `z` forward and `y` up from its root, written into `out`. Angles turn about x as the bones do:
 * a positive swing carries the end back. `bend` 1 bends the joint forward, as a knee does (a
 * positive bend); -1 back, as an elbow does. Out of reach, the limb points at the target as far
 * as it goes; too close, it folds as far as it can.
 */
export function limbIK(
  out: Limb,
  z: number,
  y: number,
  upper: number,
  lower: number,
  bend: 1 | -1,
): Limb {
  const d = Math.min(
    upper + lower - 1e-6,
    Math.max(Math.abs(upper - lower) + 1e-6, Math.hypot(z, y)),
  );
  const aim = Math.atan2(-z, -y);
  const atRoot = Math.acos((upper * upper + d * d - lower * lower) / (2 * upper * d));
  const atJoint = Math.acos((upper * upper + lower * lower - d * d) / (2 * upper * lower));
  out.root = aim - bend * atRoot;
  out.joint = bend * (Math.PI - atJoint);
  return out;
}
