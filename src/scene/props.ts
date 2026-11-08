import { isMonument } from '../data/city.ts';
import type { MonumentKind, Prop, PropKind } from '../data/city.ts';
import {
  BIKE_HALF_LENGTH,
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
import { at, away, box, fan, panel, prism, slopeThrough } from './prop-shapes.ts';
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
/**
 * How thick a bike's frame is drawn, its two faces apart (m): out past the spokes either side of
 * the tyre (`wheel`), short of the chain guard.
 */
const FRAME = 0.04;
/** A wheel's radius (m). */
const WHEEL = 0.34;
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
/** A hoop of a rack: how long, how high, how round its corners and how thick its tube (m). */
const HOOP = { half: 0.42, high: 0.82, corner: 0.2, tube: 0.026 } as const;
/** A rack of this many stands has a roof, ribbed so the bikes under it still show. */
const COVERED = 14;
const SHELTER = { high: 2.25, post: 0.05, rib: 0.14, glass: 0.32 } as const;

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
/** Whether (x, z) is out in the open, with no house on it: what a rack's roof asks. */
export type Open = (x: number, z: number) => boolean;

/**
 * A bike's frame stood on the drawn ground: sheared onto the plane through the ground under its
 * two wheels (`slopeThrough`), so both tyres touch it on a slope or across a kerb.
 */
export function standBike(f: Frame, steer: number, ground: Ground, lift: number): Frame {
  const [rx, , rz] = at(f, 0, -AXLE, 0);
  const [fx, , fz] = at(steered(f, steer), 0, AXLE - STEERING, 0);
  return { ...f, slope: slopeThrough(ground, lift, [rx, rz], [fx, fz]) };
}

/**
 * A tube in a frame's v-y plane, from (v, y) to (v, y), as a strip `w` wide seen from both
 * sides, as thick as a frame (`FRAME`).
 */
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
    FRAME * f.scale,
  );
}

/** A wheel's tyre as a ring of this many sides, a corner on the ground. */
const TYRE_SIDES = 14;
/** How thick the tyre and the rim inside it are (m), and how wide a spoke and a mudguard are. */
const TYRE = 0.05;
const SPOKE = 0.013;
const GUARD = 0.022;
/** Three spokes across the wheel: six from the hub, sparse enough to see the street through. */
const SPOKES = 3;

/** The indices of a ring of quads, `n` sections round, inner corners after the outer ones. */
function ringFaces(n: number, closed: boolean): number[][] {
  const faces: number[][] = [];
  for (let i = 0; i < n - (closed ? 0 : 1); i++) {
    const j = closed ? (i + 1) % n : i + 1;
    faces.push([i, j, n + j], [i, n + j, n + i]);
  }
  return faces;
}
const TYRE_FACES = ringFaces(TYRE_SIDES, true);

/**
 * A round wheel you can see through: a dark tyre as an open ring, seen from both sides, a corner
 * on the ground, a few thin spokes turned by `turn`, and a hub. 56 triangles.
 */
function wheel(mesh: MeshBuilder, f: Frame, v: number, turn: number): void {
  const r = WHEEL;
  const inner = r - TYRE;
  const point = (t: number, radius: number, u: number): V3 =>
    at(f, u, v + Math.cos(t) * radius, r + Math.sin(t) * radius);
  for (const side of [-1, 1]) {
    const u = side * 0.016;
    // Spokes a hair inside the tyre's plane and the hub a hair outside it, so none z-fight there.
    const spokeU = u * 0.7;
    const ring = (radius: number) =>
      Array.from({ length: TYRE_SIDES }, (_, i) =>
        point((i * 2 * Math.PI) / TYRE_SIDES - Math.PI / 2, radius, u),
      );
    mesh.polygon([...ring(r), ...ring(inner)], TYRE_FACES, PROPS.wheel, away(f, side, 0));
    for (let k = 0; k < SPOKES; k++) {
      const t = turn + (k * Math.PI) / SPOKES;
      const [dv, dy] = [-Math.sin(t) * SPOKE, Math.cos(t) * SPOKE];
      const [cv, cy] = [Math.cos(t) * inner, Math.sin(t) * inner];
      mesh.quad(
        at(f, spokeU, v - cv - dv, r - cy - dy),
        at(f, spokeU, v + cv - dv, r + cy - dy),
        at(f, spokeU, v + cv + dv, r + cy + dy),
        at(f, spokeU, v - cv + dv, r - cy + dy),
        PROPS.spokes,
        away(f, side, 0),
      );
    }
    mesh.polygon(
      Array.from({ length: 6 }, (_, i) => point((i * Math.PI) / 3, 0.055, u * 1.4)),
      fan(6),
      PROPS.iron,
      away(f, side, 0),
    );
  }
}

/** A mudguard over a wheel at v, from `start` to `end` round it (radians), thin and seen from both sides. */
function mudguard(
  mesh: MeshBuilder,
  f: Frame,
  v: number,
  start: number,
  end: number,
  color: number,
): void {
  const n = 6;
  const faces = ringFaces(n, false);
  for (const side of [-1, 1]) {
    const u = side * 0.03;
    const arc = (radius: number) =>
      Array.from({ length: n }, (_, i) => {
        const t = start + ((end - start) * i) / (n - 1);
        return at(f, u, v + Math.cos(t) * radius, WHEEL + Math.sin(t) * radius);
      });
    mesh.polygon(
      [...arc(WHEEL + 0.05), ...arc(WHEEL + 0.05 - GUARD * 2)],
      faces,
      color,
      away(f, side, 0),
    );
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
 * round wheels you can see the street through, the front one turned by `steer`; a filled rear triangle that carries
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
  mudguard(mesh, f, -AXLE, 0.25, 2.5, color);
  mudguard(mesh, front, axle, 0.5, 2.75, color);
  // The rear triangle (stays, seat tube) from the rear axle, bracket and seat.
  panel(
    mesh,
    [at(f, 0, -AXLE, WHEEL), at(f, 0, ...BRACKET), at(f, 0, -0.24, SADDLE - 0.05)],
    color,
    FRAME * f.scale,
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
    [at(f, -0.04, -0.12, 0.3), at(f, -0.04, -0.07, 0.3), at(f, -0.09, -0.16, 0.05)],
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
      FRAME * f.scale,
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
 * A hoop: an arch of galvanised tube standing across the row, as Leuven's stands are, two bikes to
 * one (`perRow` stands make `perRow / 2` of them). One strip of tube round it, its outer and inner
 * edges, seen from both sides. 24 triangles.
 */
const HOOP_POINTS = (() => {
  const { half, high, corner } = HOOP;
  const round = [0, 1, 2, 3].map((k) => (k * Math.PI) / 2 / 3);
  const left = round.map((t): [number, number] => [
    -half + corner - Math.cos(t) * corner,
    high - corner + Math.sin(t) * corner,
  ]);
  const right = left.map(([v, y]): [number, number] => [-v, y]).toReversed();
  return [[-half, 0] as [number, number], ...left, ...right, [half, 0] as [number, number]];
})();
const HOOP_FACES = ringFaces(HOOP_POINTS.length, false);

function hoop(mesh: MeshBuilder, f: Frame): void {
  const { tube: radius } = HOOP;
  const across = HOOP_POINTS.map(([v, y], i) => {
    const [pv, py] = HOOP_POINTS[Math.max(0, i - 1)]!;
    const [nv, ny] = HOOP_POINTS[Math.min(HOOP_POINTS.length - 1, i + 1)]!;
    const [dv, dy] = [nv - pv, ny - py];
    const length = Math.hypot(dv, dy) || 1;
    return [v, y, -dy / length, dv / length] as const;
  });
  for (const side of [-1, 1]) {
    const u = side * radius;
    const strip = (offset: number) =>
      across.map(([v, y, nv, ny]) => at(f, u, v + nv * offset, Math.max(0, y + ny * offset)));
    mesh.polygon([...strip(radius), ...strip(-radius)], HOOP_FACES, PROPS.rack, away(f, side, 0));
  }
}

/** How far a rack's roof reaches from its middle along the bikes (m), its posts inside the footprint. */
const roofHalf = (rows: number) =>
  (rows === 2 ? ROW_GAP : 0) + BIKE_HALF_LENGTH + BIKE_SHIFT - 0.06;

/** Where a rack's roof reaches, seen from above: corners and the middle of each long side. */
function roofCorners(f: Frame, rows: number, halfRow: number): [number, number][] {
  const half = roofHalf(rows);
  return [-halfRow - 0.3, 0, halfRow + 0.3].flatMap((u) =>
    [-half, half].map((v): [number, number] => {
      const [x, , z] = at(f, u, v, 0);
      return [x, z];
    }),
  );
}

/**
 * The roof over a big rack: two posts at each end of the row, a dark beam along each side and
 * ribs across, with gaps between them and pale panes on every other one, so the bikes under it
 * still show from up the street.
 */
function shelter(mesh: MeshBuilder, f: Frame, rows: number, halfRow: number): void {
  const half = roofHalf(rows);
  const { high, post, rib, glass } = SHELTER;
  for (const u of [-halfRow, halfRow]) {
    for (const v of [-half, half]) {
      box(mesh, f, [u - post, u + post], [v - post, v + post], [0, high], PROPS.iron, false);
    }
  }
  for (const v of [-half, half]) {
    box(
      mesh,
      f,
      [-halfRow - 0.3, halfRow + 0.3],
      [v - post, v + post],
      [high, high + 0.12],
      PROPS.iron,
    );
  }
  const ribs = Math.max(3, Math.round((2 * halfRow + 0.3) / (rib + glass + 0.14)));
  const step = (2 * halfRow + 0.3) / ribs;
  for (let i = 0; i <= ribs; i++) {
    const u = -halfRow - 0.15 + i * step;
    box(
      mesh,
      f,
      [u - 0.035, u + 0.035],
      [-half - 0.06, half + 0.06],
      [high + 0.1, high + 0.14],
      PROPS.iron,
    );
    if (i < ribs) {
      const [a, b] = [u + 0.1, u + 0.1 + glass];
      mesh.quad(
        at(f, a, -half, high + 0.13),
        at(f, b, -half, high + 0.13),
        at(f, b, half, high + 0.13),
        at(f, a, half, high + 0.13),
        PROPS.glass,
        [0, 1, 0],
      );
    }
  }
}

/**
 * A rack: a row of hoops, one for every two stands, so it reads as a rack half empty and looks like
 * one full, then its bikes, each noted in `parked` (see `PARKED`). Each hoop stands on the ground
 * drawn under it when `ground` is given, and each bike on the ground under its wheels; a big rack
 * has a roof over it (`COVERED`).
 */
function addRack(
  mesh: MeshBuilder,
  f: Frame,
  p: Prop,
  seed: number,
  parked?: number[],
  ground?: Ground,
  open: Open = () => true,
): void {
  const { rows, perRow } = rackRows(p.size);
  const half = ((perRow - 1) / 2) * STAND_SPACING;
  for (let row = 0; row < rows; row++) {
    const [x, , z] = at(f, 0, rows === 1 ? 0 : row === 0 ? ROW_GAP : -ROW_GAP, 0);
    for (let k = 0; k < perRow; k += 2) {
      // Between two stands; an odd row's last hoop stands at its last.
      const u = ((k + 1 < perRow ? k + 0.5 : k) - (perRow - 1) / 2) * STAND_SPACING;
      const [hx, , hz] = at({ ...f, x, z }, u, 0, 0);
      let h: Frame = { ...f, x: hx, z: hz };
      if (ground) {
        const [[ax, , az], [bx, , bz]] = [at(h, 0, -HOOP.half, 0), at(h, 0, HOOP.half, 0)];
        h = { ...h, slope: slopeThrough(ground, mesh.lift, [ax, az], [bx, bz]) };
      }
      hoop(mesh, h);
    }
  }
  const clear = roofCorners(f, rows, half).every(([x, z]) => open(x, z));
  if (p.size >= COVERED && clear) shelter(mesh, f, rows, half);
  for (const slot of rackSlots(p, seed)) {
    const { f: placed, steer, look } = parkedBike(p, slot, seed);
    const b = ground ? standBike(placed, steer, ground, mesh.lift) : placed;
    const from = mesh.indices;
    addBike(mesh, b, steer, look);
    const y = mesh.lift + at(b, 0, 0, 0)[1];
    parked?.push(from, mesh.indices, b.x, y, b.z, Math.atan2(b.fz, b.fx), look);
  }
}

/** A lantern's panes: half their width at the foot, their heights, and how much they widen. */
const PANES = { half: 0.14, y: [3.86, 4.44] as const, flare: 1.32 } as const;

type Furniture = Exclude<PropKind, MonumentKind | 'bikes'>;
const MODELS: Record<Furniture, (mesh: MeshBuilder, f: Frame) => void> = {
  lamp(mesh, f) {
    // A cast-iron foot, a slim post with a collar under the lantern, and a lantern that widens
    // upward under its cap and finial.
    prism(mesh, f, [0, 0], [0.12, 0.12], [0, 0.32], PROPS.iron, 0.9, 8, false);
    prism(mesh, f, [0, 0], [0.108, 0.108], [0.32, 0.72], PROPS.iron, 0.5, 8, false);
    box(mesh, f, [-0.05, 0.05], [-0.05, 0.05], [0.72, 3.74], PROPS.iron, false);
    prism(mesh, f, [0, 0], [0.11, 0.11], [3.7, 3.86], PROPS.iron, 1.25, 4);
    prism(mesh, f, [0, 0], [PANES.half, PANES.half], PANES.y, PROPS.lantern, PANES.flare, 4, false);
    prism(
      mesh,
      f,
      [0, 0],
      [PANES.half * PANES.flare + 0.05, PANES.half * PANES.flare + 0.05],
      [PANES.y[1], PANES.y[1] + 0.26],
      PROPS.iron,
      0.12,
      4,
    );
    prism(
      mesh,
      f,
      [0, 0],
      [0.035, 0.035],
      [PANES.y[1] + 0.22, PANES.y[1] + 0.4],
      PROPS.iron,
      0.5,
      4,
    );
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
 * A lantern as it looks lit at night, for the glow mesh (createGlowMaterial): the panes of the
 * lantern `MODELS.lamp` draws, a hair larger so they cover them. The light it throws is baked
 * (lamp-light.ts). 12 triangles.
 */
export function addLampGlow(mesh: MeshBuilder, p: Prop): void {
  const f = {
    x: p.x,
    z: p.z,
    fx: Math.cos(p.angle),
    fz: Math.sin(p.angle),
    scale: propScale('lamp'),
  };
  prism(
    mesh,
    f,
    [0, 0],
    [PANES.half + 0.01, PANES.half + 0.01],
    PANES.y,
    PROPS.lamplight,
    PANES.flare,
    4,
    true,
    1,
  );
}

/**
 * One prop, in its own frame, written into `mesh`; a rack notes its bikes in `parked`, and stands
 * its rails and bikes on `ground` when given.
 */
export function addProp(
  mesh: MeshBuilder,
  p: Prop,
  parked?: number[],
  ground?: Ground,
  open?: Open,
): void {
  const f = {
    x: p.x,
    z: p.z,
    fx: Math.cos(p.angle),
    fz: Math.sin(p.angle),
    scale: propScale(p.kind),
  };
  const seed = propSeed(p.x, p.z);
  if (isMonument(p.kind)) addMonument(mesh, f, p.kind, p, seed);
  else if (p.kind === 'bikes') addRack(mesh, f, p, seed, parked, ground, open);
  else MODELS[p.kind as Furniture](mesh, f);
}
