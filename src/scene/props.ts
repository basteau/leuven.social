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
import type { MeshBuilder, V3 } from './mesh-builder.ts';
import { addMonument } from './monuments.ts';
import { at, away, box, fan, panel, slopeThrough } from './prop-shapes.ts';
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
/** A wheel's radius, and how far out its pale spokes reach, leaving a ring of dark tyre (m). */
const WHEEL = 0.34;
const SPOKES = 0.27;
/** Half a bike's wheelbase, and where its steering axis stands, from between the wheels (m). */
const AXLE = 0.55;
const STEERING = 0.37;
/** How high the saddle and the bars are (m). */
const SADDLE = 0.97;
const BARS = 1.04;
/** The bottom bracket (v, y), and a crank's length (m), as the rideable bike's. */
const BRACKET = [-0.05, 0.3] as const;
const CRANK = 0.17;
/** Most a parked bike stands off square, and its front wheel is turned (radians). */
export const YAW = (4 * Math.PI) / 180;
export const STEER = (20 * Math.PI) / 180;
/** How high a rack's rail runs, and half its bar's thickness (m). */
const RAIL = 0.4;
const RAIL_BAR = 0.03;

/**
 * How a parked bike looks, packed in a byte: a step-through frame, a carrier, a crate, a basket,
 * then its colour (times `colour`). Shares: 45% step-throughs (with a brown saddle; a diamond's
 * is black); a red crate on the front of one in ten, as Leuven's are, a wicker basket on the bars
 * of one in ten, and a carrier on as many of the rest as make 55% of all bikes.
 */
const [STEP, CARRIER, CRATE, BASKET, COLOUR] = [1, 2, 4, 8, 16];
export const LOOK = {
  step: STEP,
  carrier: CARRIER,
  crate: CRATE,
  basket: BASKET,
  colour: COLOUR,
} as const;

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
  return { ...f, x, z, fx: f.fx * c - f.fz * s, fz: f.fz * c + f.fx * s };
}

/** Where something stands, as `buildFurniture` sees it: the drawn ground's height at (x, z). */
export type Ground = (x: number, z: number) => number;

/**
 * A bike's frame stood on the drawn ground: sheared onto the plane through the ground under its
 * two wheels (`slopeThrough`), so both tyres touch it on a slope or across a kerb.
 */
export function standBike(f: Frame, steer: number, ground: Ground, lift: number): Frame {
  const [rx, , rz] = at(f, 0, -AXLE, 0);
  const [fx, , fz] = at(steered(f, steer), 0, AXLE - STEERING, 0);
  return { ...f, slope: slopeThrough(ground, lift, [rx, rz], [fx, fz]) };
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
 * Three pale sectors from the hub, thin as a bunch of spokes seen edge on, with dark between,
 * and half of each one's angle (radians).
 */
const SPREAD = 0.2;
const SECTORS = [
  [0, 1, 2],
  [0, 3, 4],
  [0, 5, 6],
];

/**
 * A wheel round its axle at v: a dark octagonal tyre seen from both sides, one corner on the
 * ground, and on each face, a hair out, three pale sectors from the hub, turned by `turn`: the
 * rim and spokes as a pinwheel inside a ring of tyre, so it reads as a spoked wheel without a
 * texture. 18 triangles.
 */
function wheel(mesh: MeshBuilder, f: Frame, v: number, turn: number): void {
  const r = WHEEL;
  const tyre = Array.from({ length: 8 }, (_, i) => {
    const t = (i * Math.PI) / 4;
    return at(f, 0, v + Math.cos(t) * r, r + Math.sin(t) * r);
  });
  panel(mesh, tyre, PROPS.wheel);
  for (const side of [-1, 1]) {
    const u = side * 0.012;
    const points = [at(f, u, v, r)];
    for (let k = 0; k < 3; k++) {
      for (const edge of [-1, 1]) {
        const t = turn + (k * 2 * Math.PI) / 3 + edge * SPREAD;
        points.push(at(f, u, v + Math.cos(t) * SPOKES, r + Math.sin(t) * SPOKES));
      }
    }
    mesh.polygon(points, SECTORS, PROPS.spokes, away(f, side, 0));
  }
}

/** A quad facing `out` (a direction in the frame: across, along, up), seen from that side only. */
function face(
  mesh: MeshBuilder,
  f: Frame,
  corners: readonly (readonly [number, number, number])[],
  color: number,
  [u, v, y]: readonly [number, number, number],
): void {
  const [a, b, c, d] = corners.map(([cu, cv, cy]) => at(f, cu, cv, cy));
  mesh.quad(a!, b!, c!, d!, color, away(f, u, v, y));
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
 * The swept-back handlebar round the steering axis, seen from above (u, v): a chevron from the
 * grips, pulled back toward the rider, to the stem, its outline in order round it, then the
 * notch behind the stem that makes it a chevron rather than a plate.
 */
const HANDLEBAR = [
  [-0.25, -0.11],
  [-0.23, -0.065],
  [0, 0.05],
  [0.23, -0.065],
  [0.25, -0.11],
] as const;
const NOTCH = [0, 0] as const;
const CHEVRON = [
  [0, 1, 5],
  [1, 2, 5],
  [2, 3, 5],
  [3, 4, 5],
];

/** Where a bike's handlebar is, seen from above: its outline (x, z), convex, in order round it. */
export function handlebar(f: Frame, steer: number): [number, number][] {
  const front = steered(f, steer);
  return HANDLEBAR.map(([u, v]) => {
    const [x, , z] = at(front, u, v, 0);
    return [x, z];
  });
}

/**
 * A saddle: a wedge whose nose points forward, its top and three sides, facing out (7 triangles).
 * `back` and `nose` are where it starts and ends along v, `half` half its width at the back.
 */
function saddle(mesh: MeshBuilder, f: Frame, color: number): void {
  const [back, nose, half, deep] = [-0.37, -0.12, 0.08, 0.05];
  const ring = [
    [-half, back],
    [half, back],
    [0, nose],
  ] as const;
  mesh.triangle(...(ring.map(([u, v]) => at(f, u, v, SADDLE)) as [V3, V3, V3]), color, [0, 1, 0]);
  for (let i = 0; i < 3; i++) {
    const [[ua, va], [ub, vb]] = [ring[i]!, ring[(i + 1) % 3]!];
    face(
      mesh,
      f,
      [
        [ua, va, SADDLE],
        [ub, vb, SADDLE],
        [ub, vb, SADDLE - deep],
        [ua, va, SADDLE - deep],
      ],
      color,
      [vb - va, ua - ub, 0],
    );
  }
}

/**
 * A parked city bike, seen side on, in its own frame `f` (v forward from between the wheels): two
 * round wheels with spokes, the front one turned by `steer`; a filled rear triangle that carries
 * its colour on the map, a diamond's top tube or a step-through's low one, the down tube and the
 * fork; a black chain guard on the right, the cranks and pedals at a turn of their own, a kickstand
 * on the left; a saddle, swept-back bars and a lamp on the fork; and on some a carrier with a red
 * reflector, a red crate or a wicker basket (`LOOK`). 78 triangles plain, 84 with a carrier, 88
 * with a crate or a basket.
 */
export function addBike(mesh: MeshBuilder, f: Frame, steer: number, look: number): void {
  const color = BIKES[Math.floor(look / COLOUR) % BIKES.length]!;
  const front = steered(f, steer);
  const axle = AXLE - STEERING;
  // How its wheels and cranks came to rest, from how its bars did.
  const turn = steer * 11;
  wheel(mesh, f, -AXLE, turn);
  wheel(mesh, front, axle, turn * 3);
  // The rear triangle (stays, seat tube) from the rear axle, bracket and seat.
  panel(
    mesh,
    [at(f, 0, -AXLE, WHEEL), at(f, 0, ...BRACKET), at(f, 0, -0.24, SADDLE - 0.05)],
    color,
  );
  // A diamond's top tube from the seat to the head, or a step-through's low one; the down tube.
  if (look & STEP) tube(mesh, f, -0.17, 0.5, 0.4, 0.68, color);
  else tube(mesh, f, -0.24, 0.84, 0.36, 0.86, color);
  tube(mesh, f, ...BRACKET, 0.4, 0.68, color);
  // The fork and stem, from the front axle up through the head to the bars.
  tube(mesh, front, axle, WHEEL, -0.02, BARS, color);
  // The chain guard, on the chain's side (right, +u) only: from the left the frame hides it.
  mesh.polygon(
    [
      [0.08, 0.32],
      [0, 0.42],
      [-0.56, 0.41],
      [-0.6, 0.35],
      [-0.05, 0.2],
    ].map(([v, y]) => at(f, 0.035, v!, y!)),
    fan(5),
    PROPS.wheel,
    away(f, 1, 0),
  );
  // The cranks, each facing out on its side, and the pedals on them, level.
  const [cv, cy] = [Math.sin(turn) * CRANK, -Math.cos(turn) * CRANK];
  for (const side of [-1, 1]) {
    const [pv, py] = [BRACKET[0] + side * cv, BRACKET[1] + side * cy];
    const [nv, ny] = [(-cy / CRANK) * 0.02, (cv / CRANK) * 0.02];
    const u = side * 0.06;
    face(
      mesh,
      f,
      [
        [u, BRACKET[0] - nv, BRACKET[1] - ny],
        [u, pv - nv, py - ny],
        [u, pv + nv, py + ny],
        [u, BRACKET[0] + nv, BRACKET[1] + ny],
      ],
      PROPS.iron,
      [side, 0, 0],
    );
    lid(mesh, f, side * 0.06, side * 0.15, pv - 0.05, pv + 0.05, py, PROPS.wheel);
  }
  // The kickstand, down from behind the bracket to the ground on the left.
  panel(
    mesh,
    [at(f, -0.04, -0.12, 0.3), at(f, -0.04, -0.07, 0.3), at(f, -0.16, -0.3, 0)],
    PROPS.iron,
  );
  saddle(mesh, f, look & STEP ? PROPS.wood : PROPS.wheel);
  mesh.polygon(
    [...HANDLEBAR, NOTCH].map(([u, v]) => at(front, u, v, BARS)),
    CHEVRON,
    PROPS.iron,
    [0, 1, 0],
  );
  // The lamp on the fork: its dark top and its lens, facing ahead.
  lid(mesh, front, -0.04, 0.04, 0.09, 0.17, 0.73, PROPS.iron);
  face(
    mesh,
    front,
    [
      [-0.04, 0.17, 0.73],
      [0.04, 0.17, 0.73],
      [0.04, 0.17, 0.66],
      [-0.04, 0.17, 0.66],
    ],
    PROPS.lantern,
    [0, 1, 0],
  );
  if (look & CRATE) {
    // On a carrier fixed to the frame over the front wheel, so it stays put when the bars turn;
    // its top is the dark inside, seen from above.
    box(mesh, f, [-0.18, 0.18], [0.3, 0.62], [0.78, 1], PROPS.crate, false);
    lid(mesh, f, -0.18, 0.18, 0.3, 0.62, 1, PROPS.crateInside);
  } else if (look & BASKET) {
    // Hung on the bars, so it turns with them.
    box(mesh, front, [-0.15, 0.15], [0.05, 0.3], [0.8, 1.02], PROPS.wood, false);
    lid(mesh, front, -0.15, 0.15, 0.05, 0.3, 1.02, PROPS.crateInside);
  } else if (look & CARRIER) {
    // Over the rear wheel on a stay from the axle, a red reflector at its end, facing back.
    const [end, top] = [-AXLE - 0.12, WHEEL * 2 + 0.06];
    lid(mesh, f, -0.09, 0.09, end, -0.36, top, PROPS.iron);
    panel(
      mesh,
      [at(f, 0, -AXLE, WHEEL), at(f, 0, end + 0.06, top), at(f, 0, end, top)],
      PROPS.iron,
    );
    face(
      mesh,
      f,
      [
        [0.05, end, top - 0.01],
        [-0.05, end, top - 0.01],
        [-0.05, end, top - 0.08],
        [0.05, end, top - 0.08],
      ],
      PROPS.crate,
      [0, -1, 0],
    );
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
    (share(6) < 0.1 ? CRATE : share(6) < 0.2 ? BASKET : share(5) < 0.55 / 0.8 ? CARRIER : 0) |
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
 * one (12 triangles a row), then its bikes, each noted in `parked` (see `PARKED`). With `ground`,
 * each rail runs from leg to leg on the drawn ground and each bike stands on it under its wheels;
 * without, all stand on the mesh's lift.
 */
function addRack(
  mesh: MeshBuilder,
  f: Frame,
  p: Prop,
  seed: number,
  parked?: number[],
  ground?: Ground,
): void {
  const { rows, perRow } = rackRows(p.size);
  const half = ((perRow - 1) / 2) * STAND_SPACING;
  for (let row = 0; row < rows; row++) {
    // The row's own frame, turned a quarter, so the rail runs along its v.
    const [x, , z] = at(f, 0, rows === 1 ? 0 : row === 0 ? ROW_GAP : -ROW_GAP, 0);
    let r: Frame = { x, z, fx: -f.fz, fz: f.fx, scale: f.scale };
    if (ground) {
      const [[ax, , az], [bx, , bz]] = [at(r, 0, -half, 0), at(r, 0, half, 0)];
      r = { ...r, slope: slopeThrough(ground, mesh.lift, [ax, az], [bx, bz]) };
    }
    tube(mesh, r, -half, RAIL, half, RAIL, PROPS.iron, RAIL_BAR);
    for (const e of [-half, half]) tube(mesh, r, e, 0, e, RAIL + RAIL_BAR, PROPS.iron, RAIL_BAR);
  }
  for (const slot of rackSlots(p, seed)) {
    const { f: placed, steer, look } = parkedBike(p, slot, seed);
    const b = ground ? standBike(placed, steer, ground, mesh.lift) : placed;
    const from = mesh.indices;
    addBike(mesh, b, steer, look);
    const y = mesh.lift + at(b, 0, 0, 0)[1];
    parked?.push(from, mesh.indices, b.x, y, b.z, Math.atan2(b.fz, b.fx), look);
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

/**
 * One prop, in its own frame, written into `mesh`; a rack notes its bikes in `parked`, and stands
 * its rails and bikes on `ground` when given.
 */
export function addProp(mesh: MeshBuilder, p: Prop, parked?: number[], ground?: Ground): void {
  const f = {
    x: p.x,
    z: p.z,
    fx: Math.cos(p.angle),
    fz: Math.sin(p.angle),
    scale: propScale(p.kind),
  };
  const seed = propSeed(p.x, p.z);
  if (isMonument(p.kind)) addMonument(mesh, f, p.kind, p, seed);
  else if (p.kind === 'bikes') addRack(mesh, f, p, seed, parked, ground);
  else MODELS[p.kind as Furniture](mesh, f);
}
