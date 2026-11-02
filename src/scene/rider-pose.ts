import { BRACKET, CRANK, GRIPS, SADDLE, STEERING } from './bike-rig.ts';
import { FOREARM, SHIN, THIGH, UPPER_ARM } from './limb.ts';
import type { Pose } from './character.ts';

/**
 * The walker riding: the figure's own rig, posed on the bike by two-bone IK, so the feet stay on
 * the pedals and the hands on the grips whatever the crank and the bars do. Seated it pedals with
 * the crank; sprinting it stands up and rocks with it, its hips rising and dipping as the low
 * pedal lets them; coasting holds the pedals level; stopped, it slides forward off the saddle
 * and puts its left foot down out beside the bike, which leans onto it. The torso leans in from
 * 0.25 to 0.45 rad, sits up against the bike's lean, and the head lifts to look ahead.
 *
 * Getting on and off are scripted (`mountAt`, `dismountAt`): keyed tracks for where the figure
 * stands by the bike, how it and the bike lean, its hips and torso, and where each ankle goes,
 * eased through by monotone cubics so nothing stops dead at a key or overshoots into the ground.
 * The legs reach their ankles by IK with the thigh splayed out from the hip, so a planted foot
 * stays planted, and the hands hold the grips as the bike leans and turns.
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
/** With a foot down, how far out from the bike's middle the ankle stands (model metres). */
export const FOOT_X = 0.26;
/** Torso lean seated, standing and with a foot down (radians). */
const LEAN = [0.4, 0.45, 0.25] as const;
/**
 * The most the bars are drawn turned (radians): the hands follow the grips round (`reach`), the
 * shoulders turning a little with them. The bike steers as far as it likes underneath.
 */
export const SHOWN_STEER = 0.5;
/** The body's sway with each push when standing (radians). */
export const ROCK = 0.1;
/** The longest a leg reaches (model metres), as the walker's. */
const REACH = THIGH + SHIN - 0.004;
/**
 * The share of the bike's lean the torso takes back, so the rider sits more upright than the bike
 * leans, as riders do at a city pace.
 */
export const UPRIGHT = 0.4;
/** Arms at rest, as the walker's (`ARM_SPREAD` and `REST_ELBOW` in character.ts). */
const REST_SPREAD = 0.07;
const REST_ELBOW = -0.12;
/** The furthest an arm stretches, of its length, never quite locked straight. */
const STRETCH = 0.97;

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
  /** How far the bike leans (radians, toward +x), which the torso leans only part of. */
  lean: number;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const ankle = { z: 0, y: 0 };

/**
 * Turns a point by an angle about the forward axis, toward +x for a positive one: a lean, as the
 * rig leans the figure and the bike (`rotation.z = -lean`). Written into `out` as (x, y).
 */
function tip(x: number, y: number, by: number, out: number[]): number[] {
  const c = Math.cos(by);
  const s = Math.sin(by);
  out[0] = x * c + y * s;
  out[1] = y * c - x * s;
  return out;
}
const tipped = [0, 0];

/**
 * An arm reaching a grip (x, y, z in the figure's frame), side 1 the left, written into `out`: the
 * grip brought into the torso's frame (the hips' roll, the lean, twist and bank undone, from the
 * shoulder), the elbow bent to its distance, the arm swung out (its spread) until the hand is as
 * far across as the grip, then forward or back onto it. Exact, so a hand stays on its grip
 * however far the bars turn. Returns how far the grip is beyond the arm's easy stretch.
 */
function reach(out: Pose, side: 1 | -1, [gx, gy, gz]: readonly number[]): number {
  let [x, y, z, c, s, t] = [gx!, gy! - out.hips, gz! - out.hipsZ, 0, 0, 0];
  // Each turn undone in the order the rig makes them: the hips' roll, the lean, twist and bank.
  [c, s] = [Math.cos(out.roll), Math.sin(out.roll)];
  [t, y] = [x * c + y * s, y * c - x * s];
  x = t;
  [c, s] = [Math.cos(out.lean), Math.sin(out.lean)];
  [t, z] = [y * c + z * s, z * c - y * s];
  y = t;
  [c, s] = [Math.cos(out.twist), Math.sin(out.twist)];
  [t, x] = [z * c + x * s, x * c - z * s];
  z = t;
  [c, s] = [Math.cos(out.bank), Math.sin(out.bank)];
  [t, y] = [x * c + y * s, y * c - x * s];
  x = t;
  [x, y] = [x - side * SHOULDER.x, y - SHOULDER.y];
  // The elbow bends to the distance (negative folds forward), and the arm, along its own y and z
  // with the bend alone, is then (0, wy, wz).
  const length = Math.hypot(x, y, z);
  const cos = (length * length - UPPER_ARM ** 2 - FOREARM ** 2) / (2 * UPPER_ARM * FOREARM);
  const elbow = -Math.acos(clamp(cos, -1, 1));
  const [wy, wz] = [-UPPER_ARM - FOREARM * Math.cos(elbow), -FOREARM * Math.sin(elbow)];
  // A grip further across than the bent arm reaches is met as near as it can be, without the
  // arm whipping round to it.
  const spread = Math.asin(clamp((side * x) / -wy, -0.95, 0.95));
  const arm = Math.atan2(z, y) - Math.atan2(wz, wy * Math.cos(spread));
  const swing = Math.atan2(Math.sin(arm), Math.cos(arm));
  if (side > 0) [out.armL, out.elbowL, out.spreadL] = [swing, elbow, spread];
  else [out.armR, out.elbowR, out.spreadR] = [swing, elbow, spread];
  return length - (UPPER_ARM + FOREARM) * STRETCH;
}

/**
 * A leg reaching an ankle (x, y, z in the figure's frame), side 1 the left, the toes pitched
 * `pitch` (radians, down positive): the thigh splayed out from the hip (the leg's outermost
 * turn) into the plane through hip, ankle and the way ahead, then the knee bent to the distance
 * and the leg swung forward or back onto it in that plane. Exact within reach; the hips' roll is
 * left out, as small.
 */
function leg(out: Pose, side: 1 | -1, x: number, y: number, z: number, pitch: number): void {
  const dx = x - side * HIP_X;
  const dy = y - out.hips;
  const dz = z - out.hipsZ;
  // The plane turns round the way ahead with the ankle, through level with the hip and on over
  // the top (the knee then up): continuous, but for an ankle right behind or ahead of the hip,
  // which the tracks below keep clear of.
  const across = Math.atan2(dx, -dy);
  const down = dy * Math.cos(across) - dx * Math.sin(across);
  const length = Math.min(REACH, Math.hypot(down, dz));
  const knee = Math.acos(clamp((length ** 2 - THIGH ** 2 - SHIN ** 2) / (2 * THIGH * SHIN), -1, 1));
  const swing =
    Math.atan2(dz, down) - Math.atan2(-SHIN * Math.sin(knee), -THIGH - SHIN * Math.cos(knee));
  const thigh = Math.atan2(Math.sin(swing), Math.cos(swing));
  const turn = pitch - thigh - knee;
  if (side > 0) [out.legL, out.kneeL, out.footL, out.splayL] = [thigh, knee, turn, across];
  else [out.legR, out.kneeR, out.footR, out.splayR] = [thigh, knee, turn, -across];
}

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
 * The hands on the grips of a bike `grip` of the way (0 leaves the arms as they are): the
 * bike's middle at (x, z) in the figure's frame, turned `turn` from it, the bars `steer`, the bike
 * leaning `lean` and the figure `tilt` (radians, toward +x).
 */
export function hold(
  out: Pose,
  x: number,
  z: number,
  turn: number,
  lean: number,
  tilt: number,
  steer: number,
  grip: number,
): Pose {
  const c = Math.cos(turn);
  const s = Math.sin(turn);
  const was = [out.armL, out.armR, out.elbowL, out.elbowR, out.spreadL, out.spreadR];
  for (const side of [1, -1] as const) {
    const g = gripAt(steer, side);
    tip(g[0], g[1], lean, tipped);
    // Into the figure's frame: turned and moved by the bike's place, then the figure's lean undone.
    const [gx, gz] = [x + tipped[0]! * c + g[2] * s, z - tipped[0]! * s + g[2] * c];
    tip(gx, tipped[1]!, -tilt, g);
    g[2] = gz;
    reach(out, side, g);
  }
  out.armL = lerp(was[0]!, out.armL, grip);
  out.armR = lerp(was[1]!, out.armR, grip);
  out.elbowL = lerp(was[2]!, out.elbowL, grip);
  out.elbowR = lerp(was[3]!, out.elbowR, grip);
  out.spreadL = lerp(was[4]!, out.spreadL!, grip);
  out.spreadR = lerp(was[5]!, out.spreadR!, grip);
  return out;
}

/**
 * The riding pose, written into `out` (no allocation). Returns `out`.
 */
export function rideAt(out: Pose, s: RideState): Pose {
  const { crank, stand, foot, lean } = s;
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
    let x = side * HIP_X;
    let pitch = 0.25 + 0.15 * Math.sin(crank + (side > 0 ? 0 : Math.PI));
    if (side > 0 && foot > 0) {
      // The left foot comes off its pedal, up a little and down to the ground out beside the
      // bike, which leans onto it: there, in the bike's leaning frame.
      tip(FOOT_X, ANKLE, -lean, tipped);
      x = lerp(x, tipped[0]!, foot);
      ankle.z = lerp(ankle.z, out.hipsZ + 0.06, foot);
      ankle.y = lerp(ankle.y, tipped[1]!, foot) + 0.08 * Math.sin(Math.PI * foot);
      pitch = lerp(pitch, 0, foot);
    }
    leg(out, side, x, ankle.y, ankle.z, pitch);
  }

  // The torso leans over the bars, square to them: a twist would turn the hips against it
  // (`applyPose`) and the feet off the pedals. It sits up against the bike's lean. The arms reach
  // the grips, which turn with the bars.
  out.lean = lerp(lerp(LEAN[0], LEAN[1], stand), LEAN[2], foot);
  out.twist = 0;
  out.bank = -out.roll * 0.5 + UPRIGHT * lean;
  // A grip turned out of reach brings the shoulders forward over the bars.
  for (let more = 0; more < 6; more++) {
    const short = Math.max(reach(out, 1, gripAt(s.steer, 1)), reach(out, -1, gripAt(s.steer, -1)));
    if (short <= 0) break;
    out.lean += 0.06;
  }
  // The head lifts against the lean to look down the street.
  out.nod = -0.85 * out.lean;
  out.look = clamp(s.look, -1.1, 1.1);
  return out;
}

/**
 * Where the figure stands getting on or off, in the bike's frame (model metres, x to the bike's
 * left, z ahead of its middle), how far it and the bike lean (radians, toward +x), and how firmly
 * the hands hold the grips (0 to 1).
 */
export interface Place {
  x: number;
  z: number;
  tilt: number;
  bike: number;
  grip: number;
}

/** Getting on, where the figure stands by the bike to start (x to its left, z ahead; model m). */
export const STANCE = [0.31, -0.16] as const;

/**
 * The tracks of getting on and off, a key a row: its time (0 to 1), where the figure stands (x,
 * z) and leans, the bike's lean, the hips' height and how far forward, the torso's lean, the left
 * and right ankles (x, y, z, in the bike's frame stood upright; y is ANKLE, 0.09, on the ground)
 * and the hands' grip. The first and last rows are partly filled in from the moment (`fill`).
 *
 * Getting on, from the bike's left: stand by it, take the bars and tip it a little toward you,
 * swing the right leg back and up over the carrier with the body leaning out over the bars,
 * bring it down the far side onto the forward pedal, and step the left foot in under you as you
 * sit forward, the bike leaning onto it.
 */
const MOUNT = [
  [0, 31, -16, 0, 0, 80, 0, 5, 41, 9, -16, 21, 9, -16, 0],
  [24, 31, -16, -2, 14, 76, 0, 30, 41, 9, -16, 21, 9, -16, 100],
  [40, 28, -16, -8, 16, 72, -3, 36, 41, 9, -16, 24, 74, -52, 100],
  [53, 24, -14, -10, 16, 72, -3, 42, 41, 9, -16, -4, 100, -58, 100],
  [65, 14, -10, -4, 15, 74, -3, 38, 41, 9, -16, -20, 72, -50, 100],
  [75, 8, -5, 0, 14, 76, -3, 34, 41, 9, -16, -20, 42, -20, 100],
  [87, 4, -2, 6, 13, 78, -5, 30, 34, 15, -8, 0, 0, 0, 100],
  [100, 0, 0, 0, 0, 80, -8, 25, 26, 9, -2, 0, 0, 0, 100],
];
/**
 * Getting off, from a foot down: weight onto the left foot as the right leaves its pedal, up and
 * back over the carrier with the body over the bars, down beside the left foot, and stand,
 * letting go as the bike settles onto its kickstand.
 */
const DISMOUNT = [
  [0, 0, 0, 0, 0, 80, -8, 25, 26, 9, -2, 0, 0, 0, 100],
  [24, 8, -2, 8, 14, 78, -3, 34, 26, 9, -2, -22, 70, -45, 100],
  [44, 18, -6, 2, 16, 73, -3, 42, 26, 9, -2, 0, 100, -58, 100],
  [62, 22, -8, 0, 15, 72, -2, 36, 26, 9, -2, 27, 60, -42, 100],
  [76, 22, -14, 0, 14, 74, 2, 28, 26, 9, -2, 17, 9, -34, 100],
  [100, 22, -17, 0, 0, 77, 0, 5, 26, 9, -2, 17, 9, -34, 0],
];
// The tracks are written in hundredths, for short rows.
for (const key of [...MOUNT, ...DISMOUNT]) key.forEach((v, k) => (key[k] = v / 100));
/** Getting on and off take about this long (s): a little longer with a leg to lift over. */
export const MOUNT_TIME = 1.15;
export const DISMOUNT_TIME = 1;
/** Of the way through getting off, the bike settles onto its kickstand, and the leg is over. */
export const KICK_AT = 0.8;
export const OVER_AT = 0.62;

const row: number[] = MOUNT[0]!.map(() => 0);
const pedalled = [0, 0];

/**
 * Fills in a script's end with a foot down on this bike: the figure in the middle leaning as the
 * bike does, the right ankle on its pedal (the left is on the ground out at FOOT_X).
 */
function fill(key: number[], s: RideState): void {
  key[3] = key[4] = s.lean;
  onPedal(s.crank, -1, ankle);
  tip(-HIP_X, ankle.y, s.lean, pedalled);
  key[11] = pedalled[0]!;
  key[12] = pedalled[1]!;
  key[13] = ankle.z;
}

/**
 * Eases through keyed tracks to time `u`, into `row`: a cubic through each pair of keys, its
 * slopes the harmonic mean of the two either side (zero at a peak, a flat or an end), so the
 * motion carries on through a key without stopping there or overshooting it.
 */
function track(keys: number[][], u: number): number[] {
  let i = 1;
  while (i < keys.length - 1 && keys[i]![0]! < u) i++;
  const a = keys[i - 1]!;
  const b = keys[i]!;
  const h = b[0]! - a[0]!;
  const t = clamp((u - a[0]!) / h, 0, 1);
  const slope = (j: number, k: number) => {
    const p = keys[j - 1];
    const c = keys[j]!;
    const n = keys[j + 1];
    if (!p || !n) return 0;
    const d0 = (c[k]! - p[k]!) / (c[0]! - p[0]!);
    const d1 = (n[k]! - c[k]!) / (n[0]! - c[0]!);
    return d0 * d1 > 0 ? (2 * d0 * d1) / (d0 + d1) : 0;
  };
  const t2 = t * t;
  const t3 = t2 * t;
  for (let k = 1; k < row.length; k++) {
    row[k] =
      (2 * t3 - 3 * t2 + 1) * a[k]! +
      (t3 - 2 * t2 + t) * h * slope(i - 1, k) +
      (3 * t2 - 2 * t3) * b[k]! +
      (t3 - t2) * h * slope(i, k);
  }
  return row;
}

/** Where a script at `u` has the figure stand and lean, and the bike, written into `place`. */
function placed(keys: number[][], u: number, place: Place): number[] {
  const [, x, z, tilt, bike, , , , , , , , , , grip] = track(keys, u);
  Object.assign(place, { x, z, tilt, bike, grip });
  return row;
}

/** The figure on a script's tracks at `u`, written into `out`, and where it stands into `place`. */
function scripted(out: Pose, keys: number[][], u: number, s: RideState, place: Place): Pose {
  const [, x, z, tilt, bike, hips, hipsZ, lean, lx, ly, lz, rx, ry, rz, grip] = placed(
    keys,
    u,
    place,
  );
  out.hips = hips!;
  out.hipsZ = hipsZ!;
  out.lean = lean!;
  out.roll = out.twist = 0;
  // Sitting up against the lean, as riding does.
  out.bank = UPRIGHT * tilt!;
  for (const [side, fx, fy, fz] of [
    [1, lx, ly, lz],
    [-1, rx, ry, rz],
  ] as const) {
    // From the bike's upright frame into the figure's: less where it stands, its lean undone.
    tip(fx! - x!, Math.max(ANKLE, fy!), -tilt!, tipped);
    leg(out, side, tipped[0]!, tipped[1]!, fz! - z!, Math.min(0.5, (fy! - ANKLE) * 2));
  }
  out.armL = out.armR = 0;
  out.elbowL = out.elbowR = REST_ELBOW;
  out.spreadL = out.spreadR = REST_SPREAD;
  hold(out, -x!, -z!, 0, bike!, tilt!, s.steer, grip!);
  out.nod = -0.85 * lean!;
  out.look = clamp(s.look, -1.1, 1.1);
  return out;
}

/** A pose key the walker leaves out, at rest. */
const rest = (key: string) => (key.startsWith('spread') ? REST_SPREAD : 0);

/** `from` blended into `to`, `t` of the way (0 to 1, as it is: ease it first), into `out`. */
export function blendPose(out: Pose, from: Pose, to: Pose, t: number): Pose {
  for (const key in to) {
    const k = key as keyof Pose;
    out[k] = lerp(from[k] ?? rest(key), to[k] ?? rest(key), t);
  }
  return out;
}

const pose = {} as Pose;

/**
 * Where getting on (`on`) or off at `u` (0 to 1 of `MOUNT_TIME` or `DISMOUNT_TIME`) has the
 * figure stand and lean, and the bike, written into `place`: on, from a bike leaning `lean` (on
 * its kickstand) to a foot down on it (`s`); off, from a foot down to the bike on its kickstand,
 * leaning `lean`. Returns the script's tracks.
 */
export function swingPlace(on: boolean, u: number, s: RideState, lean: number, place: Place) {
  const keys = on ? MOUNT : DISMOUNT;
  const first = keys[0]!;
  const end = keys[keys.length - 1]!;
  if (on) {
    first[4] = lean;
    fill(end, s);
    // Sitting down, the right foot is on its pedal already.
    keys[keys.length - 2]!.splice(11, 3, end[11]!, end[12]!, end[13]!);
  } else {
    fill(first, s);
    end[4] = lean;
  }
  placed(keys, u, place);
  return keys;
}

/**
 * Getting on or off (see `swingPlace`), from the pose `from`, written into `out`. The pose before
 * eases into the script over its first fifth; getting on, the script eases into the riding pose
 * over its last.
 */
export function swingAt(
  out: Pose,
  on: boolean,
  u: number,
  s: RideState,
  from: Pose,
  lean: number,
  place: Place,
): Pose {
  scripted(out, swingPlace(on, u, s, lean, place), u, s, place);
  blendPose(out, from, out, smooth(u * 5));
  return on ? blendPose(out, out, rideAt(pose, s), smooth((u - 0.82) / 0.18)) : out;
}

/** Where a grip is: side 1 the left, in the bike's frame (x, y, z). */
export function gripAt(steer: number, side: 1 | -1): [number, number, number] {
  const [gx, gz] = [side * GRIPS.x, GRIPS.z - STEERING];
  const [c, s] = [Math.cos(steer), Math.sin(steer)];
  return [gx * c + gz * s, GRIPS.y, -gx * s + gz * c + STEERING];
}

/** Where a pedal is, for the tests and the rig: side 1 the left (z, y). */
export const pedalAt = (crank: number, side: 1 | -1) => pedal(crank, side, { z: 0, y: 0 });
