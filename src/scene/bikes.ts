import type {
  BackSide,
  BufferAttribute,
  BufferGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshBasicMaterialParameters,
  MeshToonMaterial,
  Scene,
  Texture,
} from 'three';

import { createRideSounds } from '../audio/riding.ts';
import type { Avatar } from './avatar.ts';
import { BIKES, BIKE_MOST, LOOK, WHEEL, bakeBike } from './bike-rig.ts';
import type { BikeArrays, Stand } from './bike-rig.ts';
import { loose } from './collide.ts';
import type { MeshBuilder } from './mesh-builder.ts';
import { WALKER } from './palette.ts';
import { PARKED, nearestParked, parkedHeading } from './parked.ts';
import type { Furniture } from './parked.ts';
import {
  FIGURE,
  NEAR_SHAPES,
  RIDE_HEIGHT,
  vehicleMaterials,
  vehicleVertexShader,
} from './vehicles.ts';

/**
 * Bikes for the avatar: take a parked one (F, or the Ride pill) and ride it as a faster walk with
 * momentum (`ON_BIKE` in avatar.ts), ring its bell (B), and leave it standing anywhere. A chunk of
 * its own, loaded near a rack or on F.
 *
 * The rider is the traffic's own cyclist (vehicles.ts): the walker's figure on the ridden bike,
 * pedalling in the vertex shader, one instance of its near shape and ink hull, two draw calls.
 * Taking a bike from a rack draws its rack copy as nothing (its triangles zeroed in the cell's
 * furniture, only that range uploaded, what was there kept to put back). Bikes left standing are
 * baked as parked bikes are (`bakeBike`), into one mesh; past a few, the oldest goes back to its
 * rack.
 */

export type RideState = '' | 'near' | 'riding';
export type RideAction = 'toggle' | 'bell';

/** What the chunk takes from the engine, so it imports none of three itself. */
export interface BikesKit {
  three: {
    BackSide: typeof BackSide;
    BufferAttribute: typeof BufferAttribute;
    BufferGeometry: typeof BufferGeometry;
    InstancedBufferAttribute: typeof InstancedBufferAttribute;
    InstancedMesh: typeof InstancedMesh;
    Matrix4: typeof Matrix4;
    Mesh: typeof Mesh;
    MeshBasicMaterial: typeof MeshBasicMaterial;
    MeshToonMaterial: typeof MeshToonMaterial;
  };
  MeshBuilder: typeof MeshBuilder;
  linearVertexColors: (vertexShader: string) => string;
  bayer: string;
  gradientMap: Texture;
  night: { value: number };
  ink: number;
  /** The figure's silhouette where a house hides it (`XRAY_LOOK`): the rider gets the same. */
  xray: MeshBasicMaterialParameters;
  scene: Scene;
  canvas: HTMLElement;
  /** The figure's material: bikes left standing take it, blob shadow and all. */
  body: Material;
  /** Where wheels stand at a spot: the ground as drawn. */
  floor(x: number, z: number): number;
  /** A rack bike taken or put back changes what casts shadows. */
  shadowsChanged(): void;
}

/** What a step of riding asks the avatar to do. */
export interface BikeChores {
  /** Walk there first: the bike chosen is further than arm's reach. */
  walkTo?: [number, number];
}

export interface Bikes {
  readonly state: RideState;
  /** Gets on the nearest bike (walking to it first) or off this one, or rings the bell. */
  act(action: RideAction, a: Avatar): BikeChores;
  /**
   * Each frame, after the avatar stepped: the transition under way, the rider drawn where the
   * avatar is, what's near. Returns whether anything is still moving.
   */
  frame(a: Avatar, dt: number): boolean;
  /** Whether the transition holds the avatar still (it doesn't steer meanwhile). */
  readonly busy: boolean;
  /** Ends getting on or off at once, where it was going: the avatar is put somewhere else. */
  finish(a: Avatar): void;
  /** Gives up walking to a bike: the avatar was sent somewhere else. */
  cancel(): void;
  /** Bikes and riders show with the street furniture, not from far out. */
  show(near: boolean): void;
  dispose(): void;
}

/** Within this of a bike (m), it can be taken there and then; within FETCH, F walks there first. */
const NEAR = 2;
const FETCH = 30;
/** A route to a bike ends at the open ground nearest it, this much further off at most (m). */
const ARRIVED = 1.5;
/** Getting on or off (s): the avatar glides onto the bike or off beside it. */
const TAKE = 0.6;
/** Getting off, the avatar steps out this far to the bike's left (m). */
const STEP_AWAY = 1;
/** A bike left standing leans onto its kickstand this far (radians), its left. */
const KICKSTAND = (6 * Math.PI) / 180;
/** Bikes left standing at once, before the oldest goes back to its rack. */
const MOST_DROPPED = 4;
/** A bike left standing is met as a circle this round (m). */
const DROPPED_RADIUS = 0.55;
/** The bike and its rider, drawn 1.3× life size as the figure is. */
const SCALE = 1.3;
/** A ridden bike leans this share of what a real one would in a turn, at most MAX_LEAN. */
const LEAN_SHARE = 0.45;
const MAX_LEAN = (16 * Math.PI) / 180;
/** Slowing harder than this (m/s²) lights the tail lamp. */
const BRAKING = 2;
const G = 9.8;

const srgb = (hex: number) => [
  ((hex >> 16) & 255) / 255,
  ((hex >> 8) & 255) / 255,
  (hex & 255) / 255,
];
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const key = (x: number, z: number) => `${x.toFixed(2)} ${z.toFixed(2)}`;

/** A bike left standing, and the rack bike it was, to put back. */
interface Dropped extends Stand {
  rackX: number;
  rackZ: number;
}

/** A glide between two spots and headings, for getting on and off. */
interface Glide {
  from: [number, number, number];
  to: [number, number, number];
  t: number;
  on: boolean;
}

export function createBikes(kit: BikesKit): Bikes {
  const { three, scene, canvas } = kit;
  const sounds = createRideSounds();

  // The rider: the traffic's cyclist, one instance of its near shape and its ink hull.
  const { material, inkMaterial } = vehicleMaterials(kit);
  const body = new kit.MeshBuilder();
  NEAR_SHAPES.bike(body, false);
  const hull = new kit.MeshBuilder();
  NEAR_SHAPES.bike(hull, true);
  const [bodyGeometry, hullGeometry] = [body, hull].map((b) =>
    b.build({ facade: true, keep: true }),
  ) as [BufferGeometry, BufferGeometry];
  const state = new three.InstancedBufferAttribute(new Float32Array(4), 4);
  bodyGeometry.setAttribute('state', state);
  hullGeometry.setAttribute('state', state);
  const tints = {
    paint: srgb(WALKER.shirt),
    trim: srgb(BIKES[0]!),
    skin: srgb(WALKER.skin),
    hair: srgb(WALKER.hair),
  };
  const trim = new three.InstancedBufferAttribute(new Float32Array(tints.trim), 3);
  for (const [name, tint] of Object.entries(tints)) {
    bodyGeometry.setAttribute(
      name,
      name === 'trim' ? trim : new three.InstancedBufferAttribute(new Float32Array(tint), 3),
    );
  }
  const rider = new three.InstancedMesh(bodyGeometry, material, 1);
  rider.receiveShadow = true;
  const riderInk = new three.InstancedMesh(hullGeometry, inkMaterial, 1);
  riderInk.instanceMatrix = rider.instanceMatrix;
  // Its silhouette where a house hides it, as the walker's (`XRAY_LOOK`), the lamps' glow left
  // out. Drawn before the rider (its render order), in the opaque pass.
  const xray = new three.MeshBasicMaterial(kit.xray);
  xray.onBeforeCompile = (shader) => {
    shader.vertexShader = vehicleVertexShader(shader.vertexShader);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vPart;')
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
        if (vPart < ${FIGURE}.0) discard;`,
      );
  };
  xray.customProgramCacheKey = () => 'rider-xray-v2';
  const riderXray = new three.InstancedMesh(bodyGeometry, xray, 1);
  riderXray.instanceMatrix = rider.instanceMatrix;
  [riderXray.renderOrder, rider.renderOrder, riderInk.renderOrder] = [1, 2, 2];
  for (const mesh of [rider, riderInk, riderXray]) {
    mesh.frustumCulled = false;
    mesh.visible = false;
    scene.add(mesh);
  }
  const matrix = new three.Matrix4();
  const lean = new three.Matrix4();

  // Bikes left standing: one baked mesh in the figure's material.
  const standing = new three.Mesh(new three.BufferGeometry(), kit.body);
  standing.frustumCulled = false;
  standing.receiveShadow = true;
  standing.visible = false;
  scene.add(standing);
  let dropped: Dropped[] = [];
  let shown = true;

  function bake(): void {
    loose.length = 0;
    for (const d of dropped) loose.push(d.x, d.z, DROPPED_RADIUS);
    canvas.dataset.dropped = String(dropped.length);
    standing.geometry.dispose();
    standing.visible = shown && dropped.length > 0;
    if (!dropped.length) return;
    const n = dropped.length;
    const into: BikeArrays = {
      position: new Float32Array(n * BIKE_MOST.vertices * 3),
      normal: new Float32Array(n * BIKE_MOST.vertices * 3),
      color: new Float32Array(n * BIKE_MOST.vertices * 3),
      bone: new Uint8Array(n * BIKE_MOST.vertices),
      dither: new Uint8Array(n * BIKE_MOST.vertices),
      hull: new Uint8Array(n * BIKE_MOST.vertices),
      index: new Uint16Array(n * BIKE_MOST.indices),
    };
    const at = { vertices: 0, indices: 0 };
    for (const d of dropped) bakeBike(d, SCALE, into, at, kit.floor);
    const g = new three.BufferGeometry();
    const v = at.vertices;
    g.setAttribute('position', new three.BufferAttribute(into.position.subarray(0, v * 3), 3));
    g.setAttribute('normal', new three.BufferAttribute(into.normal.subarray(0, v * 3), 3));
    g.setAttribute('color', new three.BufferAttribute(into.color.subarray(0, v * 3), 3));
    g.setAttribute('dither', new three.BufferAttribute(into.dither.subarray(0, v), 1));
    g.setIndex(new three.BufferAttribute(into.index.subarray(0, at.indices), 1));
    standing.geometry = g;
  }

  // The rack copies of bikes taken: zeroed in their furniture, with what was there kept.
  const hidden = new Map<
    string,
    { mesh: Furniture & Mesh; from: number; kept: ArrayLike<number>; x: number; z: number }
  >();
  function upload(mesh: Mesh, from: number, to: number): void {
    const index = mesh.geometry.index!;
    index.clearUpdateRanges();
    index.addUpdateRange(from, to - from);
    index.needsUpdate = true;
    kit.shadowsChanged();
  }
  function hide(mesh: Furniture & Mesh, at: number): void {
    const bikes = mesh.userData.bikes!;
    const k = key(bikes[at + PARKED.x]!, bikes[at + PARKED.z]!);
    const array = mesh.geometry.index?.array as Uint16Array | Uint32Array | undefined;
    // The viewer keeps the index of furniture that has bikes; without it, leave the rack be.
    if (!array || hidden.has(k)) return;
    const [from, to] = [bikes[at + PARKED.from]!, bikes[at + PARKED.to]!];
    const [x, z] = [bikes[at + PARKED.x]!, bikes[at + PARKED.z]!];
    hidden.set(k, { mesh, from, kept: array.slice(from, to), x, z });
    array.fill(0, from, to);
    upload(mesh, from, to);
  }
  function unhide(x: number, z: number): void {
    const k = key(x, z);
    const was = hidden.get(k);
    hidden.delete(k);
    const array = was?.mesh.geometry.index?.array as Uint16Array | Uint32Array | undefined;
    if (!was || !array) return;
    array.set(was.kept, was.from);
    upload(was.mesh, was.from, was.from + was.kept.length);
  }
  const taken = (bikes: Float32Array, at: number) =>
    hidden.has(key(bikes[at + PARKED.x]!, bikes[at + PARKED.z]!));
  /**
   * A lost GPU context builds the furniture again, every rack full: the bikes taken are drawn as
   * nothing in the new meshes too, once they're built, or each would stand at its rack as well.
   */
  function hideAgain(): void {
    for (const [k, was] of hidden) {
      if (was.mesh.parent) continue;
      const found = nearestParked(scene.children, was.x, was.z, 0.01);
      if (!found) continue;
      hidden.delete(k);
      hide(found.mesh as Furniture & Mesh, found.at);
    }
  }

  /** The bike nearest (x, z) within `reach`: one left standing, or a parked one. */
  function nearest(x: number, z: number, reach: number) {
    let best: { stand: Stand; dropped?: Dropped; mesh?: Furniture & Mesh; at?: number } | null =
      null;
    for (const d of dropped) {
      const distance = Math.hypot(d.x - x, d.z - z);
      if (distance < reach) [reach, best] = [distance, { stand: d, dropped: d }];
    }
    const parked = nearestParked(scene.children, x, z, reach, taken);
    if (!parked) return best;
    const b = parked.mesh.userData.bikes!;
    const at = parked.at;
    return {
      stand: {
        x: b[at + PARKED.x]!,
        y: b[at + PARKED.y]!,
        z: b[at + PARKED.z]!,
        heading: parkedHeading(b[at + PARKED.heading]!),
        lean: 0,
        steer: 0,
        look: b[at + PARKED.look]!,
      },
      mesh: parked.mesh as Furniture & Mesh,
      at,
    };
  }

  let ride: RideState = '';
  function publish(next: RideState): void {
    if (next === ride && canvas.dataset.ride === next) return;
    canvas.dataset.ride = next;
    ride = next;
  }
  publish('');

  /** What's being ridden: the bike as it was taken, and where it came from. */
  let current: Dropped | null = null;
  let glide: Glide | null = null;
  /** Walking to a bike to take it on arrival. */
  let fetching = false;
  let wheel = 0;
  let leaning = 0;

  /**
   * Takes the nearest bike within reach, or says where to walk to fetch it (then taken on arrival,
   * where a route may end a little short of it: `ARRIVED`).
   */
  function take(a: Avatar, arrived = false): BikeChores {
    const w = a.walker;
    fetching = false;
    // No bike stands in a room; one outside its walls is out of reach.
    if (a.place) return {};
    const found = nearest(w.x, w.z, arrived ? NEAR + ARRIVED : FETCH);
    if (!found) return {};
    const { stand } = found;
    if (Math.hypot(stand.x - w.x, stand.z - w.z) > (arrived ? NEAR + ARRIVED : NEAR)) {
      if (arrived) return {};
      fetching = true;
      return { walkTo: [stand.x, stand.z] };
    }
    if (found.dropped) {
      dropped = dropped.filter((d) => d !== found.dropped);
      current = found.dropped;
      bake();
    } else {
      hide(found.mesh!, found.at!);
      current = { ...stand, rackX: stand.x, rackZ: stand.z };
    }
    trim.array.set(srgb(BIKES[Math.floor(stand.look / LOOK.colour) % BIKES.length]!));
    trim.needsUpdate = true;
    w.route = null;
    glide = { from: [w.x, w.z, w.heading], to: [stand.x, stand.z, stand.heading], t: 0, on: true };
    sounds.kickstand(false);
    return {};
  }

  function leave(a: Avatar): void {
    const w = a.walker;
    if (!current || glide) return;
    w.route = null;
    const h = w.heading;
    // Out to the bike's left: its left is the walker's right turned round, (cos h, -sin h).
    const [lx, lz] = [Math.cos(h), -Math.sin(h)];
    glide = {
      from: [w.x, w.z, h],
      to: [w.x + lx * STEP_AWAY, w.z + lz * STEP_AWAY, h],
      t: 0,
      on: false,
    };
    dropped.push({
      ...current,
      x: w.x,
      y: kit.floor(w.x, w.z),
      z: w.z,
      heading: h,
      lean: KICKSTAND,
      steer: 0.3,
    });
    // Past a few, the oldest goes back to its rack.
    while (dropped.length > MOST_DROPPED) {
      const oldest = dropped.shift()!;
      unhide(oldest.rackX, oldest.rackZ);
    }
    current = null;
    a.mode = 'foot';
    w.speed = w.accel = 0;
    sounds.kickstand(true);
    bake();
  }

  function place(a: Avatar, dt: number): void {
    const w = a.walker;
    // Into a turn as a real bike would, a share of it: atan(v·ω/g). Turning left is a positive
    // `turning`, and a positive lean tips the bike to its right.
    const want = Math.max(
      -MAX_LEAN,
      Math.min(MAX_LEAN, -Math.atan((w.speed * w.turning) / G) * LEAN_SHARE),
    );
    leaning += (want - leaning) * (1 - Math.exp(-dt / 0.09));
    const yaw = Math.atan2(-Math.cos(w.heading), Math.sin(w.heading));
    matrix.makeRotationY(yaw).multiply(lean.makeRotationX(leaning));
    matrix.setPosition(w.x, kit.floor(w.x, w.z) + a.rise + RIDE_HEIGHT, w.z);
    rider.setMatrixAt(0, matrix);
    rider.instanceMatrix.needsUpdate = true;
    const s = state.array as Float32Array;
    s[0] = w.phase;
    s[1] = w.accel < -BRAKING ? 1 : 0;
    state.needsUpdate = true;
  }

  return {
    get state() {
      return ride;
    },
    get busy() {
      return glide !== null;
    },
    act(action, a) {
      if (action === 'bell') {
        if (a.mode === 'bike') sounds.bell();
        return {};
      }
      if (a.mode === 'bike') {
        leave(a);
        return {};
      }
      return take(a);
    },
    finish(a) {
      fetching = false;
      if (glide) glide.t = 1;
      if (glide) this.frame(a, 0);
    },
    cancel() {
      fetching = false;
    },
    frame(a, dt) {
      const w = a.walker;
      let busy = false;
      hideAgain();
      // Walked to a bike to take it: taken on arrival.
      if (fetching && !w.route) take(a, true);
      if (glide) {
        glide.t = Math.min(1, glide.t + dt / TAKE);
        const s = glide.t * glide.t * (3 - 2 * glide.t);
        const [fx, fz, fh] = glide.from;
        const [tx, tz, th] = glide.to;
        [w.x, w.z] = [fx + (tx - fx) * s, fz + (tz - fz) * s];
        w.heading = wrap(fh + wrap(th - fh) * s);
        [w.speed, w.accel, w.turning] = [0, 0, 0];
        busy = true;
        if (glide.t === 1) {
          if (glide.on) a.mode = 'bike';
          glide = null;
        }
      }
      const riding = a.mode === 'bike' && !glide;
      if (riding) {
        place(a, dt);
        const was = wheel;
        wheel += (w.speed * dt) / (WHEEL * SCALE);
        if (wheel !== was) sounds.freewheel(wheel, w.speed, w.accel <= 0);
      }
      rider.visible = riderInk.visible = riderXray.visible = riding && shown;
      const near = !riding && !a.place && nearest(w.x, w.z, NEAR) !== null;
      publish(a.mode === 'bike' ? 'riding' : near ? 'near' : '');
      return busy;
    },
    show(near) {
      shown = near;
      standing.visible = near && dropped.length > 0;
    },
    dispose() {
      for (const mesh of [rider, riderInk, riderXray, standing]) scene.remove(mesh);
      xray.dispose();
      bodyGeometry.dispose();
      hullGeometry.dispose();
      standing.geometry.dispose();
      material.dispose();
      inkMaterial.dispose();
      loose.length = 0;
    },
  };
}
