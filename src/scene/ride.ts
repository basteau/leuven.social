import type * as Three from 'three';
import type {
  Bone,
  BufferGeometry,
  Material,
  Mesh,
  PerspectiveCamera,
  Skeleton,
  SkinnedMesh,
} from 'three';

import { createRideSounds } from '../audio/riding.ts';
import type { WalkGrid } from '../data/walkable.ts';
import { BIKE_BONES, BIKE_JOINTS, BIKE_MOST, bakeBike, bikeArrays } from './bike-rig.ts';
import type { BikeArrays, Stand } from './bike-rig.ts';
import type { Character, Pose, poseAt } from './character.ts';
import type { Boom, Follow } from './chase.ts';
import { loose, overlap } from './collide.ts';
import { decay, decayAngle } from './motion.ts';
import { DROPPED_KEY, PARKED, nearestParked, parkedHeading } from './parked.ts';
import type { Furniture } from './parked.ts';
import {
  CRUISE,
  FOOT_LEAN,
  SPRINT,
  WHEEL,
  WHEELBASE,
  createInput,
  createRider,
  routeInput,
  stepRider,
} from './rider.ts';
import type { Rider } from './rider.ts';
import {
  DISMOUNT_TIME,
  KICK_AT,
  MOUNT_TIME,
  OVER_AT,
  ROCK,
  SHOWN_STEER,
  STANCE,
  blendPose,
  hold,
  rideAt,
  smooth,
  swingAt,
  swingPlace,
} from './rider-pose.ts';
import type { Place, RideState as PoseState } from './rider-pose.ts';
import type { WalkHost } from './walk.ts';
import { STEP, STRIDE_WALK, followRoute, stepWalker } from './walker.ts';
import type { Walker } from './walker.ts';

/**
 * Riding, wired into walk mode: its own chunk, loaded near a rack (or on F). Take the nearest
 * parked bike (F, or the Ride pill), ride it with the keys like a vehicle, a thumb on the stick
 * like walking, or a click on a street, then get off anywhere and leave it standing there on its
 * kickstand. The bike, its rider and their camera are pure modules (rider.ts, rider-pose.ts,
 * bike-rig.ts, chase.ts); this is the browser glue.
 *
 * Taking a bike from a rack draws its rack copy as nothing (its triangles zeroed in the cell's
 * furniture, only that range uploaded, the rest of the buffer untouched), so riding costs no draw
 * call there; the bike ridden is one more mesh, with its x-ray twin. Bikes left about the city
 * are remembered for the visit, at most six: the newest keeps its rig, the others share one
 * baked mesh, and when a seventh is left the oldest goes back to its rack while nobody sees.
 */

export type RideState = '' | 'near' | 'riding';
export type RideAction = 'toggle' | 'bell';

/** What riding needs from walk mode and the viewer, handed over when it loads. */
export interface RideKit {
  three: Pick<
    typeof Three,
    'Bone' | 'BufferAttribute' | 'BufferGeometry' | 'Mesh' | 'Skeleton' | 'SkinnedMesh'
  >;
  host: WalkHost;
  grid: WalkGrid;
  character: Character;
  /**
   * The walker's gait, and how far its arms hang out, for walking a bike: handed over, as three
   * is, so this chunk doesn't import the figure's module and split the engine off the first load.
   */
  poseAt: typeof poseAt;
  armSpread: number;
  body: Material;
  xray: Material;
  /** The lamps' light at night (the furniture's glow material): the bike's lamp, reflector and beam. */
  glow: Material;
  boom: Boom;
  follow: Follow;
  view: PerspectiveCamera;
  /** Where the wheels stand at a spot: the ground as drawn, and a hair for the tyres' ink. */
  floor(x: number, z: number): number;
  /** Walks to a spot along a route (or says it can't). */
  walkTo(x: number, z: number): void;
  wake(): void;
}

export interface Ride {
  /**
   * Each walking frame, before the walker steps: the input as walk mode reads it (world steer
   * from the stick, keys as right and up). Returns whether riding has the body this frame:
   * riding, getting on or getting off.
   */
  frame(
    walker: Walker,
    steerX: number,
    steerZ: number,
    right: number,
    up: number,
    stick: boolean,
    sprint: boolean,
    dt: number,
  ): boolean;
  /** One fixed step, in place of the walker's; returns whether anything still moves. */
  step(walker: Walker): boolean;
  /** The figure's pose this frame, written into `out`, and the bike placed. */
  pose(out: Pose, head: number): Pose;
  /** F or the Ride pill (get on or off), or the bell; `walker` is who's on foot. */
  act(action: RideAction, walker: Walker): void;
  /** Walk mode is ending: off the bike at once, leaving it where it stands. */
  leave(): void;
  dispose(): void;
}

/** Within this of a bike (m) the Ride pill shows; within FETCH, F walks there first. */
const NEAR = 1.6;
const FETCH = 30;
/**
 * Getting on, the rider walks to the bike's left side (`STANCE`), the last metre along the bike
 * so as to arrive facing its way. Already within this of the spot (m) and facing about its way,
 * it steps the rest in place.
 */
const LAST_LEG = 0.8;
const CLOSE = 0.35;
/** A colour as sRGB fractions, for a glow's vertices. */
const rgb = (hex: number) => [
  ((hex >> 16) & 255) / 255,
  ((hex >> 8) & 255) / 255,
  (hex & 255) / 255,
];
/** Walked there, the route may end this far from the spot (m) and still get on. */
const ARRIVED = 0.6;
/** The rider's arrival off the spot eases out over this long (s). */
const SETTLE = 0.3;
/** A rack bike is rolled back out of its rack (or on through it) at most this far (m). */
const ROLL_OUT = 2;
/** Rolling a bike out takes (s) this and this more a metre; turning it round, this a half turn. */
const ROLL_TIME = [0.25, 0.3] as const;
const TURN_TIME = 0.75;
/** A bike on its kickstand leans this far onto it, its left (radians). */
const KICKSTAND = (6 * Math.PI) / 180;
/** Getting off, the walker then steps this far out from the bike's middle (m), a little back. */
const STEP_AWAY = 1.05;
/** The walker's own pose takes over from getting off over this long (s). */
const RELEASE = 0.3;
/** With reduced motion, getting on or off is over this quickly (s), with no bike to walk round. */
const QUICK = 0.35;
/** A direction held while getting on or off hurries it this much. */
const HURRY = 2.5;
/** Getting on, the bike is turned to have this much clear street ahead (m), if it can. */
const CLEAR = 6;
/** A dropped bike is met as a circle this round (m), and a ridden one this. */
const DROPPED_RADIUS = 0.55;
const RIDDEN_RADIUS = 0.5;
/** Bikes left about the city at once, before the oldest goes back to its rack. */
const MOST_DROPPED = 6;
/** The bike's scale, the figure's. */
const SCALE = 1.3;
/** How often (s) riding looks after the racks: hidden copies, returns, tiles ahead. */
const CHORES = 0.5;
/** A hit harder than this (m/s) thuds. */
const THUD = 1.2;
/**
 * Riding, the camera: the boom 1.2× longer, the look point 0.35 s ahead with a 150 ms lag,
 * coming round at about 3 a second 0.7 s after a look by hand, 8° wider flat out. It eases from
 * the walk's settings to these as the rider gets on, and back as they get off. It doesn't roll
 * with the lean: the street stays level.
 */
const BOOM = 1.2;
const RIDE_FOLLOW = { ahead: 0.35, ease: 0.15, rate: 1.8, early: 0.3 } as const;
const SPRINT_FOV = 3;

/** A bike left standing somewhere, and the rack bike it was (to put back). */
interface Dropped extends Stand {
  /** The parked bike it was taken from, by where it stood. */
  rackX: number;
  rackZ: number;
  /** Going back to its rack once nobody can see. */
  returning?: boolean;
}

type Phase = 'walk' | 'fetch' | 'pull' | 'mount' | 'ride' | 'stop' | 'dismount' | 'release';
interface XZ {
  x: number;
  z: number;
}

const key = (x: number, z: number) => `${x.toFixed(2)} ${z.toFixed(2)}`;
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export function createRide(kit: RideKit): Ride {
  const { three, host, grid, character, boom, follow, view } = kit;
  const { scene, canvas, terrain, reducedMotion } = host;
  const sounds = createRideSounds();
  const walking = { ...follow };

  // The bike: a skinned mesh on seven bones, its x-ray twin on the same skeleton.
  const bones: Bone[] = BIKE_BONES.map(() => new three.Bone());
  for (const [i, name] of BIKE_BONES.entries()) {
    const [parent, x, y, z] = BIKE_JOINTS[name];
    bones[i]!.position.set(x, y, z);
    if (parent >= 0) bones[parent]!.add(bones[i]!);
  }
  let look = -1;
  const bike: SkinnedMesh = new three.SkinnedMesh(geometryOf(bikeArrays(0)), kit.body);
  bike.add(bones[0]!);
  bike.bind(new three.Skeleton(bones) as Skeleton);
  const twin: SkinnedMesh = new three.SkinnedMesh(bike.geometry, kit.xray);
  bike.add(twin);
  twin.bind(bike.skeleton, bike.bindMatrix);
  [twin.renderOrder, bike.renderOrder] = [1, 2];
  bike.traverse((object) => (object.frustumCulled = false));
  bike.receiveShadow = true;
  bike.rotation.order = 'YXZ';
  bike.visible = false;
  bike.add(bikeGlow(three, kit.glow));
  scene.add(bike);

  // Bikes left about the city, but the newest: one baked mesh on one bone.
  const restBone = new three.Bone();
  const parkedAll: SkinnedMesh = new three.SkinnedMesh(new three.BufferGeometry(), kit.body);
  parkedAll.add(restBone);
  parkedAll.bind(new three.Skeleton([restBone]) as Skeleton);
  parkedAll.receiveShadow = true;
  parkedAll.visible = false;
  scene.add(parkedAll);

  /**
   * What the bike gives off at night, as the street lamps do (createGlowMaterial, dithered by
   * each corner's `facade` times the night): its lamp's lens, lit, a red reflector behind, and a
   * pool of light on the street ahead, full at the lamp and fading to nothing at its end and
   * its sides. In the bike's own frame (z ahead, y up), so it rides and leans with it.
   */
  function bikeGlow(t: RideKit['three'], material: Material): Three.Mesh {
    const position: number[] = [];
    const color: number[] = [];
    const facade: number[] = [];
    const index: number[] = [];
    const quad = (corners: number[][], hex: number, glow: number[]) => {
      const first = position.length / 3;
      for (const [i, c] of corners.entries()) {
        position.push(...c);
        color.push(...rgb(hex));
        facade.push(glow[i]!);
      }
      index.push(first, first + 1, first + 2, first, first + 2, first + 3);
    };
    const lamp = 0xfff2c4;
    // The lens on the fork crown, and the reflector on the carrier's end (bike-rig.ts).
    quad(
      [
        [0.05, 0.7, 0.54],
        [-0.05, 0.7, 0.54],
        [-0.05, 0.78, 0.54],
        [0.05, 0.78, 0.54],
      ],
      lamp,
      [1, 1, 1, 1],
    );
    quad(
      [
        [-0.05, 0.42, -0.96],
        [0.05, 0.42, -0.96],
        [0.05, 0.5, -0.96],
        [-0.05, 0.5, -0.96],
      ],
      0xd23a2a,
      [0.7, 0.7, 0.7, 0.7],
    );
    // The pool: three strips, brightest down the middle, so the sides soften.
    const y = 0.03;
    const strip = (x0: number, x1: number, f0: number, f1: number, glow: number[]) =>
      quad(
        [
          [x0, y, 0.6],
          [x1, y, 0.6],
          [f1, y, 4.2],
          [f0, y, 4.2],
        ],
        lamp,
        glow,
      );
    strip(0.12, -0.12, 0.4, -0.4, [1, 1, 0.08, 0.08]);
    strip(0.3, 0.12, 0.9, 0.4, [0.3, 1, 0.08, 0.02]);
    strip(-0.12, -0.3, -0.4, -0.9, [1, 0.3, 0.02, 0.08]);
    const g = new t.BufferGeometry();
    g.setAttribute('position', new t.BufferAttribute(Float32Array.from(position), 3));
    g.setAttribute('color', new t.BufferAttribute(Float32Array.from(color), 3));
    g.setAttribute('facade', new t.BufferAttribute(Float32Array.from(facade), 1));
    g.setIndex(index);
    const mesh = new t.Mesh(g, material);
    mesh.renderOrder = 3;
    mesh.frustumCulled = false;
    return mesh;
  }

  function geometryOf(a: BikeArrays): BufferGeometry {
    const g = new three.BufferGeometry();
    const n = a.bone.length;
    const skinIndex = new Uint16Array(n * 4);
    const skinWeight = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) [skinIndex[i * 4], skinWeight[i * 4]] = [a.bone[i]!, 1];
    g.setAttribute('position', new three.BufferAttribute(a.position, 3));
    g.setAttribute('normal', new three.BufferAttribute(a.normal, 3));
    g.setAttribute('color', new three.BufferAttribute(a.color, 3));
    g.setAttribute('skinIndex', new three.BufferAttribute(skinIndex, 4));
    g.setAttribute('skinWeight', new three.BufferAttribute(skinWeight, 4));
    g.setAttribute('dither', new three.BufferAttribute(a.dither, 1));
    g.setIndex(new three.BufferAttribute(a.index, 1));
    return g;
  }
  function dress(next: number): void {
    if (next === look) return;
    look = next;
    const old = bike.geometry;
    bike.geometry = twin.geometry = geometryOf(bikeArrays(next));
    old.dispose();
  }

  // The rack copies of bikes taken: zeroed in their furniture, with what was there kept.
  const hidden = new Map<
    string,
    { mesh: Furniture & Mesh; from: number; kept: ArrayLike<number> }
  >();
  const furnitureOf = (x: number, z: number) =>
    nearestParked(scene.children, x, z, 0.05, () => false);
  function upload(mesh: Mesh, from: number, to: number): void {
    const index = mesh.geometry.index!;
    index.clearUpdateRanges();
    index.addUpdateRange(from, to - from);
    index.needsUpdate = true;
    // Its shadow went with it, or comes back.
    host.renderer.shadowMap.needsUpdate = true;
  }
  /** Draws a rack bike as nothing; again if its furniture was built anew since. */
  function hide(x: number, z: number): void {
    const found = furnitureOf(x, z);
    const k = key(x, z);
    const mesh = found?.mesh as (Furniture & Mesh) | undefined;
    if (!found || !mesh || hidden.get(k)?.mesh === mesh) return;
    const array = mesh.geometry.index?.array as Uint16Array | Uint32Array | null | undefined;
    // The viewer keeps the index of furniture that has bikes; without it, leave the rack be.
    if (!array) return;
    const bikes = mesh.userData.bikes!;
    const [from, to] = [bikes[found.at + PARKED.from]!, bikes[found.at + PARKED.to]!];
    hidden.set(k, { mesh, from, kept: array.slice(from, to) });
    array.fill(0, from, to);
    upload(mesh, from, to);
  }
  function unhide(x: number, z: number): void {
    const k = key(x, z);
    const was = hidden.get(k);
    hidden.delete(k);
    const array = was?.mesh.geometry.index?.array as Uint16Array | Uint32Array | null | undefined;
    if (!was || !array) return;
    array.set(was.kept, was.from);
    upload(was.mesh, was.from, was.from + was.kept.length);
  }
  const taken = (bikes: Float32Array, at: number) =>
    hidden.has(key(bikes[at + PARKED.x]!, bikes[at + PARKED.z]!));

  // What's being ridden.
  let phase: Phase = 'walk';
  let rider: Rider = createRider(0, 0, 0);
  let current: Dropped | undefined;
  /** Seconds into taking a bike, getting on or off, or letting go of it. */
  let t = 0;
  /** Seconds since the bike was taken, which the rider's arrival off the spot eases out over. */
  let since = 0;
  let posed = false;
  /** The pose a scripted moment starts from, and where the figure stands in it. */
  const before = {} as Pose;
  const where: Place = { x: 0, z: 0, tilt: 0, bike: 0, grip: 0 };
  const input = createInput();
  const poseState: PoseState = { crank: 0, steer: 0, stand: 0, foot: 0, look: 0, lean: 0 };
  /** The bike while it stands on its own: taken, got on or off, its bars, wheels and crank. */
  const stood = { x: 0, z: 0, heading: 0, lean: 0, steer: 0, wheel: 0, crank: Math.PI / 2 };
  /**
   * Taking a bike: where it stood and leant, how far it rolls out of a rack (along its way,
   * negative back), the turn to the open street, and the bike nearest the spot, to take on arrival.
   */
  const plan = { x: 0, z: 0, heading: 0, lean: 0, out: 0, turn: 0, rolling: 0, turning: 0 };
  let target: ReturnType<typeof nearest> = null;
  /** Where the rider walks to get on, and how far off it (and its way) they were. */
  const spot = { x: 0, z: 0 };
  const miss = { x: 0, z: 0, heading: 0 };
  /** The input held while getting on or off: a direction hurries it, or walks off. */
  const held = { x: 0, z: 0, run: false, any: false };
  let walker0: Walker | undefined;
  /** How far the camera is into riding's settings (0 to 1), and the boom's share of that. */
  let riding = 0;
  let boomed = 1;
  /** Getting off, whether the kickstand has gone down. */
  let kicked = false;

  // Bikes left about the city, oldest first.
  let dropped: Dropped[] = [];
  function remember(): void {
    loose.length = 0;
    for (const d of dropped) loose.push(d.x, d.z, DROPPED_RADIUS);
    try {
      sessionStorage.setItem(DROPPED_KEY, JSON.stringify(dropped));
    } catch {
      // Storage blocked: the bikes stay for this page only.
    }
    canvas.dataset.dropped = String(dropped.length);
    rebake();
  }
  /** The newest bike left keeps its rig; the rest are baked into one mesh. */
  function rebake(): void {
    const shown = phase === 'walk' || phase === 'fetch' ? dropped.at(-1) : undefined;
    const rest = dropped.filter((d) => d !== shown);
    parkedAll.geometry.dispose();
    parkedAll.visible = rest.length > 0;
    if (!rest.length) return;
    const most = rest.length;
    const into: BikeArrays = {
      position: new Float32Array(most * BIKE_MOST.vertices * 3),
      normal: new Float32Array(most * BIKE_MOST.vertices * 3),
      color: new Float32Array(most * BIKE_MOST.vertices * 3),
      bone: new Uint8Array(most * BIKE_MOST.vertices),
      dither: new Uint8Array(most * BIKE_MOST.vertices),
      hull: new Uint8Array(most * BIKE_MOST.vertices),
      index: new Uint16Array(most * BIKE_MOST.indices),
    };
    const at = { vertices: 0, indices: 0 };
    for (const d of rest) bakeBike(d, SCALE, into, at);
    const g = geometryOf(into);
    g.setDrawRange(0, at.indices);
    parkedAll.geometry = g;
    if (shown) place(shown);
  }
  /** Puts the rigged bike where a dropped bike stands, on its kickstand. */
  function place(d: Stand): void {
    dress(d.look);
    bike.visible = true;
    twin.visible = false;
    scene.add(bike);
    bike.position.set(d.x, d.y, d.z);
    bike.rotation.set(0, d.heading, -d.lean);
    bike.scale.setScalar(SCALE);
    for (const b of bones) b.rotation.set(0, 0, 0);
    bones[1]!.rotation.y = Math.max(-SHOWN_STEER, Math.min(SHOWN_STEER, d.steer));
    bones[4]!.rotation.x = -Math.PI / 2;
    bones[5]!.rotation.x = bones[6]!.rotation.x = Math.PI / 2;
  }

  try {
    const stored = JSON.parse(sessionStorage.getItem(DROPPED_KEY) ?? '[]') as Dropped[];
    dropped = stored.slice(-MOST_DROPPED * 2);
  } catch {
    dropped = [];
  }
  remember();

  let state: RideState = '';
  function publish(next: RideState): void {
    canvas.dataset.ride = next;
    if (next === state) return;
    state = next;
    host.onRide?.(next);
  }

  /** The bike nearest (x, z): a dropped one or a parked one, within `reach`. */
  function nearest(x: number, z: number, reach: number) {
    let best: { dropped?: Dropped; parked?: ReturnType<typeof nearestParked>; d: number } | null =
      null;
    for (const d of dropped) {
      const distance = Math.hypot(d.x - x, d.z - z);
      if (!d.returning && distance < reach) {
        reach = distance;
        best = { dropped: d, d: distance };
      }
    }
    const parked = nearestParked(scene.children, x, z, reach, taken);
    return parked ? { parked, d: parked.distance } : best;
  }

  /** The ground under a bike's wheels, where it stands. */
  const ground = (x: number, z: number) => kit.floor(x, z);

  /** Where a point of a bike's frame is on the street (model metres across to its left, along). */
  function onBike(x: number, z: number, h: number, across: number, along: number, out: XZ): XZ {
    out.x = x + (Math.cos(h) * across + Math.sin(h) * along) * SCALE;
    out.z = z + (Math.cos(h) * along - Math.sin(h) * across) * SCALE;
    return out;
  }

  /**
   * The bike standing on its own (`stood`), nose up or down the slope, leaning, its bars, wheels
   * and crank as they are.
   */
  function drawStood(): void {
    const { x, z, heading } = stood;
    const half = WHEELBASE / 2;
    const fx = Math.sin(heading) * half;
    const fz = Math.cos(heading) * half;
    const rise = ground(x + fx, z + fz) - ground(x - fx, z - fz);
    bike.position.set(x, ground(x, z), z);
    bike.rotation.set(-Math.atan2(rise, 2 * half), heading, -stood.lean);
    bike.scale.setScalar(SCALE);
    bones[0]!.rotation.z = 0;
    bones[1]!.rotation.y = Math.max(-SHOWN_STEER, Math.min(SHOWN_STEER, stood.steer));
    bones[2]!.rotation.x = bones[3]!.rotation.x = stood.wheel;
    bones[4]!.rotation.x = -stood.crank;
    bones[5]!.rotation.x = bones[6]!.rotation.x = stood.crank;
  }

  /**
   * Plans taking a bike: out of a rack, how far it rolls back (or on) to be clear of it; the way
   * to ride, the open street nearest the way it rolled out or stood; and the spot beside it, on
   * its left, to get on from.
   */
  function aim(found: NonNullable<ReturnType<typeof nearest>>): void {
    target = found;
    let { x, z, heading } = found.dropped ?? { x: 0, z: 0, heading: 0 };
    plan.out = 0;
    if (found.parked) {
      const b = found.parked.mesh.userData.bikes!;
      const at = found.parked.at;
      [x, z, heading] = [
        b[at + PARKED.x]!,
        b[at + PARKED.z]!,
        parkedHeading(b[at + PARKED.heading]!),
      ];
      const clear = (k: number) =>
        !overlap(
          x + Math.sin(heading) * k,
          z + Math.cos(heading) * k,
          grid,
          RIDDEN_RADIUS,
          0,
          spare,
        );
      for (let k = 0.25; k <= ROLL_OUT && !plan.out; k += 0.25)
        plan.out = clear(-k) ? -k : clear(k) ? k : 0;
    }
    const ox = x + Math.sin(heading) * plan.out;
    const oz = z + Math.cos(heading) * plan.out;
    plan.turn = wrap(clearWay(ox, oz, heading + (plan.out < 0 ? Math.PI : 0)) - heading);
    Object.assign(plan, { x, z, heading });
    onBike(ox, oz, heading, STANCE[0], STANCE[1], spot);
  }

  /** Takes the planned bike: off its rack or the street, into the rider's hands. */
  function take(walker: Walker): void {
    const found = target!;
    let d = found.dropped;
    if (found.parked) {
      const { mesh, at } = found.parked;
      const b = mesh.userData.bikes!;
      const [x, z] = [b[at + PARKED.x]!, b[at + PARKED.z]!];
      d = {
        x,
        y: b[at + PARKED.y]!,
        z,
        heading: plan.heading,
        lean: 0,
        steer: 0,
        look: b[at + PARKED.look]!,
        rackX: x,
        rackZ: z,
      };
      hide(x, z);
    } else {
      dropped = dropped.filter((other) => other !== d);
      sounds.kickstand(false);
    }
    current = d!;
    Object.assign(stood, { x: d!.x, z: d!.z, heading: d!.heading, lean: d!.lean, steer: d!.steer });
    stood.wheel = 0;
    stood.crank = Math.PI / 2;
    miss.x = walker.x - spot.x;
    miss.z = walker.z - spot.z;
    miss.heading = wrap(walker.heading - plan.heading);
    walker.route = null;
    target = null;
    phase = 'pull';
    t = since = 0;
    posed = false;
    // Seconds the bike takes to roll out of its rack, and to turn round to the street.
    const quick = reducedMotion ? 0 : 1;
    plan.rolling = plan.out && quick * (ROLL_TIME[0] + ROLL_TIME[1] * Math.abs(plan.out));
    plan.turning =
      Math.abs(plan.turn) > 0.05 ? (quick * TURN_TIME * Math.abs(plan.turn)) / Math.PI : 0;
    remember();
    place(d!);
    twin.visible = true;
    publish('riding');
    kit.wake();
  }

  const mountTime = reducedMotion ? QUICK : MOUNT_TIME;
  const dismountTime = reducedMotion ? QUICK : DISMOUNT_TIME;

  /** The rider's arrival off the spot, easing out: the walker placed at `at`, plus what's left. */
  function arrive(walker: Walker, at: XZ, heading: number): void {
    const left = 1 - smooth(since / SETTLE);
    walker.x = at.x + miss.x * left;
    walker.z = at.z + miss.z * left;
    walker.heading = wrap(heading + miss.heading * left);
  }
  const by: XZ = { x: 0, z: 0 };

  /** Seated with a foot down: riding takes over, and the bike rides with the figure. */
  function seat(): void {
    phase = 'ride';
    rider = createRider(stood.x, stood.z, stood.heading);
    Object.assign(rider, { lean: FOOT_LEAN, foot: 1, crank: stood.crank, steer: stood.steer });
    character.mesh.add(bike);
    bike.position.set(0, 0, 0);
    bike.rotation.set(0, 0, 0);
    bike.scale.setScalar(1);
    rebake();
  }

  /** Off and standing beside it: the walker's own pose takes over, walking a step away. */
  function letGo(walker: Walker): void {
    phase = 'release';
    t = 0;
    posed = false;
    if (!kicked) sounds.kickstand(true);
    kicked = true;
    walker.speed = walker.accel = walker.surge = walker.turning = walker.still = 0;
    walker.route = null;
    onBike(stood.x, stood.z, stood.heading, STEP_AWAY / SCALE, -0.12, by);
    if (!held.any && grid.walkable(by.x, by.z) && !overlap(by.x, by.z, grid, 0.45, 0, spare))
      followRoute(walker, Float32Array.of(walker.x, walker.z, by.x, by.z));
    publish('');
    checkedAt.x = Number.NaN;
  }

  /** Leaves the bike where it stands, on its kickstand. */
  function drop(): void {
    if (!current) return;
    const d: Dropped = {
      ...current,
      x: stood.x,
      y: ground(stood.x, stood.z),
      z: stood.z,
      heading: stood.heading,
      lean: KICKSTAND,
      steer: stood.steer,
    };
    current = undefined;
    dropped.push(d);
    // Past the most, the oldest goes back to its rack once out of sight.
    const staying = dropped.filter((other) => !other.returning);
    if (staying.length > MOST_DROPPED) staying[0]!.returning = true;
    phase = 'walk';
    character.mesh.rotation.z = 0;
    remember();
    place(d);
  }

  /** The camera's walking and riding settings, `riding` of the way to riding's. */
  function retune(): void {
    for (const k in RIDE_FOLLOW) {
      const name = k as keyof typeof RIDE_FOLLOW;
      follow[name] = walking[name] + (RIDE_FOLLOW[name] - walking[name]) * riding;
    }
    const want = 1 + (BOOM - 1) * riding;
    boom.distance *= want / boomed;
    boomed = want;
  }

  /** The way from (x, z) nearest `toward` that's clear for a few metres, or the clearest. */
  function clearWay(x: number, z: number, toward: number): number {
    let [best, most] = [toward, -1];
    for (const k of [0, 1, -1, 2, -2, 3, -3, 4]) {
      const h = toward + (k * Math.PI) / 4;
      let free = 0;
      while (
        free < CLEAR &&
        !overlap(x + Math.sin(h) * (free + 1), z + Math.cos(h) * (free + 1), grid, 0.4, 0, spare)
      )
        free += 0.5;
      if (free >= CLEAR) return wrap(h);
      if (free > most) [best, most] = [h, free];
    }
    return wrap(best);
  }

  const spare: [number, number] = [0, 0];

  let chores = 0;
  let away = false;
  const checkedAt = { x: Number.NaN, z: Number.NaN };
  function doChores(walker: Walker, dt: number): void {
    chores += dt;
    if (chores < CHORES) return;
    chores = 0;
    // Racks built (or built again) since a bike was taken from them draw it as nothing too.
    if (current) hide(current.rackX, current.rackZ);
    for (const d of dropped) hide(d.rackX, d.rackZ);
    // The oldest bike left goes back to its rack while neither it nor its rack is in view.
    const back = dropped.find(
      (d) => d.returning && !seen(d.x, d.y, d.z) && !seen(d.rackX, d.y, d.rackZ),
    );
    if (back) {
      dropped = dropped.filter((d) => d !== back);
      unhide(back.rackX, back.rackZ);
      remember();
      if (phase === 'walk' && dropped.length) place(dropped.at(-1)!);
      else if (!dropped.length && phase === 'walk') bike.visible = false;
    }
    // Riding fast, a new 64 m tile of the walk grid comes every few seconds: fill the ones
    // ahead while the page is idle, not on the frame it's reached.
    if (phase === 'ride' && Math.abs(rider.speed) > 3) {
      const [fx, fz] = [Math.sin(rider.heading), Math.cos(rider.heading)];
      const idle = globalThis.requestIdleCallback ?? ((run: () => void) => setTimeout(run, 50));
      idle(() => {
        for (const ahead of [32, 64])
          grid.value(grid.cellAt(walker.x + fx * ahead, walker.z + fz * ahead));
      });
    }
  }

  /** Whether a point is in the camera's view, give or take a bike's size. */
  const clip = new Float64Array(4);
  function seen(x: number, y: number, z: number): boolean {
    const v = view.matrixWorldInverse.elements;
    const p = view.projectionMatrix.elements;
    const [ex, ey, ez] = [
      v[0]! * x + v[4]! * y + v[8]! * z + v[12]!,
      v[1]! * x + v[5]! * y + v[9]! * z + v[13]!,
      v[2]! * x + v[6]! * y + v[10]! * z + v[14]!,
    ];
    for (let i = 0; i < 4; i++) clip[i] = p[i]! * ex + p[i + 4]! * ey + p[i + 8]! * ez + p[i + 12]!;
    const w = clip[3]! * 1.2 + 2;
    return clip[3]! > -2 && Math.abs(clip[0]!) < w && Math.abs(clip[1]!) < w && -ez < 400;
  }

  return {
    frame(walker, steerX, steerZ, right, up, stick, sprint, dt) {
      walker0 = walker;
      if (away) {
        // Back on the street: the bikes left here stand where they were.
        away = false;
        rebake();
      }
      doChores(walker, dt);
      // The camera eases from walking's settings to riding's as the rider gets on, and back.
      const goal =
        phase === 'ride' || phase === 'stop'
          ? 1
          : phase === 'mount'
            ? smooth(t / mountTime)
            : phase === 'dismount'
              ? 1 - smooth(t / dismountTime)
              : 0;
      if (goal !== riding) {
        riding = goal;
        retune();
      }
      if (phase === 'walk' || phase === 'fetch') {
        if (phase === 'fetch' && !walker.route) {
          // Walked to the bike (or stopped short): get on if it's still there and in reach.
          const there = Math.hypot(walker.x - spot.x, walker.z - spot.z) < ARRIVED;
          target = there ? nearest(plan.x, plan.z, 0.3) : null;
          if (target) take(walker);
          else phase = 'walk';
        }
        if (
          phase === 'walk' &&
          !(Math.hypot(walker.x - checkedAt.x, walker.z - checkedAt.z) <= 0.2)
        ) {
          [checkedAt.x, checkedAt.z] = [walker.x, walker.z];
          publish(nearest(walker.x, walker.z, NEAR) ? 'near' : '');
        }
        // Taking a bike just now takes the body this very frame.
        return (phase as Phase) === 'pull';
      }
      // Getting on or off, a direction held hurries it along (or, off, walks away).
      held.x = steerX;
      held.z = steerZ;
      held.run = sprint;
      held.any = !!(right || up || steerX || steerZ);
      if (phase !== 'ride' && phase !== 'stop') return true;
      // A click on a street while riding snapped the walker to the route's start: the bike is
      // where it is.
      [walker.x, walker.z] = [rider.x, rider.z];
      Object.assign(input, createInput());
      if (phase === 'stop') input.throttle = rider.speed > 0.3 ? -1 : 0;
      else if (held.any) {
        walker.route = null;
        if (stick) {
          input.toward = Math.atan2(steerX, steerZ);
          const push = Math.min(1, Math.hypot(right, up));
          input.throttle = push < 0.15 ? 0 : push;
        } else [input.throttle, input.turn] = [up, right];
        input.sprint = sprint;
      } else routeInput(rider, walker, input);
      // Flat out, the lens widens a little more than a run's.
      const fast = Math.max(0, Math.min(1, (rider.speed - CRUISE) / (SPRINT - CRUISE)));
      follow.fov = reducedMotion ? 0 : SPRINT_FOV * fast;
      return true;
    },

    step(walker) {
      const pace = held.any ? HURRY : 1;
      if (phase === 'pull' || phase === 'mount') {
        t += STEP * pace;
        since += STEP * pace;
        // The camera comes round behind the bike as the rider gets on, so up on the stick (or
        // W) is the way it faces.
        if (!reducedMotion)
          boom.aimYaw = decayAngle(boom.aimYaw, stood.heading + Math.PI, 0.12, STEP);
      }
      if (phase === 'pull') {
        // Rolled back out of its rack, then turned round to the street with the rider walking
        // round beside it, hands on the bars; off its kickstand and its bars straightened.
        const roll = plan.rolling;
        const turn = plan.turning;
        const along = plan.out * (roll ? smooth(t / roll) : 1);
        const sin = Math.sin(plan.heading);
        const cos = Math.cos(plan.heading);
        const was = Math.hypot(stood.x - plan.x, stood.z - plan.z) * Math.sign(plan.out);
        stood.x = plan.x + sin * along;
        stood.z = plan.z + cos * along;
        stood.wheel += (along - was) / WHEEL;
        stood.heading = wrap(plan.heading + plan.turn * (turn ? smooth((t - roll) / turn) : 1));
        stood.lean = decay(stood.lean, 0, 0.08, STEP);
        stood.steer = decay(stood.steer, 0, 0.1, STEP);
        const px = walker.x;
        const pz = walker.z;
        const ph = walker.heading;
        const ox = plan.x + sin * plan.out;
        const oz = plan.z + cos * plan.out;
        arrive(walker, onBike(ox, oz, stood.heading, STANCE[0], STANCE[1], by), stood.heading);
        // Walking it round, the walker steps forward or back with it.
        const mx = walker.x - px;
        const mz = walker.z - pz;
        walker.speed = Math.hypot(mx, mz) / STEP;
        walker.turning = wrap(walker.heading - ph) / STEP;
        const ahead = mx * Math.sin(walker.heading) + mz * Math.cos(walker.heading) < 0 ? -1 : 1;
        walker.phase =
          (walker.phase + (ahead * walker.speed * Math.PI * 2 * STEP) / STRIDE_WALK + Math.PI * 2) %
          (Math.PI * 2);
        walker.still = 0;
        drawStood();
        if (t >= roll + turn) {
          phase = 'mount';
          t = 0;
          posed = false;
          plan.lean = stood.lean;
        }
        return true;
      }
      if (phase === 'mount') {
        const u = Math.min(1, t / mountTime);
        // Seated, the right foot is on the forward pedal, ready to push: the crank turned back
        // half a turn as the leg comes over.
        stood.crank = Math.PI / 2 - Math.PI * smooth((u - 0.3) / 0.4);
        Object.assign(poseState, { crank: (3 * Math.PI) / 2, steer: stood.steer, stand: 0 });
        poseState.foot = 1;
        poseState.lean = FOOT_LEAN;
        swingPlace(true, u, poseState, plan.lean, where);
        stood.lean = where.bike;
        arrive(
          walker,
          onBike(stood.x, stood.z, stood.heading, where.x, where.z, by),
          stood.heading,
        );
        walker.speed = walker.turning = 0;
        drawStood();
        if (u === 1) seat();
        return true;
      }
      if (phase === 'dismount') {
        t += STEP * pace;
        const u = Math.min(1, t / dismountTime);
        swingPlace(false, u, poseState, KICKSTAND, where);
        stood.lean = where.bike;
        onBike(stood.x, stood.z, stood.heading, where.x, where.z, walker);
        walker.heading = stood.heading;
        walker.speed = walker.turning = 0;
        if (!kicked && u >= KICK_AT) {
          kicked = true;
          sounds.kickstand(true);
        }
        drawStood();
        // A direction held once the leg is over walks off there and then.
        if (u === 1 || (held.any && u >= OVER_AT)) letGo(walker);
        return true;
      }
      if (phase === 'release') {
        t += STEP;
        const moving = stepWalker(walker, STEP, held.x, held.z, grid, held.run);
        stood.lean = decay(stood.lean, KICKSTAND, 0.05, STEP);
        drawStood();
        if (t >= (reducedMotion ? 0 : RELEASE)) drop();
        return moving || phase === 'release';
      }
      const moving = stepRider(rider, STEP, input, grid);
      sounds.freewheel(rider.wheel, rider.speed, !rider.pedalling);
      if (rider.bump > THUD) sounds.thud(rider.bump);
      rider.bump = 0;
      [walker.x, walker.z, walker.heading] = [rider.x, rider.z, rider.heading];
      [walker.speed, walker.turning, walker.still] = [Math.abs(rider.speed), rider.turning, 0];
      const speed = String(Math.round(Math.abs(rider.speed)));
      if (canvas.dataset.speed !== speed) canvas.dataset.speed = speed;
      if (phase === 'stop' && Math.abs(rider.speed) < 0.3 && rider.foot > 0.9) {
        // Stopped with a foot down: off the figure, the bike stays standing where it is while
        // the rider swings a leg over and steps off.
        phase = 'dismount';
        t = 0;
        posed = kicked = false;
        Object.assign(stood, {
          x: rider.x,
          z: rider.z,
          heading: rider.heading,
          lean: rider.lean,
          steer: rider.steer,
          wheel: rider.wheel,
          crank: rider.crank,
        });
        Object.assign(poseState, { crank: rider.crank, steer: rider.steer, stand: 0 });
        poseState.foot = 1;
        poseState.lean = rider.lean;
        scene.add(bike);
        twin.visible = false;
        drawStood();
      }
      return moving || phase === 'stop';
    },

    pose(out, head) {
      poseState.look = head;
      if (phase === 'ride' || phase === 'stop') {
        // The bike's moving parts: wheels, crank, pedals kept level, bars within the hands' reach.
        const steer = Math.max(-SHOWN_STEER, Math.min(SHOWN_STEER, rider.steer));
        bones[1]!.rotation.y = steer;
        bones[2]!.rotation.x = bones[3]!.rotation.x = rider.wheel;
        bones[4]!.rotation.x = -rider.crank;
        bones[5]!.rotation.x = bones[6]!.rotation.x = rider.crank;
        // Standing on the pedals, the bike rocks under the rider.
        bones[0]!.rotation.z = ROCK * 0.8 * rider.stand * Math.sin(rider.crank);
        Object.assign(poseState, { crank: rider.crank, steer, stand: rider.stand });
        poseState.foot = rider.foot;
        poseState.lean = rider.lean;
        // Nose up or down a slope, as its wheels find the ground.
        const half = WHEELBASE / 2;
        const [fx, fz] = [Math.sin(rider.heading) * half, Math.cos(rider.heading) * half];
        const rise =
          terrain.height(rider.x + fx, rider.z + fz) - terrain.height(rider.x - fx, rider.z - fz);
        bike.rotation.x = -Math.atan2(rise, 2 * half);
        character.mesh.rotation.z = -rider.lean;
        return rideAt(out, poseState);
      }
      if (!posed) {
        Object.assign(before, out);
        posed = true;
      }
      if (phase === 'mount' || phase === 'dismount') {
        character.mesh.rotation.z = -where.tilt;
        const on = phase === 'mount';
        const u = t / (on ? mountTime : dismountTime);
        return swingAt(out, on, u, poseState, before, on ? plan.lean : KICKSTAND, where);
      }
      // On foot: taking the bike, letting go of it, or walking off.
      const w = walker0!;
      character.mesh.rotation.z = 0;
      kit.poseAt(
        out,
        w.speed,
        w.phase,
        w.still,
        !reducedMotion,
        w.turning,
        head,
        w.surge,
        w.heading,
      );
      out.splayL = out.splayR = 0;
      out.spreadL = out.spreadR = kit.armSpread;
      if (phase === 'release') return blendPose(out, before, out, smooth(t / RELEASE));
      if (phase !== 'pull') return out;
      // Hands on the bars, wherever the bike is from the walker.
      const dx = stood.x - w.x;
      const dz = stood.z - w.z;
      const c = Math.cos(w.heading);
      const s = Math.sin(w.heading);
      return hold(
        out,
        (dx * c - dz * s) / SCALE,
        (dx * s + dz * c) / SCALE,
        wrap(stood.heading - w.heading),
        stood.lean,
        0,
        stood.steer,
        // Out of a rack, the hands take the bars as the bike comes to them.
        smooth(Math.min(since / SETTLE, plan.rolling ? t / plan.rolling : 1)),
      );
    },

    act(action, walker) {
      if (action === 'bell') {
        sounds.bell();
        return;
      }
      if (phase === 'ride') {
        phase = 'stop';
        kit.wake();
        return;
      }
      if (phase !== 'walk' && phase !== 'fetch') return;
      const found = nearest(walker.x, walker.z, FETCH);
      if (!found) return;
      aim(found);
      const dx = spot.x - walker.x;
      const dz = spot.z - walker.z;
      if (Math.hypot(dx, dz) < CLOSE && Math.abs(wrap(walker.heading - plan.heading)) < 0.8) {
        take(walker);
        return;
      }
      // Walk there, the last metre along the bike so as to face its way.
      kit.walkTo(
        spot.x - Math.sin(plan.heading) * LAST_LEG,
        spot.z - Math.cos(plan.heading) * LAST_LEG,
      );
      if (!walker.route) return;
      walker.route = Float32Array.of(...walker.route, spot.x, spot.z);
      phase = 'fetch';
    },

    leave() {
      if (phase === 'ride' || phase === 'stop') {
        Object.assign(stood, {
          x: rider.x,
          z: rider.z,
          heading: rider.heading,
          steer: rider.steer,
        });
      }
      if (current) {
        rider.speed = 0;
        scene.add(bike);
        drop();
      }
      phase = 'walk';
      target = null;
      publish('');
      checkedAt.x = Number.NaN;
      riding = 0;
      retune();
      // Bikes are street things: the map shows none of them.
      away = true;
      bike.visible = parkedAll.visible = false;
    },

    dispose() {
      loose.length = 0;
      scene.remove(bike, parkedAll);
      bike.geometry.dispose();
      parkedAll.geometry.dispose();
    },
  };
}
