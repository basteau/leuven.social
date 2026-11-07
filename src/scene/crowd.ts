import { BIKE_STRIDE } from './avatar.ts';
import { STRIDE_RUN, STRIDE_WALK, runBlend } from './walker.ts';

/**
 * The other players, as the map draws them: where each is (as the app's roster samples it, a
 * moment behind the network, smoothly), and the gait the figure takes from that, stepped here as
 * the avatar's own walker steps it. Pure, so it is tested; players.ts draws it.
 */

/** Where someone is and what they're doing: the network's state, sampled for a frame. */
export interface PlayerPose {
  x: number;
  z: number;
  /** Which way they face: 0 is +z, as the walker's heading. */
  heading: number;
  /** How fast they go (m/s). */
  speed: number;
  mode: 'foot' | 'bike';
  /** The room they are in ('' in the street), and on which floor. */
  place: string;
  floor: number;
}

/** What a figure's limbs and lean need, from frame to frame. */
export interface Gait {
  /** Where the legs (or the pedals) are in their cycle (radians). */
  phase: number;
  /** How long they've stood still (s), for the idle: breathing, a glance, a weight shift. */
  still: number;
  /** How fast they turn (radians a second, left positive), eased. */
  turning: number;
  /** A bike's lean into the turn (radians). */
  lean: number;
  /** The heading last frame, to tell the turn from. */
  heading: number;
}

/** A turn's rate eases in with this half-life (s): a network sample is a step, not a curve. */
const TURN_EASE = 0.12;
/** Under this (m/s), they stand. */
const STANDING = 0.05;
/** A bike leans this share of what a real one would, at most MAX_LEAN (as bikes.ts). */
const LEAN_SHARE = 0.45;
const MAX_LEAN = (16 * Math.PI) / 180;
const G = 9.8;

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export function createGait(heading = 0): Gait {
  return { phase: 0, still: 0, turning: 0, lean: 0, heading };
}

/**
 * Steps a gait `dt` seconds on to `pose`: the legs swing at the walker's stride for that speed
 * (the pedals at a bike's), the turn and the lean ease toward what the heading's change says.
 */
export function stepGait(g: Gait, pose: PlayerPose, dt: number): void {
  if (dt <= 0) return;
  const k = 1 - Math.exp((-dt * Math.LN2) / TURN_EASE);
  g.turning += (wrap(pose.heading - g.heading) / dt - g.turning) * k;
  g.heading = pose.heading;
  const stride =
    pose.mode === 'bike'
      ? BIKE_STRIDE
      : STRIDE_WALK + (STRIDE_RUN - STRIDE_WALK) * runBlend(pose.speed);
  g.phase = (g.phase + (pose.speed / stride) * Math.PI * 2 * dt) % (Math.PI * 2);
  g.still = pose.speed > STANDING ? 0 : g.still + dt;
  const want =
    pose.mode === 'bike'
      ? Math.max(
          -MAX_LEAN,
          Math.min(MAX_LEAN, -Math.atan((pose.speed * g.turning) / G) * LEAN_SHARE),
        )
      : 0;
  g.lean += (want - g.lean) * k;
}

/** Whether a figure seen from `here` (its room and floor; '' the street) shows. */
export const together = (pose: PlayerPose, place: string, floor: number) =>
  pose.place === place && (place === '' || pose.floor === floor);

/** The distances `nearestOf` keeps beside its indices, reused from call to call. */
const far: number[] = [];

/**
 * Which of `points` (x, z pairs, flat) to draw: the `most` nearest (x, z), as their indices,
 * nearest first, into `out`. Each frame, so it allocates nothing.
 */
export function nearestOf(
  points: ArrayLike<number>,
  count: number,
  x: number,
  z: number,
  most: number,
  out: number[],
): number[] {
  out.length = 0;
  far.length = 0;
  for (let i = 0; i < count; i++) {
    const d = Math.hypot(points[i * 2]! - x, points[i * 2 + 1]! - z);
    let at = out.length;
    while (at > 0 && far[at - 1]! > d) at--;
    if (at >= most) continue;
    out.splice(at, 0, i);
    far.splice(at, 0, d);
    if (out.length > most) {
      out.pop();
      far.pop();
    }
  }
  return out;
}
