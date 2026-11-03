import type { City } from '../data/city.ts';
import { pointInRing } from '../data/geometry.ts';
import { alongEdge } from '../data/traffic.ts';
import type {
  BackSide,
  BufferGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshToonMaterial,
  Texture,
  WebGLProgramParametersWithUniforms,
} from 'three';

import { AXLE, BIKES, BRACKET, CRANK, LOOK, PARTS, WHEEL, bikeArrays } from './bike-rig.ts';
import {
  ANKLE,
  ARM_SPREAD,
  BONES,
  CHARACTER_SCALE,
  OUTLINE_WIDTH,
  REST_HIPS,
  addSolid,
  details,
  figure,
  grown,
  shade,
} from './figure.ts';
import type { BoneName, Outfit } from './figure.ts';
import { THIGH, UPPER_ARM } from './limb.ts';
import type { MeshBuilder, V3 } from './mesh-builder.ts';
import { BUS, GUESTS, PROPS, WALKER, WINDOW } from './palette.ts';
import { LENGTH, STRIDE, TURN_RATE, Traffic, VEHICLE_KINDS, turnTowards } from './traffic.ts';
import type { Vehicle, VehicleKind } from './traffic.ts';

/**
 * The traffic, drawn: the vehicles' shapes, one instanced mesh per kind with an ink hull
 * sharing its matrices, and the layer that moves them each frame. This is the traffic chunk's
 * entry (traffic.ts is the simulation); the viewer loads it once the first frame is drawn and
 * hands it what it shares with the engine as a `kit`, like the furniture.
 *
 * Shapes are a few boxes each, in their own frame: x ahead, y up, z to the right. Vertex colours
 * carry what never changes; the `facade` attribute says what does, as a part code: PAINT takes
 * the instance's colour, HEAD and TAIL glow at night and the tail with the brakes, the SIGNALs
 * blink before a turn, the BEAM is the headlamps' pool on the street at night, and the LEGs and
 * ARMs swing with the stride (the code's fraction is the joint's height, in tenths of a metre).
 */
export const PART = {
  plain: 0,
  head: 1,
  tail: 2,
  paint: 3,
  signalL: 4,
  signalR: 5,
  beam: 6,
  legL: 7,
  legR: 8,
  armL: 9,
  armR: 10,
  /** The glow round a lamp at night, dithered out by the fraction: a headlamp's, a tail lamp's. */
  halo: 11,
  haloTail: 12,
  /** 7 to 10 were the box limbs of the far shapes, before they were the figure. */
} as const;

type Builder = Pick<MeshBuilder, 'quad' | 'triangle'>;

/**
 * Part codes from FIGURE up are the walker's figure (figure.ts), a bone each in BONES' order:
 * on foot from FIGURE, riding from RIDER; from BIKE up the bike's own bones (bike-rig.ts). The
 * fraction of such a code says which of the instance's colours a face takes (TINT), the face's
 * own colour saying how much of it (its shade).
 */
export const FIGURE = 16;
export const RIDER = 32;
export const BIKE = 48;
export const TINT = { shirt: 0.5, trim: 0.25, hair: 0.75, skin: 0.125 } as const;

/** The figure's size on the streets: the walker's, a third over life. */
const S = CHARACTER_SCALE;
/** A figure point (model metres, y up, facing +z) in a vehicle's frame (x ahead, z right). */
const toVehicle = ([x, y, z]: V3): V3 => [z * S, y * S, -x * S];
/** Where the figure's joints are, up from its feet (model metres): the shader turns about them. */
const SHOULDER_Y = REST_HIPS + 0.5;
const ELBOW_Y = SHOULDER_Y - UPPER_ARM;
const KNEE_Y = REST_HIPS - THIGH;
const NECK_Y = REST_HIPS + 0.56;
/** The figure dressed so each face says which of the instance's colours it takes: one channel each. */
const SENTINEL: Outfit = { shirt: 0xff0000, shorts: 0x00ff00, hair: 0x0000ff };
const MOUTH = shade(WALKER.skin, 0.62);
/** What the cyclists wear below the shirt: a khaki from the café guests' wardrobe. */
const RIDER_SHORTS = GUESTS.legs[2]!;

/**
 * What a face of the figure in the sentinel outfit carries: the tint it takes from the
 * instance (its shirt, its trim or its hair, by the channel its colour is in, or its skin) and
 * the colour it is written in, white times the shade for the shader to multiply, or its own
 * colour and no tint.
 */
export function tintOf(color: number): [tint: number, color: number] {
  const [r, g, b] = [(color >> 16) & 255, (color >> 8) & 255, color & 255];
  if (r && !g && !b) return [TINT.shirt, color];
  if (g && !r && !b) return [TINT.trim, color];
  if (b && !r && !g) return [TINT.hair, color];
  if (color === WALKER.skin) return [TINT.skin, 0xffffff];
  if (color === MOUTH) return [TINT.skin, 0x9e9e9e];
  return [0, color];
}

/** The arms hang a little out from the body, turned about the shoulder as the walker's are. */
function spread(p: V3, bone: BoneName): V3 {
  const side =
    bone === 'armL' || bone === 'foreL' ? 1 : bone === 'armR' || bone === 'foreR' ? -1 : 0;
  if (!side) return p;
  const [sx, sy] = [side * 0.27, SHOULDER_Y];
  const [c, sn] = [Math.cos(side * ARM_SPREAD), Math.sin(side * ARM_SPREAD)];
  const [dx, dy] = [p[0] - sx, p[1] - sy];
  return [sx + dx * c - dy * sn, sy + dx * sn + dy * c, p[2]];
}

/**
 * The walker's figure at its size, facing ahead, for the instanced people (`base` FIGURE) and
 * riders (RIDER): each face marked with its bone from `base` and the tint it takes. The hull
 * mesh gets the figure's ink hulls, grown, facing out (the hull material draws their backs).
 * `coarse` is the figure for the distance: its octagons squared off, without its flat details
 * or an outline, the same bones, proportions and colours, under half the faces.
 */
export function addFigure(mesh: Builder, base: number, hull: boolean, coarse = false): void {
  // A rider's trim is the bike's frame, so its shorts keep a colour of their own.
  const outfit = base === RIDER ? { ...SENTINEL, shorts: RIDER_SHORTS } : SENTINEL;
  for (const solid of figure(outfit)) {
    // The parts too small to outline (ears, thumbs, collar, belt, the shoe's upper) are too
    // small for the distance too, but for the neck, which keeps the head on the shoulders.
    const neck = solid.bone === 'torso' && solid.color === WALKER.skin;
    if ((hull || coarse) && solid.hull === false && !neck) continue;
    const full = hull ? grown(solid.hull || solid.rings, OUTLINE_WIDTH) : solid.rings;
    // Far off, each bevelled octagon is a square: the same figure, half the faces.
    const rings = coarse
      ? full.map((ring) => (ring.length === 8 ? ring.filter((_, i) => i % 2 === 0) : ring))
      : full;
    addSolid(mesh, solid, rings, false, {
      place: (p) => toVehicle(spread(p, solid.bone)),
      facade: (bone, color) => base + bone + (hull ? 0 : tintOf(color)[0]),
      paint: (color) => tintOf(color)[1],
    });
  }
  if (hull || coarse) return;
  for (const { bone, color, points, normal } of details(outfit)) {
    const [tint, c] = tintOf(color);
    const facade = base + BONES.indexOf(bone) + tint;
    const [a, b, d, e] = points.map((p) => toVehicle(spread(p, bone))) as [V3, V3, V3, V3?];
    const hint = toVehicle(normal);
    if (e) mesh.quad(a, b, d, e, c, hint, facade);
    else mesh.triangle(a, b, d, c, hint, facade);
  }
}

/** The i-th point or normal of a bike's arrays, in the vehicle's frame. */
const v3 = (a: Float32Array, i: number): V3 => toVehicle([a[i * 3]!, a[i * 3 + 1]!, a[i * 3 + 2]!]);

/** The cyclists' bike: the rideable one of bike-rig.ts, a diamond frame with a carrier. */
const CYCLIST_LOOK = LOOK.carrier;
/** The colour that bike's frame is built in, which the instance's trim replaces. */
const CYCLIST_FRAME = BIKES[Math.floor(CYCLIST_LOOK / LOOK.colour) % BIKES.length]!;

/**
 * The bike of bike-rig.ts at the figure's size, facing ahead, each face marked with its bone
 * from BIKE: its body in the body mesh with the frame taking the instance's trim and the lamp
 * and reflector lit as a car's are, its ink hulls turned outward in the hull mesh, its blob
 * shadow in neither.
 */
export function addRiddenBike(mesh: Builder, hull: boolean): void {
  const bike = bikeArrays(CYCLIST_LOOK);
  const hex = (i: number) =>
    (Math.round(bike.color[i * 3]! * 255) << 16) |
    (Math.round(bike.color[i * 3 + 1]! * 255) << 8) |
    Math.round(bike.color[i * 3 + 2]! * 255);
  for (let t = 0; t < bike.index.length; t += 3) {
    const [i, j, k] = [bike.index[t]!, bike.index[t + 1]!, bike.index[t + 2]!];
    if (bike.dither[i] || !!bike.hull[i] !== hull) continue;
    const n = v3(bike.normal, i);
    const hint: V3 = hull ? [-n[0], -n[1], -n[2]] : n;
    const color = hex(i);
    const [tint, c] = color === CYCLIST_FRAME ? [TINT.trim, 0xffffff] : [0, color];
    const part =
      hull || !(color === PARTS.lantern || color === PARTS.crate)
        ? BIKE + bike.bone[i]! + tint
        : color === PARTS.lantern
          ? PART.head
          : PART.tail;
    mesh.triangle(v3(bike.position, i), v3(bike.position, j), v3(bike.position, k), c, hint, part);
  }
  // The lamp on the fork crown and the reflector on the carrier's end, lit (bike-rig.ts).
  if (!hull) bikeLight(mesh, 0.52 * S, 0.73 * S, (-AXLE - 0.125) * S, (2 * WHEEL + 0.02) * S);
}

/**
 * The walker's gait and the rider's pedalling, as the shader swings the figure's joints: each
 * over one cycle as three harmonics (the mean, then a cosine and sine pair for each), fitted to
 * the walker's `poseAt` and the rider's `rideAt` by scripts/gait-fit.ts. Thigh, knee and foot
 * of the left leg; the right is half a cycle on. In the walker's own signs.
 */
export const GAIT = {
  walk: {
    thigh: [-0.32, -0.01, -0.684, -0.199, -0.149, -0.131, -0.032],
    knee: [0.767, 0.088, -0.036, 0.453, 0.018, 0.265, 0.056],
    foot: [-0.322, -0.018, 0.545, -0.332, 0.105, -0.129, 0.013],
  },
  ride: {
    thigh: [-0.88, 0.399, -0.263, -0.008, 0.054, 0.013, -0.006],
    knee: [1.438, -0.702, -0.124, -0.019, -0.007, -0.016, -0.009],
    foot: [-0.308, 0.304, 0.537, 0.026, -0.048, 0.002, 0.015],
  },
} as const;
/** How many turns a wheel makes to a pedal turn: a city bike's gearing, from the stride, at the drawn wheel's size. */
const GEAR = STRIDE.bike / (2 * Math.PI * WHEEL * S);

const glsl = (x: number) => x.toFixed(3);
/** A joint's harmonics as GLSL, its swing (all but the mean) scaled by `sweep`. */
const harm = (c: readonly number[], sweep = 1) =>
  `harm(${c.map((x, i) => glsl(i ? x * sweep : x)).join(', ')}, q)`;
/**
 * The walker's gait was fitted at its own stride (STRIDE_WALK, 2.6 m a cycle); a stroller's
 * stride is shorter (STRIDE.person), so the legs swing less, and the feet keep to the ground.
 */
const STROLL = STRIDE.person / 2.6;
/**
 * The walker's hips ride where its longer stride's reach puts them; with the swing scaled down
 * the legs stand straighter, so the hips sit this much higher (model metres) for the soles to
 * meet the ground rather than sink through it.
 */
const STROLL_LIFT = 0.045;

/**
 * The figure's bones swung about their joints in the vertex shader, by the stride (`state.x`,
 * radians): on foot the walker's gait, riding the pedalling, with the hips on the saddle, the
 * torso over the bars and the arms to them; the bike's wheels and crank turn with it, the
 * pedals staying level. Each chain turns about its own joint first, then its parents', as the
 * walker's skeleton does; the swings carry the walker's signs negated, since here a positive
 * turn carries a limb's end ahead.
 */
const FIGURE_GLSL = `
  bool bike = part >= ${BIKE}.0;
  bool rider = part >= ${RIDER}.0 && !bike;
  int bone = int(part) - (bike ? ${BIKE} : rider ? ${RIDER} : ${FIGURE});
  float p = state.x;
  if (bike) {
    float w = -p * ${glsl(GEAR)};
    if (bone == 2) turn(transformed, ${glsl(AXLE * S)}, ${glsl(WHEEL * S)}, w);
    else if (bone == 3) turn(transformed, ${glsl(-AXLE * S)}, ${glsl(WHEEL * S)}, w);
    else if (bone >= 4) {
      if (bone == 5) turn(transformed, ${glsl(BRACKET[0] * S)}, ${glsl((BRACKET[1] - CRANK) * S)}, p);
      if (bone == 6) turn(transformed, ${glsl(BRACKET[0] * S)}, ${glsl((BRACKET[1] + CRANK) * S)}, p);
      turn(transformed, ${glsl(BRACKET[0] * S)}, ${glsl(BRACKET[1] * S)}, -p);
    }
  } else {
    bool left = bone == 4 || bone == 6 || bone == 8 || bone == 10 || bone == 12;
    float q = (rider ? -p : p) + (left ? 0.0 : PI);
    float thigh, knee, foot, arm, elbow, lean, nod, hipY, hipX;
    if (rider) {
      thigh = -${harm(GAIT.ride.thigh)}; knee = -${harm(GAIT.ride.knee)}; foot = -${harm(GAIT.ride.foot)};
      arm = 0.26; elbow = 1.151; lean = -0.4; nod = 0.34; hipY = 0.92; hipX = -0.22;
    } else {
      thigh = -${harm(GAIT.walk.thigh, STROLL)}; knee = -${harm(GAIT.walk.knee, STROLL)}; foot = -${harm(GAIT.walk.foot, STROLL)};
      arm = -0.55 * sin(q); elbow = 0.431 - 0.175 * sin(q) - 0.074 * cos(2.0 * q);
      lean = -0.07; nod = 0.0; hipY = ${glsl(0.711 + STROLL_LIFT)} + 0.034 * cos(2.0 * p); hipX = 0.0;
    }
    if (bone >= 12) turn(transformed, 0.0, ${glsl(ANKLE * S)}, foot);
    if (bone >= 10) turn(transformed, 0.0, ${glsl(KNEE_Y * S)}, knee);
    if (bone >= 8) turn(transformed, 0.0, ${glsl(REST_HIPS * S)}, thigh);
    if (bone == 6 || bone == 7) turn(transformed, 0.0, ${glsl(ELBOW_Y * S)}, elbow);
    if (bone >= 4 && bone <= 7) turn(transformed, 0.0, ${glsl(SHOULDER_Y * S)}, arm);
    if (bone == 3) turn(transformed, 0.0, ${glsl(NECK_Y * S)}, nod);
    if (bone >= 2 && bone <= 7) turn(transformed, 0.0, ${glsl(REST_HIPS * S)}, lean);
    if (bone > 0) { transformed.y += (hipY - ${glsl(REST_HIPS)}) * ${glsl(S)}; transformed.x += hipX * ${glsl(S)}; }
  }`;

const c = (x: number, y: number, z: number): V3 => [x, y, z];

/** Which faces of a box to write. The bottom is left out unless asked: nobody sees it. */
export const FACE = { top: 1, bottom: 2, front: 4, back: 8, right: 16, left: 32 } as const;
const ALL_BUT_BOTTOM = FACE.top | FACE.front | FACE.back | FACE.right | FACE.left;

/** An axis-aligned box in one colour, with one part code, as many of its faces as asked. */
export function boxOf(
  mesh: Builder,
  [x0, x1]: readonly [number, number],
  [y0, y1]: readonly [number, number],
  [z0, z1]: readonly [number, number],
  color: number,
  part = PART.plain as number,
  faces: number = ALL_BUT_BOTTOM,
): void {
  if (faces & FACE.top)
    mesh.quad(c(x0, y1, z0), c(x1, y1, z0), c(x1, y1, z1), c(x0, y1, z1), color, [0, 1, 0], part);
  if (faces & FACE.front)
    mesh.quad(c(x1, y0, z0), c(x1, y0, z1), c(x1, y1, z1), c(x1, y1, z0), color, [1, 0, 0], part);
  if (faces & FACE.back)
    mesh.quad(c(x0, y0, z1), c(x0, y0, z0), c(x0, y1, z0), c(x0, y1, z1), color, [-1, 0, 0], part);
  if (faces & FACE.right)
    mesh.quad(c(x0, y0, z1), c(x1, y0, z1), c(x1, y1, z1), c(x0, y1, z1), color, [0, 0, 1], part);
  if (faces & FACE.left)
    mesh.quad(c(x1, y0, z0), c(x0, y0, z0), c(x0, y1, z0), c(x1, y1, z0), color, [0, 0, -1], part);
  if (faces & FACE.bottom)
    mesh.quad(c(x0, y0, z1), c(x0, y0, z0), c(x1, y0, z0), c(x1, y0, z1), color, [0, -1, 0], part);
}

/** A box whose top is smaller than its base: a cabin with sloping glass, a cap. */
function taper(
  mesh: Builder,
  base: readonly [x0: number, x1: number, z0: number, z1: number],
  top: readonly [x0: number, x1: number, z0: number, z1: number],
  [y0, y1]: readonly [number, number],
  sides: number,
  cap: number,
  sidePart = PART.plain as number,
  capPart = PART.plain as number,
): void {
  const [bx0, bx1, bz0, bz1] = base;
  const [tx0, tx1, tz0, tz1] = top;
  mesh.quad(
    c(tx0, y1, tz0),
    c(tx1, y1, tz0),
    c(tx1, y1, tz1),
    c(tx0, y1, tz1),
    cap,
    [0, 1, 0],
    capPart,
  );
  mesh.quad(
    c(bx1, y0, bz0),
    c(bx1, y0, bz1),
    c(tx1, y1, tz1),
    c(tx1, y1, tz0),
    sides,
    [1, 0.5, 0],
    sidePart,
  );
  mesh.quad(
    c(bx0, y0, bz1),
    c(bx0, y0, bz0),
    c(tx0, y1, tz0),
    c(tx0, y1, tz1),
    sides,
    [-1, 0.5, 0],
    sidePart,
  );
  mesh.quad(
    c(bx0, y0, bz1),
    c(bx1, y0, bz1),
    c(tx1, y1, tz1),
    c(tx0, y1, tz1),
    sides,
    [0, 0.5, 1],
    sidePart,
  );
  mesh.quad(
    c(bx1, y0, bz0),
    c(bx0, y0, bz0),
    c(tx0, y1, tz0),
    c(tx1, y1, tz0),
    sides,
    [0, 0.5, -1],
    sidePart,
  );
}

/** A small quad flat on an end face (x = `x`, facing ahead or back) in a part's colour. */
function lampAt(
  mesh: Builder,
  x: number,
  y: number,
  z: number,
  part: number,
  color: number,
  half: readonly [number, number] = [0.1, 0.16],
): void {
  const dir = x > 0 ? 1 : -1;
  const p = (dy: number, dz: number): V3 => [x + dir * 0.01, y + dy, z + dz];
  const [h, w] = half;
  const [a, b, d, e] = [p(-h, -w), p(-h, w), p(h, w), p(h, -w)];
  if (dir > 0) mesh.quad(a, b, d, e, color, [1, 0, 0], part);
  else mesh.quad(b, a, e, d, color, [-1, 0, 0], part);
}

/**
 * The headlamps' pool of light on the street ahead (drawn at night by the shader): from the
 * lamps to `to` metres, `nearHalf` wide there and `farHalf` at its end, brightest down the
 * middle and dithering away to its sides and its far end: three strips, each corner carrying
 * how bright it is in its part's fraction (1 - fade), so the pool has no hard edge.
 */
function beam(mesh: Builder, from: number, to: number, nearHalf: number, farHalf: number): void {
  const y = 0.02;
  const strip = (n0: number, n1: number, f0: number, f1: number, fades: readonly number[]) =>
    mesh.quad(
      c(from, y, n0),
      c(from, y, n1),
      c(to, y, f1),
      c(to, y, f0),
      BUS.headlamp,
      [0, 1, 0],
      fades.map((fade) => PART.beam + 1 - fade) as [number, number, number, number],
    );
  const [ni, fi] = [nearHalf * 0.5, farHalf * 0.5];
  strip(-ni, ni, -fi, fi, [1, 1, 0.1, 0.1]);
  strip(-nearHalf, -ni, -farHalf, -fi, [0.3, 1, 0.1, 0.02]);
  strip(ni, nearHalf, fi, farHalf, [1, 0.3, 0.02, 0.1]);
}

/** The glow round a lamp at night: a larger, dimmer quad just proud of it, dithered by `fade`. */
function halo(
  mesh: Builder,
  x: number,
  y: number,
  z: number,
  part: number,
  color: number,
  half: readonly [number, number],
  fade = 0.5,
): void {
  const dir = x > 0 ? 1 : -1;
  lampAt(mesh, x + dir * 0.015, y, z, part + 1 - fade, color, half);
}

/** A wheel: a dark box without its hidden top, a pale hub on its outer face. */
function wheel(
  mesh: Builder,
  x: number,
  z: number,
  radius: number,
  width: number,
  g: number,
): void {
  const side = Math.sign(z);
  boxOf(
    mesh,
    [x - radius * g, x + radius * g],
    [0, 2 * radius * g],
    [z - width * g, z + width * g],
    PROPS.wheel,
    PART.plain,
    FACE.front | FACE.back | FACE.right | FACE.left | FACE.bottom,
  );
  if (g !== 1) return;
  const [hx, hy, hz] = [x, radius, z + side * (width + 0.005)];
  const r = radius * 0.45;
  const p = (dx: number, dy: number): V3 => [hx + dx, hy + dy, hz];
  if (side > 0) mesh.quad(p(-r, -r), p(r, -r), p(r, r), p(-r, r), PROPS.spokes, [0, 0, 1]);
  else mesh.quad(p(r, -r), p(-r, -r), p(-r, r), p(r, r), PROPS.spokes, [0, 0, -1]);
}

const PLATE = 0xf1ede2;
const AMBER = 0xf0a020;

/** Each shape's ink hull: the same boxes grown a little, drawn inside out behind it. */
export const HULL_GROW = 1.06;
/** The dark of bumpers, grilles, wheel arches, mirrors and door seams. */
const TRIM = 0x2f2d2b;

/** A thin dark seam on a side face (z = `z`), from `y0` to `y1` at `x`: a door's edge. */
function seam(mesh: Builder, x: number, z: number, y0: number, y1: number): void {
  const side = Math.sign(z);
  const p = (dx: number, y: number): V3 => [x + dx, y, z + side * 0.005];
  const [a, b, e, d] = [p(-0.012, y0), p(0.012, y0), p(0.012, y1), p(-0.012, y1)];
  if (side > 0) mesh.quad(a, b, e, d, TRIM, [0, 0, 1]);
  else mesh.quad(b, a, d, e, TRIM, [0, 0, -1]);
}

/** A wing mirror on a stalk out from the side at `x`, `y`, over the body's edge `z`. */
function mirror(mesh: Builder, x: number, y: number, z: number, g: number): void {
  const side = Math.sign(z);
  boxOf(mesh, [x - 0.05, x + 0.05], [y, y + 0.03], [z, z + side * 0.14], TRIM);
  boxOf(
    mesh,
    [x - 0.1 * g, x + 0.1 * g],
    [y - 0.06 * g, y + 0.08 * g],
    [z + side * 0.12, z + side * 0.2 * g],
    TRIM,
  );
}

/**
 * A hatchback: a painted body with a bonnet and a boot, a cabin of sloping glass under a painted
 * roof with its pillars, four wheels with hubs in dark arches, wing mirrors, a grille and
 * bumpers, door seams, headlamps, tail lamps, indicators, number plates and a beam.
 */
export function addCar(mesh: Builder, g = 1, detail = false): void {
  boxOf(mesh, [-2.1 * g, 2.1 * g], [0.3, 0.82 * g], [-0.88 * g, 0.88 * g], 0xffffff, PART.paint);
  boxOf(
    mesh,
    [0.7 * g, 2.05 * g],
    [0.82 * g, 0.98 * g],
    [-0.84 * g, 0.84 * g],
    0xffffff,
    PART.paint,
  );
  boxOf(
    mesh,
    [-2.05 * g, -1.1 * g],
    [0.82 * g, 1.02 * g],
    [-0.84 * g, 0.84 * g],
    0xffffff,
    PART.paint,
  );
  taper(
    mesh,
    [-1.15 * g, 0.75 * g, -0.82 * g, 0.82 * g],
    [-0.95 * g, 0.35 * g, -0.7 * g, 0.7 * g],
    [0.82 * g, 1.48 * g],
    WINDOW.glass,
    0xffffff,
    PART.plain,
    PART.paint,
  );
  for (const x of [-1.35, 1.35]) for (const z of [-0.8, 0.8]) wheel(mesh, x, z, 0.33, 0.12, g);
  // Bumpers front and back, low and dark, a little proud of the body.
  for (const x of [-2.1, 2.1]) {
    boxOf(mesh, [x - 0.06, x + 0.06], [0.28, 0.44 * g], [-0.9 * g, 0.9 * g], TRIM);
  }
  if (g !== 1) return;
  // Near the view: dark arches round the wheels, pillars on the glass, mirrors, door seams.
  for (const z of detail ? [-0.88, 0.88] : []) {
    for (const x of [-1.35, 1.35]) {
      const side = Math.sign(z);
      const p = (dx: number, y: number): V3 => [x + dx, y, z + side * 0.004];
      const [a, b, e, d] = [p(-0.42, 0.3), p(0.42, 0.3), p(0.42, 0.74), p(-0.42, 0.74)];
      if (side > 0) mesh.quad(a, b, e, d, TRIM, [0, 0, 1]);
      else mesh.quad(b, a, d, e, TRIM, [0, 0, -1]);
    }
    seam(mesh, 0.25, z, 0.34, 0.8);
    seam(mesh, -0.75, z, 0.34, 0.8);
    mirror(mesh, 0.7, 1.0, z, g);
    // The pillar between the doors' windows, on the cabin's slope.
    const side = Math.sign(z);
    const at = (y: number) => side * (0.82 + ((0.7 - 0.82) * (y - 0.82)) / (1.48 - 0.82) + 0.006);
    const [a, b, e, d]: V3[] = [
      [-0.28, 0.83, at(0.83)],
      [-0.2, 0.83, at(0.83)],
      [-0.2, 1.46, at(1.46)],
      [-0.28, 1.46, at(1.46)],
    ];
    if (side > 0) mesh.quad(a!, b!, e!, d!, 0xffffff, [0, 0.5, 1], PART.paint);
    else mesh.quad(b!, a!, d!, e!, 0xffffff, [0, 0.5, -1], PART.paint);
  }
  for (const z of [-0.6, 0.6]) {
    lampAt(mesh, 2.1, 0.7, z, PART.head, BUS.headlamp);
    lampAt(mesh, -2.1, 0.7, z, PART.tail, BUS.taillamp);
    halo(mesh, 2.1, 0.7, z, PART.halo, BUS.headlamp, [0.17, 0.26]);
    halo(mesh, -2.1, 0.7, z, PART.haloTail, BUS.taillamp, [0.15, 0.24]);
    const signal = z < 0 ? PART.signalL : PART.signalR;
    lampAt(mesh, 2.1, 0.7, z + Math.sign(z) * 0.22, signal, AMBER, [0.06, 0.06]);
    lampAt(mesh, -2.1, 0.7, z + Math.sign(z) * 0.22, signal, AMBER, [0.06, 0.06]);
  }
  // The grille between the headlamps, and the number plates.
  lampAt(mesh, 2.1, 0.62, 0, PART.plain, TRIM, [0.08, 0.36]);
  lampAt(mesh, 2.1, 0.45, 0, PART.plain, PLATE, [0.06, 0.25]);
  lampAt(mesh, -2.1, 0.45, 0, PART.plain, PLATE, [0.06, 0.25]);
  beam(mesh, 2.1, 10, 0.9, 2.4);
}

/**
 * A city bus: a long cream body under a slightly inset roof with its air conditioning, a band
 * of windows between their pillars and a coloured stripe down each side, two doors, dark wheel
 * arches, wing mirrors, a windscreen under the destination board, a rear window, bumpers,
 * wheels, lamps, indicators and a beam.
 */
export function addBus(mesh: Builder, g = 1, detail = false): void {
  boxOf(mesh, [-6 * g, 6 * g], [0.45, 3.1 * g], [-1.25 * g, 1.25 * g], 0xffffff, PART.paint);
  boxOf(mesh, [-5.8 * g, 5.8 * g], [3.1 * g, 3.3 * g], [-1.1 * g, 1.1 * g], 0xffffff, PART.paint);
  boxOf(mesh, [-1.2 * g, 1.2 * g], [3.3 * g, 3.55 * g], [-0.8 * g, 0.8 * g], 0xd8d2c4);
  for (const x of [-4, 4]) for (const z of [-1.1, 1.1]) wheel(mesh, x, z, 0.5, 0.15, g);
  for (const x of [-6, 6]) {
    boxOf(mesh, [x - 0.06, x + 0.06], [0.42, 0.75 * g], [-1.27 * g, 1.27 * g], TRIM);
  }
  if (g !== 1) return;
  for (const side of [-1, 1]) {
    const z = side * 1.26;
    const n: V3 = [0, 0, side];
    const p = (x: number, y: number): V3 => [x, y, z];
    const band = (x0: number, x1: number, y0: number, y1: number, color: number, part = 0) => {
      if (side > 0) mesh.quad(p(x0, y0), p(x1, y0), p(x1, y1), p(x0, y1), color, n, part);
      else mesh.quad(p(x1, y0), p(x0, y0), p(x0, y1), p(x1, y1), color, n, part);
    };
    band(-5.6, 5.6, 1.7, 2.7, WINDOW.glass);
    band(-5.9, 5.9, 1.15, 1.45, BUS.band);
    // The doors, on the right: behind the front wheel and ahead of the rear one.
    if (side > 0) band(2.2, 3.4, 0.5, 2.7, 0x8a8f96);
    if (!detail) continue;
    // Near the view: the windows' pillars, dark wheel arches, the second door, a mirror.
    for (let x = -4.2; x < 5.6; x += 1.4) band(x - 0.05, x + 0.05, 1.7, 2.7, 0xffffff, PART.paint);
    for (const x of [-4, 4]) band(x - 0.62, x + 0.62, 0.45, 1.05, TRIM);
    if (side > 0) band(-2.6, -1.4, 0.5, 2.7, 0x8a8f96);
    mirror(mesh, 5.9, 2.3, z, g);
  }
  lampAt(mesh, 6, 2.2, 0, PART.plain, WINDOW.glass, [0.7, 1.1]);
  lampAt(mesh, 6, 2.95, 0, PART.plain, 0xf6e7b8, [0.12, 0.9]);
  lampAt(mesh, -6, 2.2, 0, PART.plain, WINDOW.glass, [0.5, 1.0]);
  for (const z of [-0.85, 0.85]) {
    lampAt(mesh, 6, 0.9, z, PART.head, BUS.headlamp, [0.12, 0.2]);
    lampAt(mesh, -6, 0.9, z, PART.tail, BUS.taillamp, [0.12, 0.2]);
    halo(mesh, 6, 0.9, z, PART.halo, BUS.headlamp, [0.22, 0.32]);
    halo(mesh, -6, 0.9, z, PART.haloTail, BUS.taillamp, [0.2, 0.3]);
    const signal = z < 0 ? PART.signalL : PART.signalR;
    lampAt(mesh, 6, 0.9, z + Math.sign(z) * 0.3, signal, AMBER, [0.08, 0.08]);
    lampAt(mesh, -6, 0.9, z + Math.sign(z) * 0.3, signal, AMBER, [0.08, 0.08]);
  }
  beam(mesh, 6, 14, 1.2, 2.8);
}

/** A flat wheel seen from both sides: a thin disc as two quads. */
function disc(mesh: Builder, x: number, radius: number, g: number): void {
  const [r, y] = [radius * g, radius * g];
  for (const side of [-1, 1]) {
    const p = (dx: number, dy: number): V3 => [x + dx, y + dy, side * 0.03 * g];
    if (side > 0) mesh.quad(p(-r, -r), p(r, -r), p(r, r), p(-r, r), PROPS.wheel, [0, 0, 1]);
    else mesh.quad(p(r, -r), p(-r, -r), p(-r, r), p(r, r), PROPS.wheel, [0, 0, -1]);
  }
}

/**
 * A city bike for the distance, at the figure's size: two wheels, a frame, bars and a saddle,
 * a lamp in front and a reflector behind, lit at night. Its rider is the coarse figure
 * (SHAPES.bike).
 */
export function addBike(mesh: Builder, g = 1): void {
  const k = S;
  for (const x of [-0.55, 0.55]) disc(mesh, x * k, 0.34 * k, g);
  boxOf(
    mesh,
    [-0.5 * k * g, 0.5 * k * g],
    [0.5 * k, 0.6 * k * g],
    [-0.04 * k * g, 0.04 * k * g],
    PROPS.iron,
  );
  boxOf(
    mesh,
    [0.42 * k * g, 0.5 * k * g],
    [0.6 * k * g, 1.02 * k * g],
    [-0.04 * k * g, 0.04 * k * g],
    PROPS.iron,
  );
  boxOf(
    mesh,
    [0.4 * k * g, 0.5 * k * g],
    [1.0 * k * g, 1.06 * k * g],
    [-0.3 * k * g, 0.3 * k * g],
    PROPS.iron,
  );
  boxOf(
    mesh,
    [-0.3 * k * g, -0.1 * k * g],
    [0.9 * k * g, 0.98 * k * g],
    [-0.1 * k * g, 0.1 * k * g],
    0x2b2420,
  );
  if (g !== 1) return;
  lampAt(mesh, 0.52 * k, 0.85 * k, 0, PART.head, BUS.headlamp, [0.04, 0.04]);
  lampAt(mesh, -0.5 * k, 0.75 * k, 0, PART.tail, BUS.taillamp, [0.03, 0.04]);
  bikeLight(mesh, 0.52 * k, 0.85 * k, -0.5 * k, 0.75 * k);
}

/** A bike's lamp and reflector at night: a halo round each, and a small pool ahead on the street. */
function bikeLight(mesh: Builder, lampX: number, lampY: number, tailX: number, tailY: number) {
  halo(mesh, lampX, lampY, 0, PART.halo, BUS.headlamp, [0.08, 0.08], 0.45);
  halo(mesh, tailX, tailY, 0, PART.haloTail, BUS.taillamp, [0.06, 0.07], 0.45);
  beam(mesh, lampX, lampX + 3.5, 0.22, 0.75);
}

/**
 * The shapes the fleet is drawn in far from the view: a car and a bus as a few boxes, and
 * people and cyclists as the coarse figure, on the city bike, at the walker's size; the
 * figure's outline is left to the near shapes, where it is wider than a pixel.
 */
export const SHAPES: Record<VehicleKind, (mesh: Builder, grow?: number) => void> = {
  car: addCar,
  bus: addBus,
  bike: (mesh, g = 1) => {
    addBike(mesh, g);
    if (g === 1) addFigure(mesh, RIDER, false, true);
  },
  person: (mesh, g = 1) => {
    if (g === 1) addFigure(mesh, FIGURE, false, true);
  },
};

/**
 * The shapes each kind is drawn in near the view: a car and a bus with their detail, the
 * walker's figure, and on a bike the rideable one with the figure riding it. The body and the
 * hull are built apart.
 */
export const NEAR_SHAPES: Record<VehicleKind, (mesh: Builder, hull: boolean) => void> = {
  car: (mesh, hull) => addCar(mesh, hull ? HULL_GROW : 1, true),
  bus: (mesh, hull) => addBus(mesh, hull ? HULL_GROW : 1, true),
  bike: (mesh, hull) => {
    addRiddenBike(mesh, hull);
    addFigure(mesh, RIDER, hull);
  },
  person: (mesh, hull) => addFigure(mesh, FIGURE, hull),
};
/**
 * How many of each are drawn in their near shape at once: the nearest within NEAR_RANGE (m)
 * of the view's target, and only while the view is within NEAR_VIEW (m, its radius): further
 * out a vehicle is a few pixels, and the far shapes keep the frame inside its budget.
 */
export const NEAR: Record<VehicleKind, number> = { car: 40, bus: 6, bike: 56, person: 72 };
export const NEAR_RANGE = 90;
export const NEAR_VIEW = 420;

const srgb = (hex: number): V3 => [
  ((hex >> 16) & 255) / 255,
  ((hex >> 8) & 255) / 255,
  (hex & 255) / 255,
];

/**
 * An instance's four colours, as sRGB: its shirt (the simulation's paint), its trim (the
 * shorts on foot, the bike's frame riding), its skin and its hair, the last three drawn from
 * the café guests' wardrobe and the racks' bikes by the instance's own blink.
 */
export function tintsOf(v: Vehicle): [shirt: V3, trim: V3, skin: V3, hair: V3] {
  const pick = <T>(list: readonly T[], k: number): T =>
    list[Math.floor(((v.blink * k) % 1) * list.length)]!;
  const trim = v.kind === 'bike' ? pick(BIKES, 17) : pick(GUESTS.legs, 13);
  return [v.paint, srgb(trim), srgb(pick(GUESTS.skin, 7)), srgb(pick(GUESTS.hair, 11))];
}

/** How far over the drawn surface the wheels ride, so they never sink in it (m). */
export const RIDE_HEIGHT = 0.03;

/**
 * Where a vehicle stands and how it tilts: the drawn ground sampled under its front and its
 * back (not once under its middle, which on Leuven's slopes would bury the uphill wheels and
 * float the downhill ones), so it sits at their mean, pitched between them. Returns the pitch
 * (radians, nose up positive) and writes the height into `out`.
 */
export function settle(
  ground: (x: number, z: number) => number,
  x: number,
  z: number,
  dx: number,
  dz: number,
  length: number,
  out: { y: number },
): number {
  const half = length / 2;
  const front = ground(x + dx * half, z + dz * half);
  const back = ground(x - dx * half, z - dz * half);
  out.y = (front + back) / 2;
  return Math.atan2(front - back, length);
}

/**
 * The vertex shader's share of the parts: the figure's bones swing with the stride (FIGURE_GLSL);
 * the part and the beam's fade go to the fragment shader. For the body's material and its ink's.
 */
export function vehicleVertexShader(vertexShader: string): string {
  return vertexShader
    .replace(
      '#include <common>',
      `#include <common>
      attribute float facade;
      attribute vec3 paint;
      attribute vec3 trim;
      attribute vec3 skin;
      attribute vec3 hair;
      attribute vec4 state;
      varying float vPart;
      varying float vFade;
      varying vec4 vState;
      float harm(float a, float c1, float s1, float c2, float s2, float c3, float s3, float q) {
        return a + c1 * cos(q) + s1 * sin(q) + c2 * cos(2.0 * q) + s2 * sin(2.0 * q) + c3 * cos(3.0 * q) + s3 * sin(3.0 * q);
      }
      // Turns a point about the joint at (x, y) across the vehicle, by a: positive carries what hangs below it ahead.
      void turn(inout vec3 p, float x, float y, float a) {
        vec2 d = vec2(p.x - x, p.y - y);
        float c = cos(a);
        float s = sin(a);
        p.x = x + d.x * c - d.y * s;
        p.y = y + d.x * s + d.y * c;
      }`,
    )
    .replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      float part = floor(facade);
      if (part >= ${FIGURE}.0) {${FIGURE_GLSL}
      }
      vPart = part;
      vFade = 1.0 - fract(facade);
      vState = state;`,
    );
}

/** The paint swapped in for the painted parts and the figure's tints, each times its shade. */
export const TINT_GLSL = `#include <color_vertex>
      if (abs(facade - ${PART.paint}.0) < 0.5) vColor.rgb = paint;
      else if (facade >= ${FIGURE}.0) {
        float tint = fract(facade);
        float shade = max(vColor.r, max(vColor.g, vColor.b));
        if (abs(tint - ${TINT.shirt}) < 0.02) vColor.rgb = paint * shade;
        else if (abs(tint - ${TINT.trim}) < 0.02) vColor.rgb = trim * shade;
        else if (abs(tint - ${TINT.hair}) < 0.02) vColor.rgb = hair * shade;
        else if (abs(tint - ${TINT.skin}) < 0.02) vColor.rgb = skin * shade;
      }`;

/** The three.js classes the layer takes from the engine, so this chunk imports none itself. */
export interface TrafficThree {
  InstancedMesh: typeof InstancedMesh;
  InstancedBufferAttribute: typeof InstancedBufferAttribute;
  Matrix4: typeof Matrix4;
  MeshToonMaterial: typeof MeshToonMaterial;
  MeshBasicMaterial: typeof MeshBasicMaterial;
  BackSide: typeof BackSide;
}

/** What the chunk takes from the engine rather than importing it, as the furniture does. */
export interface TrafficKit {
  three: TrafficThree;
  MeshBuilder: typeof MeshBuilder;
  linearVertexColors: (vertexShader: string) => string;
  /** The 4×4 ordered dither, GLSL, for the beams' fade (facade-material.ts). */
  bayer: string;
  city: Pick<City, 'ways' | 'plazas'>;
  /** The terrain under a spot (m), without the ground layers drawn on it. */
  ground: (x: number, z: number) => number;
  /** How high over the terrain the street is drawn, and a square (ground.ts's layers). */
  lift: { street: number; square: number };
  gradientMap: Texture;
  /** How far into the night it is, for the lamps (the facade material's uniform). */
  night: { value: number };
  ink: number;
}

export interface TrafficLayer {
  /** The meshes to add to the scene: a body and an ink hull per kind. */
  meshes: InstancedMesh[];
  traffic: Traffic;
  /**
   * Keeps the fleet round a spot (the view's target) within `radius`, steps the traffic and
   * moves every instance; returns how many vehicles are on the streets.
   */
  update(dt: number, x: number, z: number, radius: number): number;
  dispose(): void;
}

/** The instance attributes the figure's tints come in. */
const TINTS = ['paint', 'trim', 'skin', 'hair'] as const;

/**
 * The traffic on the streets, drawn: one instanced mesh per kind, with an inverted hull in ink
 * behind it sharing its matrices, two draw calls a kind, and for people and cyclists a second
 * pair in the walker's figure (NEAR_SHAPES) that the nearest of them move to each frame. Bodies
 * take the city's toon shading and its shadows; `paint` colours the painted parts per instance
 * (with `trim`, `skin` and `hair` for the figures) and `state` (the stride, the brakes, the
 * indicator, a blink offset) drives the limbs and the lamps.
 */
export function createTrafficLayer(kit: TrafficKit, seed = 1): TrafficLayer {
  const { three, MeshBuilder, linearVertexColors, gradientMap, night } = kit;
  const traffic = new Traffic(kit.city.ways, seed);
  const time = { value: 0 };
  const material = new three.MeshToonMaterial({ vertexColors: true, gradientMap });
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    shader.uniforms.uNight = night;
    shader.uniforms.uTime = time;
    // The paint is sRGB like the vertex colours: swapped in right after them, so the
    // linearisation that follows the include takes it too.
    shader.vertexShader = linearVertexColors(vehicleVertexShader(shader.vertexShader)).replace(
      '#include <color_vertex>',
      TINT_GLSL,
    );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uNight;
        uniform float uTime;
        varying float vPart;
        varying float vFade;
        varying vec4 vState;
        ${kit.bayer}`,
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
        // The beam: a pool of light on the street, dithered out towards its edges, at night; the
        // halos round the lamps the same, a tail lamp's with the brakes too.
        float dither = bayer4(gl_FragCoord.xy);
        if (vPart == ${PART.beam}.0 && dither >= uNight * vFade * 0.75) discard;
        if (vPart == ${PART.halo}.0 && dither >= uNight * vFade) discard;
        if (vPart == ${PART.haloTail}.0 && dither >= (0.6 * uNight + 0.9 * vState.y) * vFade) discard;`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        if (vPart == ${PART.head}.0) totalEmissiveRadiance += vec3(1.0, 0.92, 0.7) * uNight;
        else if (vPart == ${PART.tail}.0) totalEmissiveRadiance += vec3(0.9, 0.08, 0.04) * (0.6 * uNight + 0.9 * vState.y);
        else if (vPart == ${PART.beam}.0) totalEmissiveRadiance += vec3(0.8, 0.72, 0.5) * (0.55 + 0.6 * vFade);
        else if (vPart == ${PART.halo}.0) totalEmissiveRadiance += vec3(1.0, 0.9, 0.62);
        else if (vPart == ${PART.haloTail}.0) totalEmissiveRadiance += vec3(0.9, 0.12, 0.06);
        else if (vPart == ${PART.signalL}.0 || vPart == ${PART.signalR}.0) {
          float wanted = vPart == ${PART.signalL}.0 ? step(vState.z, -0.5) : step(0.5, vState.z);
          float blink = step(0.5, fract(uTime * 1.2 + vState.w));
          totalEmissiveRadiance += vec3(1.0, 0.6, 0.1) * wanted * blink;
        }`,
      );
  };
  material.customProgramCacheKey = () => 'vehicle-v4';
  const inkMaterial = new three.MeshBasicMaterial({ color: kit.ink, side: three.BackSide });
  inkMaterial.onBeforeCompile = (shader) => {
    shader.vertexShader = vehicleVertexShader(shader.vertexShader);
    // The hull has no lamps and no beam: nothing of it is discarded or lit.
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying float vPart;\nvarying float vFade;\nvarying vec4 vState;',
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>\nif (vPart >= ${PART.beam}.0 && vPart <= ${PART.haloTail}.0 && vPart != ${PART.legL}.0 && vPart != ${PART.legR}.0 && vPart != ${PART.armL}.0 && vPart != ${PART.armR}.0) discard;`,
      );
  };
  inkMaterial.customProgramCacheKey = () => 'vehicle-ink-v4';
  const meshes: InstancedMesh[] = [];
  const matrix = new three.Matrix4();
  const tilt = new three.Matrix4();
  const gone = new three.Matrix4().makeScale(0, 0, 0);
  // What each edge is drawn on: a square's setts lie higher than a street. Each square's box
  // is tried before its outline, so the thousands of edges cost a few milliseconds.
  const { edges } = traffic.graph;
  const lift = new Float32Array(edges.length);
  const squares = kit.city.plazas.map((ring) => {
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = 0; i + 1 < ring.length; i += 2) {
      box[0] = Math.min(box[0]!, ring[i]!);
      box[1] = Math.min(box[1]!, ring[i + 1]!);
      box[2] = Math.max(box[2]!, ring[i]!);
      box[3] = Math.max(box[3]!, ring[i + 1]!);
    }
    return { ring, box };
  });
  const mid: [number, number, number, number] = [0, 0, 0, 0];
  for (const [i, e] of edges.entries()) {
    alongEdge(e, e.length / 2, mid);
    const [x, z] = mid;
    const onSquare = squares.some(
      ({ ring, box }) =>
        x >= box[0]! && x <= box[2]! && z >= box[1]! && z <= box[3]! && pointInRing(ring, x, z),
    );
    lift[i] = onSquare ? kit.lift.square : kit.lift.street;
  }
  const stood = { y: 0 };
  interface Group {
    mesh: InstancedMesh;
    ink: InstancedMesh;
    state: InstancedBufferAttribute;
    /** The instances' shirt, trim, skin and hair. */
    tints: InstancedBufferAttribute[];
    vehicles: Vehicle[];
  }
  /** A body and its ink hull, sharing their matrices and state, for `n` instances. */
  const pair = (body: BufferGeometry, hullGeometry: BufferGeometry, n: number): Group => {
    const state = new three.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    body.setAttribute('state', state);
    hullGeometry.setAttribute('state', state);
    const tints = TINTS.map((name) => {
      const tint = new three.InstancedBufferAttribute(new Float32Array(n * 3), 3);
      body.setAttribute(name, tint);
      return tint;
    });
    const mesh = new three.InstancedMesh(body, material, n);
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    const ink = new three.InstancedMesh(hullGeometry, inkMaterial, n);
    ink.instanceMatrix = mesh.instanceMatrix;
    ink.frustumCulled = false;
    meshes.push(mesh, ink);
    return { mesh, ink, state, tints, vehicles: [] };
  };
  const far: (Group & { d2: Float32Array })[] = [];
  /** The nearest of each kind, in its near shape: each near group picks from its far one. */
  const near: (Group & { from: Group & { d2: Float32Array }; order: Int32Array })[] = [];
  for (const kind of VEHICLE_KINDS) {
    const vehicles = traffic.vehicles.filter((v) => v.kind === kind);
    const body = new MeshBuilder();
    SHAPES[kind](body);
    const hull = new MeshBuilder();
    SHAPES[kind](hull, HULL_GROW);
    const built = [body, hull].map((b) => b.build({ facade: true, keep: true })) as [
      BufferGeometry,
      BufferGeometry,
    ];
    const group = {
      ...pair(...built, vehicles.length),
      vehicles,
      d2: new Float32Array(vehicles.length),
    };
    for (const [i, v] of vehicles.entries()) {
      for (const [k, tint] of tintsOf(v).entries())
        (group.tints[k]!.array as Float32Array).set(tint, i * 3);
    }
    far.push(group);
    const nearBody = new MeshBuilder();
    NEAR_SHAPES[kind](nearBody, false);
    const nearHull = new MeshBuilder();
    NEAR_SHAPES[kind](nearHull, true);
    near.push({
      ...pair(
        nearBody.build({ facade: true, keep: true }),
        nearHull.build({ facade: true, keep: true }),
        NEAR[kind],
      ),
      vehicles,
      from: group,
      order: new Int32Array(vehicles.length),
    });
  }
  const spot: [number, number, number, number] = [0, 0, 0, 0];
  return {
    meshes,
    traffic,
    update(dt, fx, fz, radius) {
      traffic.focus(fx, fz, radius);
      traffic.step(dt);
      time.value += dt;
      let drawn = 0;
      for (const { mesh, state, vehicles, d2 } of far) {
        const states = state.array as Float32Array;
        for (const [i, v] of vehicles.entries()) {
          if (!v.active) {
            // Parked out of sight: nothing of it, until it is let out again.
            mesh.setMatrixAt(i, gone);
            d2[i] = Infinity;
            continue;
          }
          drawn++;
          traffic.place(v, spot);
          const [x, z, dx, dz] = spot;
          // Local x ahead: a turn about y by atan2(-dz, dx) takes it to (dx, dz). The drawn
          // heading swings after the path's, so a corner is a turn, not a snap.
          v.yaw = turnTowards(v.yaw, Math.atan2(-dz, dx), TURN_RATE[v.kind], dt);
          // Tilted about its own axles, the way it faces, not the way the path heads.
          const pitch = settle(
            kit.ground,
            x,
            z,
            Math.cos(v.yaw),
            -Math.sin(v.yaw),
            LENGTH[v.kind],
            stood,
          );
          matrix.makeRotationY(v.yaw).multiply(tilt.makeRotationZ(pitch));
          matrix.setPosition(x, stood.y + lift[v.edge]! + RIDE_HEIGHT, z);
          mesh.setMatrixAt(i, matrix);
          d2[i] = (x - fx) ** 2 + (z - fz) ** 2;
          states[i * 4] = v.phase;
          states[i * 4 + 1] = v.brake;
          states[i * 4 + 2] = v.signal;
          states[i * 4 + 3] = v.blink;
        }
      }
      // The nearest of each kind move to its near meshes, the nearest first, while the view is
      // close enough for the detail to be more than a few pixels.
      for (const { mesh, ink, state, tints, vehicles, from, order } of near) {
        let n = 0;
        if (radius <= NEAR_VIEW) {
          for (let i = 0; i < vehicles.length; i++) {
            if (from.d2[i]! <= NEAR_RANGE * NEAR_RANGE) order[n++] = i;
          }
          if (n > mesh.instanceMatrix.count) {
            order.subarray(0, n).sort((a, b) => from.d2[a]! - from.d2[b]!);
            n = mesh.instanceMatrix.count;
          }
        }
        const states = state.array as Float32Array;
        const fromStates = from.state.array as Float32Array;
        for (let j = 0; j < n; j++) {
          const i = order[j]!;
          from.mesh.getMatrixAt(i, matrix);
          mesh.setMatrixAt(j, matrix);
          from.mesh.setMatrixAt(i, gone);
          states.set(fromStates.subarray(i * 4, i * 4 + 4), j * 4);
          for (const [k, tint] of tints.entries()) {
            (tint.array as Float32Array).set(
              (from.tints[k]!.array as Float32Array).subarray(i * 3, i * 3 + 3),
              j * 3,
            );
          }
        }
        mesh.count = ink.count = n;
        state.needsUpdate = true;
        for (const tint of tints) tint.needsUpdate = true;
      }
      for (const { mesh, state, tints } of far) {
        mesh.instanceMatrix.needsUpdate = true;
        state.needsUpdate = true;
        for (const tint of tints) tint.needsUpdate = true;
      }
      for (const { mesh } of near) mesh.instanceMatrix.needsUpdate = true;
      return drawn;
    },
    dispose() {
      for (const m of meshes) {
        m.dispose();
        m.geometry.dispose();
      }
      material.dispose();
      inkMaterial.dispose();
    },
  };
}
