import { isMonument } from '../data/city.ts';
import type { MonumentKind, Prop, PropKind } from '../data/city.ts';
import {
  BIKE_SHIFT,
  ROW_GAP,
  STAND_SPACING,
  bikesIn,
  propHash as hash,
  propScale,
  propSeed,
  rackRows,
} from '../data/props.ts';
import { BIKES, PROPS } from './palette.ts';
import type { MeshBuilder } from './mesh-builder.ts';
import { addMonument } from './monuments.ts';
import { at, away, box, panel } from './prop-shapes.ts';
import type { Frame } from './prop-shapes.ts';

/**
 * Low-poly street furniture, a few boxes and panels each, written into a cell's props mesh, and
 * the monuments of src/scene/monuments.ts. Furniture is true to life, then drawn a third larger
 * (`propScale`), as a diorama does: at life size a lamp post or a bike is a pixel or two even
 * zoomed in. Each prop stands in its own frame (`Frame`): v along its facing (see `placeProps`),
 * u across it, within the footprint the bake keeps clear.
 */

export { isLarge } from './monuments.ts';
/** Half a bike tube's width: chunky, so a frame still shows its colour zoomed out (m). */
const TUBE = 0.045;
/** A wheel's radius, and its pale hub's, corner to middle: a rim, not a grey block (m). */
const WHEEL = 0.34;
const HUB = 0.15;
/** Half a bike's wheelbase, and where its steering axis stands, from between the wheels (m). */
const AXLE = 0.55;
const STEERING = 0.37;
/** How high the saddle and the bars are (m). */
const SADDLE = 0.96;
const BARS = 1.04;
/** Most a parked bike stands off square, and its front wheel is turned (radians). */
export const YAW = (4 * Math.PI) / 180;
export const STEER = (20 * Math.PI) / 180;
/** How high a rack's rail runs, and half its bar's thickness (m). */
const RAIL = 0.4;
const RAIL_BAR = 0.03;

/**
 * How a parked bike looks, packed in a byte: a step-through frame, a carrier, a crate, then its
 * colour (times `colour`). Shares: 45% step-throughs; a red crate on the front of one in ten, as
 * Leuven's are, and a carrier on 55% (never with a crate).
 */
const [STEP, CARRIER, CRATE, COLOUR] = [1, 2, 4, 8];
export const LOOK = { step: STEP, carrier: CARRIER, crate: CRATE, colour: COLOUR } as const;

/**
 * What `buildFurniture` notes for each parked bike, `PARKED.stride` numbers each in this order:
 * its index range in the mesh, its place (between its wheels, on the ground), its heading (a
 * turn) and its look (`LOOK`). A rideable bike will take a parked one's place by drawing nothing
 * over its range.
 */
export const PARKED = { from: 0, to: 1, x: 2, y: 3, z: 4, heading: 5, look: 6, stride: 7 } as const;

/** `f` turned by `by` about its steering axis: the front wheel and bars, turned. */
function steered(f: Frame, by: number): Frame {
  const [c, s] = [Math.cos(by), Math.sin(by)];
  const [x, , z] = at(f, 0, STEERING, 0);
  return { x, z, fx: f.fx * c - f.fz * s, fz: f.fz * c + f.fx * s, scale: f.scale };
}

/** A tube in a frame's v-y plane, from (v, y) to (v, y), as a thin two-sided strip `w` thick. */
function tube(
  mesh: MeshBuilder,
  f: Frame,
  va: number,
  ya: number,
  vb: number,
  yb: number,
  color: number,
  w = TUBE,
): void {
  const length = Math.hypot(vb - va, yb - ya);
  const [nv, ny] = [((ya - yb) / length) * w, ((vb - va) / length) * w];
  panel(
    mesh,
    [
      at(f, 0, va - nv, ya - ny),
      at(f, 0, vb - nv, yb - ny),
      at(f, 0, vb + nv, yb + ny),
      at(f, 0, va + nv, ya + ny),
    ],
    color,
  );
}

/**
 * A wheel round its axle at v: a dark hexagonal tyre seen from both sides, and on each face, a
 * hair out, a small pale diamond for the rim and spokes, so it reads as a wheel, not a black disc.
 */
function wheel(mesh: MeshBuilder, f: Frame, v: number): void {
  const r = WHEEL;
  const rim = Array.from({ length: 6 }, (_, i) => {
    const t = Math.PI / 2 + (i * Math.PI) / 3;
    return at(f, 0, v + Math.cos(t) * r, r + Math.sin(t) * r);
  });
  panel(mesh, rim, PROPS.wheel);
  for (const side of [-1, 1]) {
    const u = side * 0.012;
    mesh.quad(
      at(f, u, v, r + HUB),
      at(f, u, v + HUB, r),
      at(f, u, v, r - HUB),
      at(f, u, v - HUB, r),
      PROPS.spokes,
      away(f, side, 0),
    );
  }
}

/** A flat quad facing up at height y, from u0 to u1 across and v0 to v1 along. */
function lid(
  mesh: MeshBuilder,
  f: Frame,
  u0: number,
  u1: number,
  v0: number,
  v1: number,
  y: number,
  color: number,
): void {
  mesh.quad(
    at(f, u0, v0, y),
    at(f, u1, v0, y),
    at(f, u1, v1, y),
    at(f, u0, v1, y),
    color,
    [0, 1, 0],
  );
}

/**
 * The swept-back handlebar's corners round the steering axis, seen from above: wide grips pulled
 * back toward the rider, narrow at the stem. In order round it.
 */
const HANDLEBAR = [
  [-0.25, -0.1],
  [0.25, -0.1],
  [0.08, 0.02],
  [-0.08, 0.02],
] as const;

/** Where a bike's handlebar is, seen from above: its four corners (x, z), in order round it. */
export function handlebar(f: Frame, steer: number): [number, number][] {
  const front = steered(f, steer);
  return HANDLEBAR.map(([u, v]) => {
    const [x, , z] = at(front, u, v, 0);
    return [x, z];
  });
}

/**
 * A parked city bike, seen side on, in its own frame `f` (v forward from between the wheels): a
 * filled rear triangle that carries its colour on the map, a diamond's top tube or a
 * step-through's low one, the down tube, a fork and front wheel turned by `steer`, a saddle,
 * swept-back bars, and on some a carrier or a red crate (`LOOK`). 41 triangles plain, 43 with a
 * carrier, 51 with a crate.
 */
export function addBike(mesh: MeshBuilder, f: Frame, steer: number, look: number): void {
  const color = BIKES[Math.floor(look / COLOUR) % BIKES.length]!;
  const front = steered(f, steer);
  const axle = AXLE - STEERING;
  wheel(mesh, f, -AXLE);
  wheel(mesh, front, axle);
  // The rear triangle (stays, seat tube, chain guard) from the rear axle, bracket and seat.
  panel(mesh, [at(f, 0, -AXLE, WHEEL), at(f, 0, -0.05, 0.3), at(f, 0, -0.24, 0.84)], color);
  // A diamond's top tube from the seat to the head, or a step-through's low one; the down tube.
  if (look & STEP) tube(mesh, f, -0.17, 0.5, 0.4, 0.68, color);
  else tube(mesh, f, -0.24, 0.84, 0.36, 0.86, color);
  tube(mesh, f, -0.05, 0.3, 0.4, 0.68, color);
  // The fork and stem, from the front axle up through the head to the bars.
  tube(mesh, front, axle, WHEEL, -0.02, BARS, color);
  mesh.triangle(
    at(f, -0.07, -0.37, SADDLE),
    at(f, 0.07, -0.37, SADDLE),
    at(f, 0, -0.11, SADDLE),
    PROPS.wheel,
    [0, 1, 0],
  );
  const [a, b, c, d] = HANDLEBAR.map(([u, v]) => at(front, u, v, BARS));
  mesh.quad(a!, b!, c!, d!, PROPS.wheel, [0, 1, 0]);
  if (look & CRATE) {
    // On a carrier fixed to the frame over the front wheel, so it stays put when the bars turn;
    // its top is the dark inside, seen from above.
    box(mesh, f, [-0.18, 0.18], [0.3, 0.62], [0.78, 1], PROPS.crate, false);
    lid(mesh, f, -0.18, 0.18, 0.3, 0.62, 1, PROPS.crateInside);
  } else if (look & CARRIER) {
    lid(mesh, f, -0.09, 0.09, -AXLE - 0.12, -0.36, WHEEL * 2 + 0.06, PROPS.iron);
  }
}

/**
 * The bike at a rack's `slot`, in its own frame: every other stand's is turned round (front in,
 * back in), so neighbouring bars don't clash; each stands a few degrees off square and a little
 * off its stand, with its front wheel turned a little.
 */
export function parkedBike(
  p: Prop,
  slot: number,
  seed: number,
): { f: Frame; steer: number; look: number } {
  const { rows, perRow } = rackRows(p.size);
  const [row, k] = [Math.floor(slot / perRow), slot % perRow];
  const share = (salt: number) => hash(seed + salt, slot);
  const h = (salt: number) => share(salt) * 2 - 1;
  const v = (rows === 1 ? 0 : row === 0 ? ROW_GAP : -ROW_GAP) + h(1) * BIKE_SHIFT;
  const u = (k - (perRow - 1) / 2) * STAND_SPACING;
  const s = propScale('bikes');
  const [fx, fz] = [Math.cos(p.angle), Math.sin(p.angle)];
  const turn = p.angle + h(8) * YAW + (k % 2) * Math.PI;
  const look =
    (share(2) < 0.45 ? STEP : 0) |
    (share(6) < 0.1 ? CRATE : share(5) < 0.55 / 0.9 ? CARRIER : 0) |
    (Math.floor(share(3) * BIKES.length) * COLOUR);
  return {
    f: {
      x: p.x + (-fz * u + fx * v) * s,
      z: p.z + (fx * u + fz * v) * s,
      fx: Math.cos(turn),
      fz: Math.sin(turn),
      scale: s,
    },
    steer: h(4) * STEER,
    look,
  };
}

/**
 * Which stands of a rack hold its bikes: a run of neighbours from a seeded start, now and then
 * skipping one, the way people park, rather than sprinkled along it.
 */
export function rackSlots(p: Prop, seed: number): number[] {
  const { rows, perRow } = rackRows(p.size);
  const total = rows * perRow;
  const count = Math.min(bikesIn(p), total);
  const start = Math.floor(hash(seed, 7) * total);
  const step = Math.min(1.15, total / Math.max(count, 1));
  return Array.from({ length: count }, (_, i) => (start + Math.round(i * step)) % total);
}

/**
 * A rack: a low rail along each row on a leg at either end, so a half-empty rack still reads as
 * one (12 triangles a row), then its bikes, each noted in `parked` (see `PARKED`).
 */
function addRack(mesh: MeshBuilder, f: Frame, p: Prop, seed: number, parked?: number[]): void {
  const { rows, perRow } = rackRows(p.size);
  const half = ((perRow - 1) / 2) * STAND_SPACING;
  for (let row = 0; row < rows; row++) {
    // The row's own frame, turned a quarter, so the rail runs along its v.
    const [x, , z] = at(f, 0, rows === 1 ? 0 : row === 0 ? ROW_GAP : -ROW_GAP, 0);
    const r = { x, z, fx: -f.fz, fz: f.fx, scale: f.scale };
    tube(mesh, r, -half, RAIL, half, RAIL, PROPS.iron, RAIL_BAR);
    for (const e of [-half, half]) tube(mesh, r, e, 0, e, RAIL + RAIL_BAR, PROPS.iron, RAIL_BAR);
  }
  for (const slot of rackSlots(p, seed)) {
    const { f: b, steer, look } = parkedBike(p, slot, seed);
    const from = mesh.indices;
    addBike(mesh, b, steer, look);
    parked?.push(from, mesh.indices, b.x, mesh.lift, b.z, Math.atan2(b.fz, b.fx), look);
  }
}

type Furniture = Exclude<PropKind, MonumentKind | 'bikes'>;
const MODELS: Record<Furniture, (mesh: MeshBuilder, f: Frame) => void> = {
  lamp(mesh, f) {
    box(mesh, f, [-0.12, 0.12], [-0.12, 0.12], [0, 4.5], PROPS.iron, false);
    box(mesh, f, [-0.3, 0.3], [-0.05, 0.55], [4.15, 4.6], PROPS.lantern);
  },
  bench(mesh, f) {
    box(mesh, f, [-0.9, 0.9], [-0.25, 0.25], [0.4, 0.5], PROPS.wood);
    box(mesh, f, [-0.9, 0.9], [-0.25, -0.17], [0.5, 0.9], PROPS.wood);
    for (const u of [-0.75, 0.75]) {
      panel(
        mesh,
        [at(f, u, -0.22, 0), at(f, u, 0.22, 0), at(f, u, 0.22, 0.4), at(f, u, -0.22, 0.4)],
        PROPS.iron,
      );
    }
  },
  shelter(mesh, f) {
    box(mesh, f, [-1.6, 1.6], [-0.75, 0.75], [2.4, 2.55], PROPS.roof);
    panel(
      mesh,
      [
        at(f, -1.5, -0.65, 0.15),
        at(f, 1.5, -0.65, 0.15),
        at(f, 1.5, -0.65, 2.4),
        at(f, -1.5, -0.65, 2.4),
      ],
      PROPS.glass,
    );
    panel(
      mesh,
      [
        at(f, -1.5, -0.65, 0.15),
        at(f, -1.5, 0.4, 0.15),
        at(f, -1.5, 0.4, 2.4),
        at(f, -1.5, -0.65, 2.4),
      ],
      PROPS.glass,
    );
    for (const u of [-1.5, 1.5])
      box(mesh, f, [u - 0.06, u + 0.06], [0.54, 0.66], [0, 2.4], PROPS.iron, false);
  },
  busstop(mesh, f) {
    box(mesh, f, [-0.07, 0.07], [-0.07, 0.07], [0, 2.6], PROPS.iron, false);
    // The sign stands across the kerb, so a bus coming either way sees it.
    box(mesh, f, [-0.05, 0.05], [-0.28, 0.28], [2.15, 2.75], PROPS.sign);
  },
};

/** One prop, in its own frame, written into `mesh`; a rack notes its bikes in `parked`. */
export function addProp(mesh: MeshBuilder, p: Prop, parked?: number[]): void {
  const f = {
    x: p.x,
    z: p.z,
    fx: Math.cos(p.angle),
    fz: Math.sin(p.angle),
    scale: propScale(p.kind),
  };
  const seed = propSeed(p.x, p.z);
  if (isMonument(p.kind)) addMonument(mesh, f, p.kind, p, seed);
  else if (p.kind === 'bikes') addRack(mesh, f, p, seed, parked);
  else MODELS[p.kind as Furniture](mesh, f);
}
