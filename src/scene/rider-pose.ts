import { BRACKET, CRANK, GRIPS, SADDLE, STEERING } from './bike-rig.ts';
import { FOREARM, SHIN, THIGH, UPPER_ARM, limbIK } from './character.ts';
import type { Limb, Pose } from './character.ts';

/**
 * The walker riding: the figure's own rig, posed on the bike by two-bone IK, so the feet stay on
 * the pedals and the hands on the grips whatever the crank and the bars do. Seated it pedals with
 * the crank; sprinting it stands up and rocks with it, its hips rising and dipping as the low
 * pedal lets them; coasting holds the pedals level; stopped, it slides forward off the saddle
 * and puts its left foot down while the bike leans onto it. The torso leans in from 0.25 to 0.45
 * rad and the head lifts against it to look ahead. Getting on and off blends from standing.
 *
 * Model metres, as the figure's and the bike's (both drawn 1.3×): the figure's root is the bike's
 * middle on the ground, facing +z, its left toward +x.
 */

/** The figure's joints that the pose places, as in character.ts (`JOINTS`). */
export const HIP_X = 0.1;
export const ANKLE = 0.09;
export const SHOULDER = { x: 0.27, y: 0.5 } as const;
/** The ball of the foot, which rests on the pedal, ahead of the ankle (model metres). */
const BALL = 0.08;
/** Hips on the saddle, standing on the pedals, and slid forward with a foot down (y, z). */
const SEATED = [SADDLE[1] + 0.06, SADDLE[0] + 0.03] as const;
const STANDING = [0.98, -0.12] as const;
const FOOT_DOWN = [0.8, -0.08] as const;
/** Torso lean seated, standing and with a foot down (radians). */
const LEAN = [0.4, 0.45, 0.25] as const;
/**
 * The most the bars are drawn turned (radians): the figure's arms swing only in their own plane,
 * so further round a hand would leave its grip. The bike steers as far as it likes underneath.
 */
export const SHOWN_STEER = 0.25;
/** The body's sway with each push when standing (radians). */
export const ROCK = 0.1;
/** The longest a leg reaches (model metres), as the walker's. */
const REACH = THIGH + SHIN - 0.004;
/** How far the bike leans onto the foot put down (radians), to find the ground under it. */
const FOOT_LEAN = 0.12;

export interface RideState {
  /** Crank angle (radians, 0 with the left pedal down, turning forward). */
  crank: number;
  /** The bars' turn (radians, toward +x positive). */
  steer: number;
  /** Standing on the pedals, and a foot down: 0 to 1. */
  stand: number;
  foot: number;
  /** Where the head turns, from straight ahead (radians). */
  look: number;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const limb: Limb = { root: 0, joint: 0 };
const ankle = { z: 0, y: 0 };

/** Where a pedal is, side 1 the left and -1 the right, in the bike's plane (z forward, y up). */
function pedal(crank: number, side: 1 | -1, out: { z: number; y: number }) {
  out.z = BRACKET[0] + side * CRANK * Math.sin(crank);
  out.y = BRACKET[1] - side * CRANK * Math.cos(crank);
  return out;
}

/** The ankle over a pedal: the ball of the foot on it, the heel a little down as it pushes. */
function onPedal(crank: number, side: 1 | -1, out: { z: number; y: number }) {
  pedal(crank, side, out);
  out.z -= BALL;
  out.y += ANKLE + 0.02;
  return out;
}

/**
 * The riding pose, written into `out` (no allocation). Returns `out`.
 */
export function rideAt(out: Pose, s: RideState): Pose {
  const { crank, stand, foot } = s;
  // The hips: on the saddle, up off it standing, or forward and down with a foot on the ground.
  let hips = lerp(SEATED[0], STANDING[0], stand);
  out.hipsZ = lerp(lerp(SEATED[1], STANDING[1], stand), FOOT_DOWN[1], foot);
  if (stand > 0) {
    // Standing, the hips ride as high as the lower pedal lets the leg reach, so they dip with it.
    const lowest = Math.min(onPedal(crank, 1, ankle).y, onPedal(crank, -1, ankle).y);
    hips = lerp(SEATED[0], Math.min(STANDING[0], lowest + REACH - 0.01), stand);
  }
  out.hips = lerp(hips, FOOT_DOWN[0], foot);
  out.roll = ROCK * stand * Math.sin(crank) * (1 - foot);

  for (const side of [1, -1] as const) {
    onPedal(crank, side, ankle);
    let pitch = 0.25 + 0.15 * Math.sin(crank + (side > 0 ? 0 : Math.PI));
    if (side > 0 && foot > 0) {
      // The left foot comes off its pedal to the ground beside the bike, which leans onto it.
      const groundY = ANKLE + HIP_X * Math.tan(FOOT_LEAN * foot);
      ankle.z = lerp(ankle.z, out.hipsZ + 0.06, foot);
      ankle.y = lerp(ankle.y, groundY, foot);
      pitch = lerp(pitch, 0, foot);
    }
    limbIK(limb, ankle.z - out.hipsZ, ankle.y - out.hips, THIGH, SHIN, 1);
    const turn = pitch - limb.root - limb.joint;
    if (side > 0) [out.legL, out.kneeL, out.footL] = [limb.root, limb.joint, turn];
    else [out.legR, out.kneeR, out.footR] = [limb.root, limb.joint, turn];
  }

  // The torso leans over the bars; the arms reach the grips, which turn with the bars.
  out.lean = lerp(lerp(LEAN[0], LEAN[1], stand), LEAN[2], foot);
  out.twist = 0;
  out.bank = -out.roll * 0.5;
  const [cl, sl] = [Math.cos(out.lean), Math.sin(out.lean)];
  for (const side of [1, -1] as const) {
    const [, , gz] = gripAt(s.steer, side);
    // From the shoulder, in the torso's frame (its lean undone). The arms swing in their own
    // plane, so a grip turned in or out is reached in line with it (`SHOWN_STEER`).
    const dy = GRIPS.y - (out.hips + SHOULDER.y * cl);
    const dz = gz - (out.hipsZ + SHOULDER.y * sl);
    limbIK(limb, -dy * sl + dz * cl, dy * cl + dz * sl, UPPER_ARM, FOREARM, -1);
    if (side > 0) [out.armL, out.elbowL] = [limb.root, limb.joint];
    else [out.armR, out.elbowR] = [limb.root, limb.joint];
  }
  // The head lifts against the lean to look down the street.
  out.nod = -0.85 * out.lean;
  out.look = Math.max(-1.1, Math.min(1.1, s.look));
  return out;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/**
 * Getting on or off: `from` blended into `to`, `t` of the way (0 to 1, eased), written into
 * `out`. Halfway, the right leg swings high over the saddle.
 */
export function blendPose(out: Pose, from: Pose, to: Pose, t: number): Pose {
  const k = smooth(Math.min(1, Math.max(0, t)));
  for (const key of Object.keys(to) as (keyof Pose)[]) out[key] = lerp(from[key], to[key], k);
  const swing = Math.sin(Math.PI * k);
  out.legR -= 1.1 * swing;
  out.kneeR += 1.2 * swing;
  return out;
}

/** Where a grip is, for the tests: side 1 the left, in the bike's frame (x, y, z). */
export function gripAt(steer: number, side: 1 | -1): [number, number, number] {
  const [gx, gz] = [side * GRIPS.x, GRIPS.z - STEERING];
  const [c, s] = [Math.cos(steer), Math.sin(steer)];
  return [gx * c + gz * s, GRIPS.y, -gx * s + gz * c + STEERING];
}

/** Where a pedal is, for the tests and the rig: side 1 the left (z, y). */
export const pedalAt = (crank: number, side: 1 | -1) => pedal(crank, side, { z: 0, y: 0 });
