import { Bone, BufferAttribute, Skeleton, SkinnedMesh, Uint16BufferAttribute } from 'three';
import type { BufferGeometry, Material } from 'three';

import {
  ANKLE,
  ARM_SPREAD,
  BALL,
  BONES,
  CHARACTER_SCALE,
  HIP_X,
  JOINTS,
  OUTLINE_WIDTH,
  REST_HIPS,
  addSolid,
  details,
  figure,
  grown,
} from './figure.ts';
import type { BoneName, Outfit } from './figure.ts';
import { FOREARM, SHIN, THIGH, UPPER_ARM, limbIK } from './limb.ts';
import type { Limb } from './limb.ts';
import { MeshBuilder } from './mesh-builder.ts';
import type { V3 } from './mesh-builder.ts';
import { OUTLINE, WALKER } from './palette.ts';
import { IDLE_SECONDS, STRIDE_RUN, STRIDE_WALK, WALK_SPEED, runBlend } from './walker.ts';

/**
 * The walker: the figure of figure.ts bound to its skeleton and posed (walking, running,
 * standing, landing), readable from the chase camera. Its ink outline is an inverted hull in
 * the same geometry (each part again, a little larger and facing inward, so only its far side
 * shows round the silhouette), which keeps the whole figure, shadow included, to one draw call.
 */

export { FOREARM, SHIN, THIGH, UPPER_ARM, limbIK };
export type { Limb };
export {
  ARM_SPREAD,
  BONES,
  CHARACTER_SCALE,
  OUTLINE_WIDTH,
  SOLE_COLOR,
  details,
  figure,
  grown,
} from './figure.ts';
export type { BoneName, Outfit } from './figure.ts';

/** A flat octagon under the feet, in model metres: the blob shadow. */
function addBlob(mesh: MeshBuilder, radius = 0.42): void {
  const at = (i: number): V3 => [
    Math.cos((i * Math.PI) / 4) * radius,
    0.02,
    Math.sin((i * Math.PI) / 4) * radius * 0.8,
  ];
  for (let i = 1; i < 7; i++) mesh.triangle(at(0), at(i), at(i + 1), OUTLINE, [0, 1, 0], -1);
}

/**
 * The figure's geometry with one bone per vertex: its parts, their outline hulls, and the
 * blob shadow on the root. The builder's spare `facade` value carries each vertex's bone, -1
 * for the shadow, which a `dither` attribute marks for the material to draw as a checkerboard
 * of pixels: see-through without blending, so it costs no extra draw call.
 */
export function characterGeometry(outfit: Outfit = WALKER): BufferGeometry {
  const mesh = new MeshBuilder();
  for (const solid of figure(outfit)) {
    addSolid(mesh, solid, solid.rings, false);
    if (solid.hull !== false) {
      addSolid(mesh, solid, grown(solid.hull ?? solid.rings, OUTLINE_WIDTH), true);
    }
  }
  for (const { bone, color, points, normal } of details(outfit)) {
    const [a, b, c, d] = points as [V3, V3, V3, V3?];
    if (d) mesh.quad(a, b, c, d, color, normal, BONES.indexOf(bone));
    else mesh.triangle(a, b, c, color, normal, BONES.indexOf(bone));
  }
  addBlob(mesh);
  // The figure keeps its arrays once on the GPU, unlike the city: a skinned mesh reads them for
  // its bounds, and a lost context needs them again.
  const geometry = mesh.build({ facade: true, keep: true });
  const bones = geometry.getAttribute('facade');
  const n = bones.count;
  const skinIndex = new Uint16Array(n * 4);
  const skinWeight = new Float32Array(n * 4);
  const dither = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const bone = bones.getX(i);
    skinIndex[i * 4] = Math.max(0, bone);
    skinWeight[i * 4] = 1;
    dither[i] = bone < 0 ? 1 : 0;
  }
  geometry.deleteAttribute('facade');
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(skinIndex, 4));
  geometry.setAttribute('skinWeight', new BufferAttribute(skinWeight, 4));
  geometry.setAttribute('dither', new BufferAttribute(dither, 1));
  return geometry;
}

export interface Character {
  mesh: SkinnedMesh;
  /** The same figure drawn only where the city hides it, as a see-through silhouette. */
  xray: SkinnedMesh;
  bones: Record<BoneName, Bone>;
}

/**
 * The figure, bound to its skeleton, and its x-ray twin sharing that skeleton. The twin draws
 * after the city but before the figure, wherever something stands in front: two draw calls.
 */
export function createCharacter(
  body: Material,
  xray: Material,
  outfit: Outfit = WALKER,
): Character {
  const bones = Object.fromEntries(BONES.map((name) => [name, new Bone()])) as Record<
    BoneName,
    Bone
  >;
  for (const name of BONES) {
    const [parent, x, y, z] = JOINTS[name];
    bones[name].name = name;
    // Undoing the body's roll before their own swing keeps the legs plumb (see applyPose).
    if (name === 'legL' || name === 'legR') bones[name].rotation.order = 'ZYX';
    bones[name].position.set(x, y, z);
    if (parent) bones[parent].add(bones[name]);
  }
  const geometry = characterGeometry(outfit);
  const mesh = new SkinnedMesh(geometry, body);
  mesh.add(bones.root);
  mesh.bind(new Skeleton(BONES.map((name) => bones[name])));
  const twin = new SkinnedMesh(geometry, xray);
  mesh.add(twin);
  twin.bind(mesh.skeleton, mesh.bindMatrix);
  twin.renderOrder = 1;
  mesh.renderOrder = 2;
  // It moves every frame and is always on screen while walking: skip the bounds checks.
  mesh.traverse((object) => (object.frustumCulled = false));
  // It darkens in the static shade of the houses it passes, though it casts none itself.
  mesh.receiveShadow = true;
  return { mesh, xray: twin, bones };
}

export interface Pose {
  /** Hip height above the ground, and how far forward of the root they sit (model metres). */
  hips: number;
  hipsZ: number;
  /**
   * Roll of the body about its forward axis (radians, positive lifts the left hip). The legs
   * hang plumb whatever the roll, so feet stay put on pedals or the ground.
   */
  roll: number;
  /** Forward lean of the torso, its twist with each stride, and its bank into a turn (radians). */
  lean: number;
  twist: number;
  bank: number;
  /** Swing of each thigh (negative is forward) and bend of each knee (positive folds the shin back). */
  legL: number;
  legR: number;
  kneeL: number;
  kneeR: number;
  /** Each foot's turn at the ankle (positive points the toes down). */
  footL: number;
  footR: number;
  /** Swing of each arm (positive is back), and the bend of each elbow (negative folds forward). */
  armL: number;
  armR: number;
  elbowL: number;
  elbowR: number;
  /**
   * How far out from the body each arm swings (radians), if not the resting `ARM_SPREAD`: a
   * rider's hands follow the bars as they turn.
   */
  spreadL?: number;
  spreadR?: number;
  /** How far out from the hip each thigh swings (radians), if not straight down: a rider's foot. */
  splayL?: number;
  splayR?: number;
  /** Head nod and turn. */
  nod: number;
  look: number;
}

/** Elbows hang a little bent, as arms do. */
const REST_ELBOW = -0.12;
/** The furthest the head turns toward where the camera looks (radians). */
const LOOK_LIMIT = 1.1;
/** The longest a leg stretches, hip to ankle: never quite straight, so the knee never snaps. */
const REACH = THIGH + SHIN - 0.004;
/**
 * How the gait changes from a walk (first) to a run (second), in model metres and radians: the
 * share of a cycle each foot is down (under a half is a run, with both feet off the ground in
 * between), how high a foot lifts, the hips' height and their bounce, where under the hips the
 * steps centre, how far the heel lifts before the toes push off, and the lean.
 */
const DUTY = [0.52, 0.2] as const;
const LIFT = [0.09, 0.3] as const;
const HIPS = [0.73, 0.62] as const;
const CENTRE = [0.07, 0] as const;
const TOES = [0.45, 0.45] as const;
/** How much of its swing a foot takes to let go of the hips: slowly walking, at once running. */
const RELEASE = [0.5, 0.1] as const;
const LEAN = [0.07, 0.24] as const;
/** How far the arms swing either way, and the shoulders twist with them, walking and running. */
const ARMS = [0.55, 0.8] as const;
const TWIST = [0.2, 0.12] as const;
/** The hips turn against the shoulders by this share of the torso's twist (see applyPose). */
const PELVIS = 0.5;
/** A walk's hips dip on the side of the foot in the air (radians of roll). */
const SWAY = 0.05;
/** The most the legs' reach pulls the hips below where they ride (model metres). */
const DIP = 0.12;
/** Below this speed (m/s) steps shorten toward standing still. */
const STEPPING = 1.5;
/** Turning on the spot: a full cycle of two steps for each quarter turn. */
const TURN_STEPS = 4;
/** Starting and stopping: the acceleration (m/s²) that leans the body most of its furthest. */
const SURGE = 20;
const SURGE_LEAN = 0.2;
const SURGE_HIPS = 0.06;

const lerp = (pair: readonly [number, number], t: number) => pair[0] + (pair[1] - pair[0]) * t;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smoothstep = (x: number) => clamp01(x) ** 2 * (3 - 2 * clamp01(x));
/** A minimum that rounds the corner where `a` and `b` cross, within `k` of each other. */
const softMin = (a: number, b: number, k: number) => {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - (h * h * k) / 4;
};
/** Up from 0 to 1 and back between `from` and `to`, easing in and out at both ends. */
const bump = (t: number, from: number, to: number) =>
  Math.sin(Math.PI * clamp01((t - from) / (to - from))) ** 2;
/** The fraction of the way through a cycle of length `n`, from `start`. */
const cycle = (p: number, start: number, n = 1) => (((p - start) % n) + n) % n;

/** The gait at this speed: a walk's and a run's, blended (see DUTY and below). */
const gait = { sweep: 0, duty: 0, centre: 0, lift: 0, toes: 0, release: 0 };

/** Where a foot is: its ankle forward of the root and above the ground, and its pitch. */
interface Foot {
  z: number;
  y: number;
  pitch: number;
  /** How far it lets go of the hips (0 to 1): not at all while down, wholly mid-swing. */
  free: number;
}

/**
 * How high the ankle is above the ground with the foot on the ball of its foot, pitched toes down
 * (or flat): as high as it must be for no part of the sole to dip below the ground, since the
 * toe springs up from the ball further than the toes ever point down.
 */
const clearance = (pitch: number) => BALL * Math.sin(pitch) + ANKLE * Math.cos(pitch);

/**
 * A foot through one gait cycle, `q` from 0 to 1 starting as it lands. While down it slides back
 * under the body exactly as fast as the body moves on, so it stays where it landed: flat, then
 * rolling up onto the ball of the foot. Then it lifts and swings forward to land again, leaving
 * and arriving at the speed it had on the ground, so it neither scuffs off nor skids in.
 */
function footAt(out: Foot, q: number): Foot {
  const { sweep, duty, centre, lift, toes } = gait;
  // Down, the ball of the foot slides back, and the heel lifts as it rolls over it.
  const u = Math.min(1, q / duty);
  const pitch = toes * smoothstep((u - 0.55) / 0.45);
  out.z = centre + sweep * (0.5 - u) - BALL * Math.cos(pitch) + ANKLE * Math.sin(pitch);
  out.y = clearance(pitch);
  out.pitch = pitch;
  out.free = 0;
  if (q < duty) return out;
  // Up, it swings from where it left the ground to where it lands next.
  const s = (q - duty) / (1 - duty);
  const [z0, y0] = [out.z, out.y];
  const z1 = centre + sweep / 2 - BALL;
  // A Hermite curve from lift-off to landing, leaving and arriving at most of the speed the foot
  // had on the ground: all of it would swing it far back first, out of reach.
  const m = (-0.6 * sweep * (1 - duty)) / duty;
  const s2 = s * s;
  const s3 = s2 * s;
  out.z = z0 + (z1 - z0) * (3 * s2 - 2 * s3) + m * (s - 3 * s2 + 2 * s3);
  out.pitch = toes * (1 - s) ** 2;
  // Highest early in the swing, the heel kicking up behind.
  const y = y0 + (ANKLE - y0) * s + lift * Math.sin(Math.PI * s ** 0.65);
  out.y = Math.max(y, clearance(out.pitch));
  // It lets go of the hips gradually after lifting off, and takes hold again before landing, so
  // the hips rise and sink rather than jump as feet come and go.
  out.free = smoothstep(s / gait.release) * smoothstep((1 - s) / 0.6);
  return out;
}

const footL: Foot = { z: 0, y: 0, pitch: 0, free: 0 };
const footR: Foot = { z: 0, y: 0, pitch: 0, free: 0 };
const limb: Limb = { root: 0, joint: 0 };

/**
 * The highest the hips can be with the ankle at `foot` still in reach. A foot well off the ground
 * doesn't hold them down: out of reach, it just stops short, higher up.
 */
function reachAbove(foot: Foot, hipZ: number): number {
  const off = 0.5 * foot.free ** 2;
  return foot.y + Math.sqrt(Math.max(0, REACH * REACH - (foot.z - hipZ) ** 2)) + off;
}

/** Seconds the idle plays (walker.ts); its breaths, its glance about and its weight shift. */
const BREATH = IDLE_SECONDS / 3;
const GLANCE = [1, 2.8] as const;
const SHIFT = [2.4, 6.2] as const;
/** How far the hips drop onto one leg as the weight shifts (radians of roll). */
const SHIFT_ROLL = 0.11;

/**
 * How far the knees give on landing (1 at the deepest), `settle` of the way from the feet
 * touching down (0) to standing settled (1): a quick dip and a small rebound, gone by the end.
 */
export function landing(settle: number): number {
  const s = clamp01(settle);
  return 1.8 * (1 - s) ** 3 * Math.sin(2.5 * Math.PI * s);
}

/**
 * The pose for a moment of walking, running or standing, written into `out` (no allocation per
 * frame). Feet first: each foot goes where the gait cycle puts it (`phase`, which the walker turns
 * at its stride's pace), and the legs reach for them by IK, so a foot on the ground stays where it
 * landed. The hips ride as high as both legs allow, which bobs a walk, and dip on the side of the
 * foot in the air; a run sinks onto each step and springs off it into a moment with both feet in
 * the air. Arms swing against the legs, the forward one bending at the elbow, and the shoulders
 * twist with them while the hips turn the other way. Speeding up (`accel`, m/s²) leans the body
 * in and carries the hips ahead of the feet; slowing down leans it back, and stopped it rocks
 * forward and back once, the head nodding after it. Standing, it steps on the spot as it turns
 * (`turning`, rad/s, the steps keeping time with its `heading`), its head leading the way. The
 * torso banks into turns and the head turns toward `look` (radians from straight ahead).
 * Stopped, for IDLE_SECONDS it breathes, glances about and shifts its weight onto one leg and
 * back, and then stands still. With `idle` false (reduced motion) none of that, only the steps.
 *
 * `settle` lands the figure, as when it is set down into walk mode: from 0, the moment its feet
 * touch the ground, to 1 (the default), settled. The knees give and the arms come forward, then
 * it straightens with a small rebound (`landing`). The feet stay planted throughout.
 */
export function poseAt(
  out: Pose,
  speed: number,
  phase: number,
  still: number,
  idle: boolean,
  turning = 0,
  look = 0,
  accel = 0,
  heading = 0,
  settle = 1,
): Pose {
  const run = runBlend(speed);
  const step = smoothstep(speed / STEPPING);
  const duty = lerp(DUTY, run);
  const stride = (STRIDE_WALK + (STRIDE_RUN - STRIDE_WALK) * run) / CHARACTER_SCALE;
  gait.duty = duty;
  gait.sweep = duty * stride;
  gait.centre = lerp(CENTRE, run);
  gait.lift = lerp(LIFT, run);
  gait.toes = lerp(TOES, run);
  gait.release = lerp(RELEASE, run);
  const p = phase / (Math.PI * 2);
  // The left foot lands a quarter of the way through the cycle, the right at three quarters, as
  // the footsteps sound.
  footAt(footL, cycle(p, 0.25));
  footAt(footR, cycle(p, 0.75));
  // Standing, the feet come together under the hips, lifting in turn if it turns on the spot.
  const turn = idle ? (1 - step) * clamp01(Math.abs(turning) / 2.5) : 0;
  const pivot = heading * TURN_STEPS;
  for (const [foot, side] of [
    [footL, 0],
    [footR, Math.PI],
  ] as const) {
    foot.z *= step;
    foot.y = ANKLE + (foot.y - ANKLE) * step + 0.07 * turn * Math.max(0, Math.sin(pivot + side));
    foot.pitch *= step;
    foot.free *= step;
  }

  // Standing still: breathing, a glance and a weight shift, faded in and out over the idle, and
  // not while turning on the spot. Which way it glances and leans goes by where it faces.
  const idling = idle && speed === 0 && still < IDLE_SECONDS;
  const fade = idling
    ? smoothstep(still / 0.6) * smoothstep((IDLE_SECONDS - still) / 1.2) * (1 - turn)
    : 0;
  const breath = idling ? fade * (0.5 - 0.5 * Math.cos((2 * Math.PI * still) / BREATH)) : 0;
  const side = Math.cos(heading * 3) < 0 ? -1 : 1;
  const shift = idling ? side * bump(still, ...SHIFT) * (1 - turn) : 0;
  // Stopping (or set down), the body rocks on forward and back once, then is still.
  const rock = idling ? Math.exp(-6 * still) * Math.sin(11 * still) : 0;
  const land = landing(settle);

  // Eased by the walker (its `surge`), so it carries on a moment after stopping.
  const surge = idle ? Math.tanh(accel / SURGE) : 0;
  out.hipsZ = SURGE_HIPS * surge;
  // A walk's hips dip on the side of the swinging foot; standing, they drop onto one leg.
  out.roll = -SWAY * step * (1 - run) * Math.cos(phase) + SHIFT_ROLL * shift;
  const swing = Math.sin(phase);
  out.twist = lerp(TWIST, run) * step * swing;
  // The hips turn against the shoulders (see applyPose), which moves each hip joint a little.
  const pelvis = -PELVIS * out.twist;
  // A run sinks onto each step and springs off it, highest midway between steps; a walk's bob
  // comes from the legs' reach alone.
  const q = cycle(p, 0.25, 0.5);
  const bounce = 0.035 * run;
  const flight = 0.5 - duty;
  let hips = lerp(HIPS, run);
  if (q < duty) hips -= bounce * Math.sin((Math.PI * q) / duty);
  else if (flight > 0)
    hips += ((bounce * flight) / duty) * Math.sin((Math.PI * (q - duty)) / flight);
  hips = REST_HIPS + (hips - REST_HIPS) * step - 0.14 * land;
  const hipY = HIP_X * Math.sin(out.roll);
  const hipZ = HIP_X * Math.cos(out.roll) * Math.sin(pelvis);
  // Never more than DIP below where they ride: speeding up, the stride lengthens faster than a
  // swinging foot comes down, and reaching all the way for it would drop the hips in a step.
  const floor = hips - DIP;
  hips = softMin(hips, Math.max(floor, reachAbove(footL, out.hipsZ - hipZ) - hipY), 0.04);
  out.hips = softMin(hips, Math.max(floor, reachAbove(footR, out.hipsZ + hipZ) + hipY), 0.04);
  for (const [foot, x] of [
    [footL, 1],
    [footR, -1],
  ] as const) {
    limbIK(limb, foot.z - out.hipsZ + x * hipZ, foot.y - out.hips - x * hipY, THIGH, SHIN, 1);
    const ankle = foot.pitch - limb.root - limb.joint;
    if (x > 0) [out.legL, out.kneeL, out.footL] = [limb.root, limb.joint, ankle];
    else [out.legR, out.kneeR, out.footR] = [limb.root, limb.joint, ankle];
  }

  const arms = lerp(ARMS, run) * step * swing;
  // A run pumps the arms mostly behind the body; landing, they come forward for balance.
  out.armL = 0.3 * run + arms - 0.3 * land;
  out.armR = 0.3 * run - arms - 0.3 * land;
  // A run holds the elbows bent; walking, the arm swinging forward bends a little more.
  const elbow = REST_ELBOW - 0.2 * step - 1.05 * run - 0.06 * breath - 0.5 * land;
  const reach = 0.35 * step * (1 - run);
  out.elbowL = elbow - reach * Math.max(0, -swing);
  out.elbowR = elbow - reach * Math.max(0, swing);
  // Breathing in lifts the chest a little; landing folds the body over the knees.
  out.lean =
    lerp(LEAN, run) * step + SURGE_LEAN * surge - 0.025 * breath + 0.05 * rock + 0.3 * land;
  // The shoulders level against the hips' roll, standing or walking, and bank into turns.
  out.bank = Math.max(-0.3, Math.min(0.3, (-0.12 * turning * speed) / WALK_SPEED)) - 1.3 * out.roll;
  // The head stays level as the body leans and nods after it as it rocks to a stop.
  out.nod = -0.6 * out.lean + 0.02 * breath + 0.12 * rock - 0.15 * land;
  // It leads a turn on the spot, and glances aside a moment while standing.
  const lead = idle ? (1 - step) * Math.max(-0.4, Math.min(0.4, 0.15 * turning)) : 0;
  const glance = idling ? 0.55 * side * bump(still, ...GLANCE) * (1 - turn) : 0;
  out.look = Math.max(-LOOK_LIMIT, Math.min(LOOK_LIMIT, look + lead + glance));
  return out;
}

/** The figure standing at rest, as `poseAt` stands it. */
export function restPose(): Pose {
  const pose = {} as Pose;
  return poseAt(pose, 0, 0, Infinity, false);
}

/**
 * Puts the figure in a pose. The hips turn against the torso's twist by PELVIS of it, so the
 * shoulders turn by `twist` and the hips the other way, as a walk counter-rotates them; a pose
 * without twist (the rider's) keeps the hips square.
 */
export function applyPose({ bones }: Character, pose: Pose): void {
  const pelvis = -PELVIS * pose.twist;
  bones.hips.position.set(0, pose.hips, pose.hipsZ);
  bones.hips.rotation.set(0, pelvis, pose.roll);
  bones.torso.rotation.set(pose.lean, pose.twist - pelvis, pose.bank);
  bones.head.rotation.set(pose.nod, pose.look - pose.twist, 0);
  // The legs undo the hips' roll and turn first (they turn Z, then Y, then X), so they swing in
  // the root's plane.
  bones.legL.rotation.set(pose.legL, -pelvis, (pose.splayL ?? 0) - pose.roll);
  bones.legR.rotation.set(pose.legR, -pelvis, -(pose.splayR ?? 0) - pose.roll);
  bones.shinL.rotation.x = pose.kneeL;
  bones.shinR.rotation.x = pose.kneeR;
  bones.footL.rotation.x = pose.footL;
  bones.footR.rotation.x = pose.footR;
  // The arms hang a little out from the body, so the hands clear the shirt's hem.
  bones.armL.rotation.set(pose.armL, 0, pose.spreadL ?? ARM_SPREAD);
  bones.armR.rotation.set(pose.armR, 0, -(pose.spreadR ?? ARM_SPREAD));
  bones.foreL.rotation.x = pose.elbowL;
  bones.foreR.rotation.x = pose.elbowR;
}
