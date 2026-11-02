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
import type { Character, Pose } from './character.ts';
import type { Boom, Follow } from './chase.ts';
import { loose, overlap } from './collide.ts';
import { decayAngle } from './motion.ts';
import { DROPPED_KEY, PARKED, nearestParked, parkedHeading } from './parked.ts';
import type { Furniture } from './parked.ts';
import {
  CRUISE,
  SPRINT,
  WHEELBASE,
  createInput,
  createRider,
  routeInput,
  stepRider,
} from './rider.ts';
import type { Rider } from './rider.ts';
import { ROCK, SHOWN_STEER, blendPose, rideAt } from './rider-pose.ts';
import type { RideState as PoseState } from './rider-pose.ts';
import type { WalkHost } from './walk.ts';
import { STEP } from './walker.ts';
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
    'Bone' | 'BufferAttribute' | 'BufferGeometry' | 'Skeleton' | 'SkinnedMesh'
  >;
  host: WalkHost;
  grid: WalkGrid;
  character: Character;
  body: Material;
  xray: Material;
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
/** Walked to a bike, the route may end this far from it (m): the rider steps the rest. */
const ARRIVED = 3.5;
/** Getting on and off (s). */
const MOUNT = 0.45;
/** A bike on its kickstand leans this far onto it, its left (radians). */
const KICKSTAND = (6 * Math.PI) / 180;
/** Getting off, the rider stands this far to the bike's side (m). */
const ASIDE = 0.8;
/** Getting on, the bike is turned to have this much clear street ahead (m), if it can. */
const CLEAR = 6;
/** A dropped bike is met as a circle this round (m). */
const DROPPED_RADIUS = 0.55;
/** Bikes left about the city at once, before the oldest goes back to its rack. */
const MOST_DROPPED = 6;
/** The bike's scale, the figure's. */
const SCALE = 1.3;
/** How often (s) riding looks after the racks: hidden copies, returns, tiles ahead. */
const CHORES = 0.5;
/** A hit harder than this (m/s) thuds. */
const THUD = 1.2;
/** Riding, the camera: the boom 1.2× longer, the look point 0.35 s ahead with a 150 ms lag,
 * coming round at about 3 a second 0.7 s after a look by hand, 8° wider flat out, rolled with
 * the lean. */
const BOOM = 1.2;
const RIDE_FOLLOW = { ahead: 0.35, ease: 0.15, rate: 1.8, early: 0.3 } as const;
const SPRINT_FOV = 3;
const CAMERA_ROLL = 0.15;

/** A bike left standing somewhere, and the rack bike it was (to put back). */
interface Dropped extends Stand {
  /** The parked bike it was taken from, by where it stood. */
  rackX: number;
  rackZ: number;
  /** Going back to its rack once nobody can see. */
  returning?: boolean;
}

type Phase = 'walk' | 'fetch' | 'mount' | 'ride' | 'stop' | 'dismount';

const key = (x: number, z: number) => `${x.toFixed(2)} ${z.toFixed(2)}`;
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const smooth = (t: number) => t * t * (3 - 2 * t);

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
  scene.add(bike);

  // Bikes left about the city, but the newest: one baked mesh on one bone.
  const restBone = new three.Bone();
  const parkedAll: SkinnedMesh = new three.SkinnedMesh(new three.BufferGeometry(), kit.body);
  parkedAll.add(restBone);
  parkedAll.bind(new three.Skeleton([restBone]) as Skeleton);
  parkedAll.receiveShadow = true;
  parkedAll.visible = false;
  scene.add(parkedAll);

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
  let blend = 0;
  const from = { x: 0, z: 0, heading: 0 };
  const to = { x: 0, z: 0 };
  let posed = false;
  // Poses getting on and off: the one before, the walker standing as it got on, and seated.
  const before = {} as Pose;
  const standing = {} as Pose;
  const seated = {} as Pose;
  const input = createInput();
  const poseState: PoseState = { crank: 0, steer: 0, stand: 0, foot: 0, look: 0 };
  let fetching: { x: number; z: number } | undefined;
  /** The way the bike faced as it was taken, if the rider swings it round getting on. */
  let turnFrom = 0;

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

  function mount(walker: Walker, target: NonNullable<ReturnType<typeof nearest>>): void {
    let d = target.dropped;
    if (target.parked) {
      const { mesh, at } = target.parked;
      const b = mesh.userData.bikes!;
      const [x, z] = [b[at + PARKED.x]!, b[at + PARKED.z]!];
      d = {
        x,
        y: b[at + PARKED.y]!,
        z,
        heading: parkedHeading(b[at + PARKED.heading]!),
        lean: 0,
        steer: 0,
        look: b[at + PARKED.look]!,
        rackX: x,
        rackZ: z,
      };
      hide(x, z);
    } else dropped = dropped.filter((other) => other !== d);
    current = d!;
    d!.y = kit.floor(d!.x, d!.z);
    rider = createRider(d!.x, d!.z, d!.heading);
    [rider.lean, rider.steer] = [d!.lean, d!.steer];
    // A bike parked nose to a wall, or across a lane, is swung round as the rider gets on: to
    // ride the way the camera looks, or as near it as the street lets it go.
    turnFrom = d!.heading;
    rider.heading = clearWay(d!.x, d!.z, wrap(boom.yaw + Math.PI));
    [from.x, from.z, from.heading] = [walker.x, walker.z, walker.heading];
    walker.route = null;
    fetching = undefined;
    phase = 'mount';
    blend = 0;
    posed = false;
    remember();
    place(d!);
    twin.visible = true;
    sounds.kickstand(false);
    boom.distance *= BOOM;
    Object.assign(follow, RIDE_FOLLOW);
    publish('riding');
    kit.wake();
  }

  /** Off the bike: it stays where it is on its kickstand, and the rider beside it. */
  function drop(): void {
    if (!current) return;
    const ground = kit.floor(rider.x, rider.z);
    const d: Dropped = {
      ...current,
      x: rider.x,
      y: ground,
      z: rider.z,
      heading: rider.heading,
      lean: KICKSTAND,
      steer: rider.steer,
    };
    current = undefined;
    dropped.push(d);
    // Past the most, the oldest goes back to its rack once out of sight.
    const staying = dropped.filter((other) => !other.returning);
    if (staying.length > MOST_DROPPED) staying[0]!.returning = true;
    phase = 'walk';
    character.mesh.rotation.z = 0;
    boom.distance /= BOOM;
    Object.assign(follow, walking);
    remember();
    place(d);
    sounds.kickstand(true);
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

  /** Where the rider stands getting off: beside the bike, on whichever side is clear. */
  function aside(): void {
    for (const side of [1, -1]) {
      const [lx, lz] = [Math.cos(rider.heading) * side, -Math.sin(rider.heading) * side];
      [to.x, to.z] = [rider.x + lx * ASIDE, rider.z + lz * ASIDE];
      if (overlap(to.x, to.z, grid, 0.45, 0, spare) < 0.1 && grid.walkable(to.x, to.z)) return;
    }
    [to.x, to.z] = [rider.x, rider.z];
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
      if (away) {
        // Back on the street: the bikes left here stand where they were.
        away = false;
        rebake();
      }
      doChores(walker, dt);
      if (phase === 'walk' || phase === 'fetch') {
        if (phase === 'fetch' && !walker.route) {
          // Walked to the bike (or stopped short): get on if it's in reach.
          const target = fetching && nearest(fetching.x, fetching.z, 0.3);
          const there =
            target && Math.hypot(walker.x - fetching!.x, walker.z - fetching!.z) < ARRIVED;
          if (target && there) mount(walker, target);
          else phase = 'walk';
        }
        if (
          phase === 'walk' &&
          !(Math.hypot(walker.x - checkedAt.x, walker.z - checkedAt.z) <= 0.2)
        ) {
          [checkedAt.x, checkedAt.z] = [walker.x, walker.z];
          publish(nearest(walker.x, walker.z, NEAR) ? 'near' : '');
        }
        // Getting on just now takes the body this very frame.
        return (phase as Phase) === 'mount';
      }
      // A click on a street while riding snapped the walker to the route's start: the bike is
      // where it is.
      if (phase === 'ride' || phase === 'stop') [walker.x, walker.z] = [rider.x, rider.z];
      Object.assign(input, createInput());
      if (phase === 'stop') input.throttle = rider.speed > 0.3 ? -1 : 0;
      else if (right || up || steerX || steerZ) {
        walker.route = null;
        if (stick) {
          input.toward = Math.atan2(steerX, steerZ);
          const push = Math.min(1, Math.hypot(right, up));
          input.throttle = push < 0.15 ? 0 : push;
        } else [input.throttle, input.turn] = [up, right];
        input.sprint = sprint;
      } else routeInput(rider, walker, input);
      // Flat out, the lens widens a little more than a run's; the view rolls a little with the lean.
      const fast = Math.max(0, Math.min(1, (rider.speed - CRUISE) / (SPRINT - CRUISE)));
      follow.fov = reducedMotion ? 0 : SPRINT_FOV * fast;
      follow.roll = reducedMotion ? 0 : CAMERA_ROLL * rider.lean;
      return true;
    },

    step(walker) {
      if (phase === 'mount' || phase === 'dismount') {
        blend = Math.min(1, Math.max(0, blend + (phase === 'mount' ? STEP : -STEP) / MOUNT));
        const k = smooth(blend);
        const [fx, fz] = phase === 'mount' ? [from.x, from.z] : [to.x, to.z];
        walker.x = fx + (rider.x - fx) * k;
        walker.z = fz + (rider.z - fz) * k;
        walker.heading = wrap(from.heading + wrap(rider.heading - from.heading) * k);
        walker.speed = 0;
        if (phase === 'mount') {
          bike.rotation.y = wrap(turnFrom + wrap(rider.heading - turnFrom) * k);
          // The camera comes round behind the bike as the rider gets on, so up on the stick
          // (or W) is the way it faces.
          if (!reducedMotion)
            boom.aimYaw = decayAngle(boom.aimYaw, rider.heading + Math.PI, 0.12, STEP);
        }
        if (phase === 'mount' && blend === 1) {
          phase = 'ride';
          // Seated: the bike rides with the figure, leaning and turning with it.
          character.mesh.add(bike);
          bike.position.set(0, 0, 0);
          bike.rotation.set(0, 0, 0);
          bike.scale.setScalar(1);
          rebake();
        } else if (phase === 'dismount' && blend === 0) {
          [walker.heading, walker.still, walker.accel, walker.turning] = [rider.heading, 0, 0, 0];
          drop();
          publish('');
          checkedAt.x = Number.NaN;
        }
        return true;
      }
      const moving = stepRider(rider, STEP, input, grid);
      sounds.freewheel(rider.wheel, rider.speed, !rider.pedalling);
      if (rider.bump > THUD) sounds.thud(rider.bump);
      rider.bump = 0;
      [walker.x, walker.z, walker.heading] = [rider.x, rider.z, rider.heading];
      [walker.speed, walker.turning, walker.still] = [Math.abs(rider.speed), rider.turning, 0];
      const speed = String(Math.round(Math.abs(rider.speed)));
      if (canvas.dataset.speed !== speed) canvas.dataset.speed = speed;
      if (phase === 'stop' && Math.abs(rider.speed) < 0.3 && rider.foot > 0.6) {
        phase = 'dismount';
        blend = 1;
        posed = false;
        from.heading = rider.heading;
        aside();
        // Off the figure: the bike stays standing where it is while the rider steps away.
        scene.add(bike);
        bike.position.set(rider.x, kit.floor(rider.x, rider.z), rider.z);
        bike.rotation.set(0, rider.heading, -rider.lean);
        bike.scale.setScalar(SCALE);
        twin.visible = false;
      }
      return moving || phase === 'stop';
    },

    pose(out, head) {
      // The bike's moving parts: wheels, crank, pedals kept level, bars within the hands' reach.
      const steer = Math.max(-SHOWN_STEER, Math.min(SHOWN_STEER, rider.steer));
      bones[1]!.rotation.y = steer;
      bones[2]!.rotation.x = bones[3]!.rotation.x = rider.wheel;
      bones[4]!.rotation.x = -rider.crank;
      bones[5]!.rotation.x = bones[6]!.rotation.x = rider.crank;
      // Standing on the pedals, the bike rocks under the rider.
      bones[0]!.rotation.z = ROCK * 0.8 * rider.stand * Math.sin(rider.crank);
      Object.assign(poseState, { crank: rider.crank, steer, stand: rider.stand, look: head });
      poseState.foot = rider.foot;
      if (phase === 'ride' || phase === 'stop') {
        // Nose up or down a slope, as its wheels find the ground.
        const half = WHEELBASE / 2;
        const [fx, fz] = [Math.sin(rider.heading) * half, Math.cos(rider.heading) * half];
        const rise =
          terrain.height(rider.x + fx, rider.z + fz) - terrain.height(rider.x - fx, rider.z - fz);
        bike.rotation.x = -Math.atan2(rise, 2 * half);
        character.mesh.rotation.z = -rider.lean;
        return rideAt(out, poseState);
      }
      // Getting on or off: from the pose before into the one after, the rider leaning with the
      // bike as they come onto it.
      if (!posed) {
        Object.assign(before, out);
        if (phase === 'mount') Object.assign(standing, out);
        posed = true;
      }
      character.mesh.rotation.z = -rider.lean * smooth(blend);
      rideAt(seated, poseState);
      return phase === 'mount'
        ? blendPose(out, before, seated, blend)
        : blendPose(out, standing, before, blend);
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
      const target = nearest(walker.x, walker.z, FETCH);
      if (!target) return;
      if (target.d <= NEAR) {
        mount(walker, target);
        return;
      }
      // Further off: walk there first, to its side.
      const b = target.dropped ?? {
        x: target.parked!.mesh.userData.bikes![target.parked!.at + PARKED.x]!,
        z: target.parked!.mesh.userData.bikes![target.parked!.at + PARKED.z]!,
      };
      const spot = grid.nearest(b.x, b.z, 3);
      if (!spot) return;
      kit.walkTo(spot[0], spot[1]);
      if (!walker.route) return;
      fetching = { x: b.x, z: b.z };
      phase = 'fetch';
    },

    leave() {
      if (phase !== 'walk' && phase !== 'fetch') {
        rider.speed = 0;
        scene.add(bike);
        drop();
      }
      phase = 'walk';
      publish('');
      checkedAt.x = Number.NaN;
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
