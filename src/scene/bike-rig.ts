/**
 * The bike someone rides: a city bike of chunky beams in the figure's style, each under an ink
 * hull (an inverted copy a little larger, so only its far side shows round the silhouette), on a
 * seven-bone rig: the frame, the bars and fork that steer, both wheels, the crank and its two
 * pedals. Life-size metres, drawn 1.3× like the figure; v (here z) forward from between the
 * wheels, y up. Pure arrays, so the ride chunk needs nothing of the engine's to build it, and a
 * bike left on its stand bakes into the same arrays posed where it stands.
 *
 * It wears the look of the parked bike it was taken from (`LOOK` in props.ts: a step-through or
 * a diamond frame, a carrier or a crate, its colour), in the colours the racks use.
 */

import { BIKES, OUTLINE, PROPS } from './palette.ts';

/** A parked bike's look, packed in a byte, as props.ts packs it. */
export const LOOK = { step: 1, carrier: 2, crate: 4, basket: 8, colour: 16 } as const;
/** The bike's parts, in the colours of the parked bikes: one palette (palette.ts), no copies. */
export const PARTS = {
  tyre: PROPS.wheel,
  spokes: PROPS.spokes,
  iron: PROPS.iron,
  crate: PROPS.crate,
  crateInside: PROPS.crateInside,
  ink: OUTLINE,
  lantern: PROPS.lantern,
  /** A tan saddle and grips: warm, like the walker's summer. */
  leather: PROPS.wood,
} as const;
export const BIKE_BONES = ['frame', 'steer', 'front', 'rear', 'crank', 'pedalL', 'pedalR'] as const;
export type BikeBone = (typeof BIKE_BONES)[number];

/** Half the wheelbase, the steering axis and the wheels' radius, as the parked bikes (m). */
export const AXLE = 0.55;
export const STEERING = 0.37;
export const WHEEL = 0.34;
/** The bottom bracket, and a crank's length (m). */
export const BRACKET = [-0.05, 0.3] as const;
export const CRANK = 0.17;
/** Where the pedals sit either side of the frame (m). */
export const PEDAL_X = 0.14;
/** The saddle's top and middle, for the figure's 0.82 m legs; the grips (m). */
export const SADDLE = [-0.25, 0.86] as const;
export const GRIPS = { x: 0.29, y: 1.0, z: 0.17 } as const;
/** Ink outline thickness (m): the figure's. */
const INK = 0.035;

/** Each bone's parent (-1 for none) and pivot relative to it. */
export const BIKE_JOINTS: Record<BikeBone, readonly [number, number, number, number]> = {
  frame: [-1, 0, 0, 0],
  steer: [0, 0, 0, STEERING],
  front: [1, 0, WHEEL, AXLE - STEERING],
  rear: [0, 0, WHEEL, -AXLE],
  crank: [0, 0, BRACKET[1], BRACKET[0]],
  pedalL: [4, PEDAL_X, -CRANK, 0],
  pedalR: [4, -PEDAL_X, CRANK, 0],
};

type V3 = readonly [number, number, number];

export interface BikeArrays {
  position: Float32Array;
  normal: Float32Array;
  color: Float32Array;
  /** Each vertex's bone (index into `BIKE_BONES`). */
  bone: Uint8Array;
  /** 1 for the blob shadow, which the figure's material draws as a checkerboard. */
  dither: Uint8Array;
  index: Uint16Array;
}

/** Collects faces, each turned to face its hint, with flat normals. */
class Faces {
  position: number[] = [];
  normal: number[] = [];
  color: number[] = [];
  bone: number[] = [];
  dither: number[] = [];
  index: number[] = [];

  /** A planar polygon, fanned from its first corner, facing `hint`. */
  polygon(corners: readonly V3[], hint: V3, color: number, bone: number, dither = 0): void {
    const [a, b, c] = corners as [V3, V3, V3];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [
      u[1]! * v[2]! - u[2]! * v[1]!,
      u[2]! * v[0]! - u[0]! * v[2]!,
      u[0]! * v[1]! - u[1]! * v[0]!,
    ];
    const flip = n[0]! * hint[0] + n[1]! * hint[1] + n[2]! * hint[2] < 0;
    const length = Math.hypot(n[0]!, n[1]!, n[2]!) * (flip ? -1 : 1);
    n = n.map((x) => x / length);
    const first = this.position.length / 3;
    for (const p of corners) {
      this.position.push(...p);
      this.normal.push(...n);
      this.color.push(((color >> 16) & 255) / 255, ((color >> 8) & 255) / 255, (color & 255) / 255);
      this.bone.push(bone);
      this.dither.push(dither);
    }
    for (let i = 1; i + 1 < corners.length; i++) {
      if (flip) this.index.push(first, first + i + 1, first + i);
      else this.index.push(first, first + i, first + i + 1);
    }
  }

  /**
   * A beam from `a` to `b`, `w` across and `h` deep, its ends capped or not (hidden in another
   * part), under an ink hull unless `ink` is false.
   */
  beam(
    a: V3,
    b: V3,
    w: number,
    h: number,
    color: number,
    bone: number,
    ink = true,
    caps = true,
  ): void {
    const d = sub(b, a);
    const length = Math.hypot(...d);
    const along = d.map((x) => x / length) as unknown as V3;
    // Across: x, unless the beam runs across (the bars), then up.
    const seed: V3 = Math.abs(along[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const side = norm(sub(seed, scale(along, dot(seed, along))));
    const up = cross(along, side);
    const box = (grow: number, inward: boolean, c: number) => {
      const corner = (s: number, t: number, end: number): V3 => {
        const p = end ? add(b, scale(along, grow)) : sub(a, scale(along, grow));
        return add(add(p, scale(side, s * (w / 2 + grow))), scale(up, t * (h / 2 + grow)));
      };
      const out = (n: V3): V3 => (inward ? scale(n, -1) : n);
      const ring = [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ] as const;
      for (let i = 0; i < 4; i++) {
        const [s0, t0] = ring[i]!;
        const [s1, t1] = ring[(i + 1) % 4]!;
        const n = add(scale(side, s0 + s1), scale(up, t0 + t1));
        this.polygon(
          [corner(s0, t0, 0), corner(s1, t1, 0), corner(s1, t1, 1), corner(s0, t0, 1)],
          out(n),
          c,
          bone,
        );
      }
      if (!caps) return;
      for (const end of [0, 1]) {
        const corners = ring.map(([s, t]) => corner(s, t, end));
        this.polygon(corners, out(scale(along, end ? 1 : -1)), c, bone);
      }
    };
    box(0, false, color);
    if (ink) box(INK, true, PARTS.ink);
  }

  arrays(): BikeArrays {
    return {
      position: Float32Array.from(this.position),
      normal: Float32Array.from(this.normal),
      color: Float32Array.from(this.color),
      bone: Uint8Array.from(this.bone),
      dither: Uint8Array.from(this.dither),
      index: Uint16Array.from(this.index),
    };
  }
}

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: V3): V3 => scale(a, 1 / Math.hypot(...a));

/** A point in the bike's side plane, at v forward and y up. */
const P = (v: number, y: number, x = 0): V3 => [x, y, v];

/** Where each bone's pivot is in the bike's rest pose: its parents' pivots added up. */
export function bonePivot(bone: number): V3 {
  let at: V3 = [0, 0, 0];
  for (let b = bone; b >= 0; b = BIKE_JOINTS[BIKE_BONES[b]!][0]) {
    const [, x, y, z] = BIKE_JOINTS[BIKE_BONES[b]!];
    at = add(at, [x, y, z]);
  }
  return at;
}

const bone = (name: BikeBone) => BIKE_BONES.indexOf(name);

/** A point on the circle of radius `r` round (v, y) in the bike's side plane, `t` up from ahead. */
const round = (v: number, y: number, r: number, t: number, x = 0): V3 =>
  P(v + Math.cos(t) * r, y + Math.sin(t) * r, x);

/** An arc of three beams round a wheel's axle at v, from angle t0 to t1, unlined: a mudguard. */
function arc(f: Faces, v: number, r: number, [t0, t1]: readonly [number, number], on: number) {
  const n = 3;
  for (let i = 0; i < n; i++) {
    const [a, b] = [t0 + ((t1 - t0) * i) / n, t0 + ((t1 - t0) * (i + 1)) / n];
    f.beam(round(v, WHEEL, r, a), round(v, WHEEL, r, b), 0.08, 0.015, PARTS.iron, on, false, false);
  }
}

/**
 * The rideable bike for a parked bike's `look`, in its rest pose: wheels and crank unturned (the
 * left pedal down), bars straight. 650 to 700 triangles with its ink, and a blob shadow.
 */
export function bikeArrays(look: number): BikeArrays {
  const f = new Faces();
  const colour = BIKES[Math.floor(look / LOOK.colour) % BIKES.length]!;
  const [frame, steer, crank] = [bone('frame'), bone('steer'), bone('crank')];

  // The wheels: an octagonal tyre of beams round each axle, a hub, and twelve spokes (six
  // beams across) that show it turn; a mudguard over each, the front one turning with the bars.
  for (const [name, v, guard] of [
    ['rear', -AXLE, [0.75, 3.5]],
    ['front', AXLE, [0.15, 2.8]],
  ] as const) {
    const b = bone(name);
    const rim = (i: number) => round(v, WHEEL, WHEEL - 0.02, ((i + 0.5) * Math.PI) / 4);
    for (let i = 0; i < 8; i++) f.beam(rim(i), rim(i + 1), 0.06, 0.06, PARTS.tyre, b, true, false);
    for (let i = 0; i < 6; i++) {
      const t = (i * Math.PI) / 6;
      const r = WHEEL - 0.05;
      f.beam(
        round(v, WHEEL, r, t),
        round(v, WHEEL, -r, t),
        0.012,
        0.02,
        PARTS.spokes,
        b,
        false,
        false,
      );
    }
    f.beam(P(v, WHEEL, -0.05), P(v, WHEEL, 0.05), 0.05, 0.05, PARTS.spokes, b, false);
    arc(f, v, WHEEL + 0.04, guard, name === 'rear' ? frame : steer);
  }

  // The frame: chain and seat stays to the rear axle, the seat tube, a diamond's top tube or a
  // step-through's low one, and the down tube to the head.
  const rear = P(-AXLE, WHEEL);
  const seat = P(SADDLE[0] + 0.02, SADDLE[1] - 0.06);
  const bracket = P(BRACKET[0], BRACKET[1]);
  const head = P(STEERING - 0.02, 0.86);
  const headLow = P(STEERING, 0.64);
  f.beam(rear, bracket, 0.045, 0.045, colour, frame, true, false);
  f.beam(rear, seat, 0.045, 0.045, colour, frame, true, false);
  f.beam(bracket, seat, 0.06, 0.06, colour, frame, true, false);
  if (look & LOOK.step)
    f.beam(P(-0.14, 0.48), P(STEERING - 0.01, 0.7), 0.06, 0.06, colour, frame, true, false);
  else f.beam(seat, head, 0.055, 0.055, colour, frame, true, false);
  f.beam(bracket, headLow, 0.065, 0.065, colour, frame, true, false);
  // The saddle, a tan wedge on the seat post.
  f.beam(
    P(SADDLE[0] - 0.12, SADDLE[1] - 0.025),
    P(SADDLE[0] + 0.13, SADDLE[1] - 0.025),
    0.15,
    0.05,
    PARTS.leather,
    frame,
  );

  // The fork and stem, from the front axle up through the head, and the bars across, all of
  // which turn with the steering (their pivot is on the steering axis).
  const S = (v: number, y: number, x = 0): V3 => P(v, y, x);
  f.beam(S(AXLE, WHEEL), S(STEERING - 0.04, 1.0), 0.05, 0.05, colour, steer, true, false);
  f.beam(
    S(GRIPS.z, GRIPS.y, -GRIPS.x - 0.04),
    S(GRIPS.z, GRIPS.y, GRIPS.x + 0.04),
    0.045,
    0.045,
    PARTS.iron,
    steer,
  );
  // Tan grips over the bars' ends, and a silver bell by the left one. Unlined: they're small.
  for (const side of [1, -1]) {
    const [a, b] = [side * (GRIPS.x - 0.06), side * (GRIPS.x + 0.05)];
    f.beam(S(GRIPS.z, GRIPS.y, a), S(GRIPS.z, GRIPS.y, b), 0.06, 0.06, PARTS.leather, steer, false);
  }
  f.beam(
    S(GRIPS.z + 0.02, GRIPS.y + 0.02, GRIPS.x - 0.12),
    S(GRIPS.z + 0.02, GRIPS.y + 0.07, GRIPS.x - 0.12),
    0.06,
    0.06,
    PARTS.spokes,
    steer,
    false,
  );

  // The lamp, its lens facing ahead: on the fork crown, or under a crate on its carrier.
  const crate = look & LOOK.crate;
  const lamp = crate ? 0.7 : 0.44;
  f.beam(P(lamp, 0.73), P(lamp + 0.08, 0.73), 0.07, 0.06, PARTS.tyre, crate ? frame : steer, false);
  f.polygon(
    [
      P(lamp + 0.081, 0.71, -0.025),
      P(lamp + 0.081, 0.71, 0.025),
      P(lamp + 0.081, 0.75, 0.025),
      P(lamp + 0.081, 0.75, -0.025),
    ],
    [0, 0, 1],
    PARTS.lantern,
    crate ? frame : steer,
  );
  // A red reflector facing back: on the carrier's end, or the rear mudguard's.
  const back = look & LOOK.carrier && !crate ? -AXLE - 0.125 : -AXLE - WHEEL - 0.03;
  const high = look & LOOK.carrier && !crate ? WHEEL * 2 + 0.02 : WHEEL + 0.16;
  f.polygon(
    [
      P(back, high, 0.04),
      P(back, high, -0.04),
      P(back, high - 0.06, -0.04),
      P(back, high - 0.06, 0.04),
    ],
    [0, 0, -1],
    PARTS.crate,
    frame,
  );

  if (crate) {
    // A red crate on a carrier fixed to the frame over the front wheel, its inside dark.
    f.beam(P(0.5, 0.78), P(0.5, 1.0), 0.36, 0.32, PARTS.crate, frame, true, false);
    f.polygon(
      [P(0.36, 1.005, -0.17), P(0.64, 1.005, -0.17), P(0.64, 1.005, 0.17), P(0.36, 1.005, 0.17)],
      [0, 1, 0],
      PARTS.crateInside,
      frame,
    );
  } else if (look & LOOK.basket) {
    // A wicker basket hung on the bars, turning with them, its inside dark.
    f.beam(S(0.55, 0.8), S(0.55, 1.02), 0.32, 0.24, PARTS.leather, steer, true, false);
    f.polygon(
      [S(0.44, 1.025, -0.15), S(0.66, 1.025, -0.15), S(0.66, 1.025, 0.15), S(0.44, 1.025, 0.15)],
      [0, 1, 0],
      PARTS.crateInside,
      steer,
    );
  } else if (look & LOOK.carrier) {
    // A carrier over the rear wheel, on a stay each side from the axle.
    const top = WHEEL * 2 + 0.06;
    f.beam(P(-AXLE - 0.12, top), P(SADDLE[0] - 0.1, top), 0.18, 0.03, PARTS.iron, frame);
    for (const side of [1, -1]) {
      f.beam(
        P(-AXLE, WHEEL, side * 0.06),
        P(-AXLE - 0.1, top, side * 0.07),
        0.015,
        0.015,
        PARTS.iron,
        frame,
        false,
        false,
      );
    }
  }

  // The crank: a chainring and two arms; the pedals stay level as it turns. No ink: they're small.
  const ring = Array.from({ length: 6 }, (_, i): V3 => {
    const t = (i * Math.PI) / 3;
    return P(BRACKET[0] + Math.cos(t) * 0.1, BRACKET[1] + Math.sin(t) * 0.1, -0.05);
  });
  f.polygon(ring, [-1, 0, 0], PARTS.iron, crank);
  // The chain on the right, round the chainring and the rear sprocket, and a black guard over
  // its top run and the ring, seen from the right only.
  for (const [ry, cy] of [
    [0.1, 0.045],
    [-0.1, -0.045],
  ] as const) {
    f.beam(
      P(BRACKET[0], BRACKET[1] + ry, -0.05),
      P(-AXLE, WHEEL + cy, -0.05),
      0.012,
      0.02,
      PARTS.iron,
      frame,
      false,
      false,
    );
  }
  f.polygon(
    [
      P(0.07, 0.34, -0.075),
      P(0, 0.43, -0.075),
      P(-0.5, 0.41, -0.075),
      P(-0.52, 0.36, -0.075),
      P(-0.05, 0.3, -0.075),
    ],
    [-1, 0, 0],
    PARTS.tyre,
    frame,
  );
  for (const side of [1, -1]) {
    const x = side * (PEDAL_X - 0.03);
    f.beam(
      P(BRACKET[0], BRACKET[1], x),
      P(BRACKET[0], BRACKET[1] - side * CRANK, x),
      0.025,
      0.035,
      PARTS.iron,
      crank,
      false,
    );
    const pedal = bone(side > 0 ? 'pedalL' : 'pedalR');
    const y = BRACKET[1] - side * CRANK;
    f.beam(
      P(BRACKET[0] - 0.05, y, side * PEDAL_X),
      P(BRACKET[0] + 0.05, y, side * PEDAL_X),
      0.09,
      0.025,
      PARTS.tyre,
      pedal,
      false,
    );
  }

  // The blob shadow: a long octagon under both wheels.
  const blob = Array.from({ length: 8 }, (_, i): V3 => {
    const t = (i * Math.PI) / 4;
    return [Math.sin(t) * 0.3, 0.02, Math.cos(t) * 0.95];
  });
  f.polygon(blob, [0, 1, 0], PARTS.ink, frame, 1);
  return f.arrays();
}

/** Where a bike stands, as `bakeBike` places it: on the ground, its heading, lean and bars. */
export interface Stand {
  x: number;
  y: number;
  z: number;
  heading: number;
  /** Lean toward +x from +z (radians), and the bars' turn. */
  lean: number;
  steer: number;
  look: number;
}

/**
 * A bike left on its stand, baked: the rest pose with its bars turned, scaled up, leaned, turned
 * and placed, all on bone 0, so bikes left about the city share one mesh and one draw call.
 * Written into `into` after the vertices and indices already there (`at`).
 */
export function bakeBike(
  stand: Stand,
  scaleBy: number,
  into: BikeArrays,
  at: { vertices: number; indices: number },
): void {
  const bike = bikeArrays(stand.look);
  const pivot = bonePivot(BIKE_BONES.indexOf('steer'));
  const [cs, ss] = [Math.cos(stand.steer), Math.sin(stand.steer)];
  const [cl, sl] = [Math.cos(stand.lean), Math.sin(stand.lean)];
  const [ch, sh] = [Math.cos(stand.heading), Math.sin(stand.heading)];
  const place = (
    src: Float32Array,
    i: number,
    on: number,
    point: boolean,
    out: Float32Array,
    o: number,
  ) => {
    let [x, y, z] = [src[i]!, src[i + 1]!, src[i + 2]!];
    if (on === 1 || on === 2) {
      // The bars and front wheel turn about the steering axis.
      const [dx, dz] = point ? [x - pivot[0], z - pivot[2]] : [x, z];
      [x, z] = [dx * cs + dz * ss, -dx * ss + dz * cs];
      if (point) [x, z] = [x + pivot[0], z + pivot[2]];
    }
    if (point) [x, y, z] = [x * scaleBy, y * scaleBy, z * scaleBy];
    // Lean about the forward axis (toward +x is a positive lean), then turn to the heading.
    [x, y] = [x * cl + y * sl, -x * sl + y * cl];
    [x, z] = [x * ch + z * sh, -x * sh + z * ch];
    out[o] = x + (point ? stand.x : 0);
    out[o + 1] = y + (point ? stand.y : 0);
    out[o + 2] = z + (point ? stand.z : 0);
  };
  const n = bike.bone.length;
  for (let v = 0; v < n; v++) {
    const o = (at.vertices + v) * 3;
    place(bike.position, v * 3, bike.bone[v]!, true, into.position, o);
    place(bike.normal, v * 3, bike.bone[v]!, false, into.normal, o);
    into.color.set(bike.color.subarray(v * 3, v * 3 + 3), o);
    into.bone[at.vertices + v] = 0;
    into.dither[at.vertices + v] = bike.dither[v]!;
  }
  for (let i = 0; i < bike.index.length; i++)
    into.index[at.indices + i] = bike.index[i]! + at.vertices;
  at.vertices += n;
  at.indices += bike.index.length;
}

/** The largest bike's vertex and index counts, for sizing baked arrays. */
export const BIKE_MOST = (() => {
  let [vertices, indices] = [0, 0];
  for (const look of [LOOK.crate, LOOK.basket, LOOK.carrier]) {
    const bike = bikeArrays(look);
    [vertices, indices] = [
      Math.max(vertices, bike.bone.length),
      Math.max(indices, bike.index.length),
    ];
  }
  return { vertices, indices };
})();
