import type { Prop, PropKind } from '../data/city.ts';
import {
  BIKE_SHIFT,
  HANDLEBAR,
  ROW_GAP,
  STAND_SPACING,
  propScale,
  rackRows,
} from '../data/props.ts';
import { GROUND, BIKES, PROPS, pick } from './palette.ts';
import type { MeshBuilder, V3 } from './mesh-builder.ts';

/**
 * Low-poly street furniture, a few boxes and panels each, written into a cell's props mesh.
 * Models are true to life, then drawn a third larger (`propScale`), as a diorama does: at life
 * size a lamp post or a bike is a pixel or two even zoomed in. Each prop stands in its own frame:
 * v along its facing (see `placeProps`), u across it, within the footprint the bake keeps clear.
 */

/** Props that stay in view at every zoom, in the cell's main mesh; the rest hide when far. */
export const LARGE_PROPS: ReadonlySet<PropKind> = new Set(['needle']);
/** Share of a rack's stands that hold a bike. Leuven's racks are rarely empty. */
const OCCUPANCY = 0.75;
/** Half a bike tube's width: chunky, so a frame still shows its colour zoomed out (m). */
const TUBE = 0.045;
/** A wheel's pale hub (corner to middle), and half a saddle's width (m). */
const HUB = 0.25;
const SADDLE = 0.07;

interface Frame {
  x: number;
  z: number;
  /** Facing (v) and side (u) directions in (x, z). */
  fx: number;
  fz: number;
  scale: number;
}

const at = (f: Frame, u: number, v: number, y: number): V3 => [
  f.x + (-f.fz * u + f.fx * v) * f.scale,
  y * f.scale,
  f.z + (f.fx * u + f.fz * v) * f.scale,
];
const away = (f: Frame, u: number, v: number, y = 0): V3 => [
  -f.fz * u + f.fx * v,
  y,
  f.fx * u + f.fz * v,
];

/** An upright box: its top and four sides (the bottom is never seen). */
function box(
  mesh: MeshBuilder,
  f: Frame,
  [u0, u1]: readonly [number, number],
  [v0, v1]: readonly [number, number],
  [y0, y1]: readonly [number, number],
  color: number,
  top = true,
): void {
  const [uc, vc] = [(u0 + u1) / 2, (v0 + v1) / 2];
  const sides: [number, number, number, number][] = [
    [u0, v0, u1, v0],
    [u1, v0, u1, v1],
    [u1, v1, u0, v1],
    [u0, v1, u0, v0],
  ];
  for (const [ua, va, ub, vb] of sides) {
    const hint = away(f, (ua + ub) / 2 - uc, (va + vb) / 2 - vc);
    mesh.quad(
      at(f, ua, va, y0),
      at(f, ub, vb, y0),
      at(f, ub, vb, y1),
      at(f, ua, va, y1),
      color,
      hint,
    );
  }
  if (top) {
    mesh.quad(
      at(f, u0, v0, y1),
      at(f, u1, v0, y1),
      at(f, u1, v1, y1),
      at(f, u0, v1, y1),
      color,
      [0, 1, 0],
    );
  }
}

/** A convex polygon's triangles, fanned out from its first corner, by its number of corners. */
const FANS: number[][][] = [];
const fan = (n: number) => (FANS[n] ??= Array.from({ length: n - 2 }, (_, i) => [0, i + 1, i + 2]));

/** A thin panel seen from both sides: glass, a bench leg, a wheel, a frame. */
function panel(mesh: MeshBuilder, corners: readonly V3[], color: number): void {
  const [a, b, c] = corners as [V3, V3, V3];
  const n: V3 = [
    (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
    (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
  ];
  for (const hint of [n, [-n[0], -n[1], -n[2]] as V3]) {
    mesh.polygon(corners, fan(corners.length), color, hint);
  }
}

/** A double cone around a vertical axis: a statue's figure, a beetle, a lantern. */
function spindle(
  mesh: MeshBuilder,
  f: Frame,
  [u, v]: readonly [number, number],
  [ru, rv]: readonly [number, number],
  [y0, ym, y1]: readonly [number, number, number],
  sides: number,
  color: number,
): void {
  const ring = Array.from({ length: sides }, (_, i) => {
    const t = (i / sides) * Math.PI * 2;
    return at(f, u + Math.cos(t) * ru, v + Math.sin(t) * rv, ym);
  });
  const [bottom, tip] = [at(f, u, v, y0), at(f, u, v, y1)];
  for (let i = 0; i < sides; i++) {
    const [a, b] = [ring[i]!, ring[(i + 1) % sides]!];
    const out = away(
      f,
      Math.cos(((i + 0.5) / sides) * Math.PI * 2),
      Math.sin(((i + 0.5) / sides) * Math.PI * 2),
    );
    mesh.triangle(a, b, tip, color, [out[0], 1, out[2]]);
    // Something standing on its widest ring (a spike, a cap) needs no underside.
    if (y0 < ym) mesh.triangle(a, b, bottom, color, [out[0], -1, out[2]]);
  }
}

/** Small integer hash, so a rack's gaps and colours stay put across reloads. */
const hash = (a: number, b: number) => {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b, 0xc2b2ae35);
  h ^= h >>> 15;
  return (Math.imul(h, 0x27d4eb2d) >>> 0) / 2 ** 32;
};

/** A tube in a bike's plane (u fixed), from (v, y) to (v, y), as a thin two-sided strip. */
function tube(
  mesh: MeshBuilder,
  f: Frame,
  u: number,
  [va, ya]: readonly [number, number],
  [vb, yb]: readonly [number, number],
  color: number,
): void {
  const length = Math.hypot(vb - va, yb - ya);
  const [nv, ny] = [((ya - yb) / length) * TUBE, ((vb - va) / length) * TUBE];
  panel(
    mesh,
    [
      at(f, u, va - nv, ya - ny),
      at(f, u, vb - nv, yb - ny),
      at(f, u, vb + nv, yb + ny),
      at(f, u, va + nv, ya + ny),
    ],
    color,
  );
}

/**
 * A diamond in a bike's plane, a hair to one side of the tyre and facing out that way: the
 * wheel's pale rim and spokes, two triangles.
 */
function hub(
  mesh: MeshBuilder,
  f: Frame,
  side: number,
  u: number,
  [v, y]: readonly [number, number],
): void {
  const w = u + side * 0.012;
  mesh.quad(
    at(f, w, v, y + HUB),
    at(f, w, v + HUB, y),
    at(f, w, v, y - HUB),
    at(f, w, v - HUB, y),
    PROPS.spokes,
    away(f, side, 0),
  );
}

/**
 * A city bike, seen side on: hexagonal wheels, dark tyres round a pale hub on either face, a
 * filled rear triangle that carries its colour on the map, top and down tubes, a fork, a saddle
 * and a handlebar across. 41 triangles.
 */
function addBike(mesh: MeshBuilder, f: Frame, u: number, v: number, color: number): void {
  const r = 0.33;
  const [rear, front] = [v - 0.55, v + 0.55];
  for (const c of [rear, front]) {
    const rim = Array.from({ length: 6 }, (_, i) => {
      const t = Math.PI / 2 + (i * Math.PI) / 3;
      return at(f, u, c + Math.cos(t) * r, r + Math.sin(t) * r);
    });
    panel(mesh, rim, PROPS.wheel);
    // On each face, so it reads as a tyre round a rim, not a black disc.
    for (const side of [-1, 1]) hub(mesh, f, side, u, [c, r]);
  }
  const bracket = [v - 0.1, 0.3] as const;
  const seat = [v - 0.28, 0.9] as const;
  const head = [v + 0.38, 0.82] as const;
  panel(mesh, [at(f, u, rear, r), at(f, u, ...bracket), at(f, u, ...seat)], color);
  tube(mesh, f, u, seat, head, color);
  tube(mesh, f, u, bracket, head, color);
  tube(mesh, f, u, [front, r], [v + 0.34, 1], color);
  // The saddle: one dark triangle on the seat, its nose forward.
  mesh.triangle(
    at(f, u - SADDLE, v - 0.4, 0.915),
    at(f, u + SADDLE, v - 0.4, 0.915),
    at(f, u, v - 0.14, 0.915),
    PROPS.wheel,
    [0, 1, 0],
  );
  // The handlebar, across the bike: a flat bar on top, which every view is from above.
  mesh.quad(
    at(f, u - HANDLEBAR, v + 0.31, 1),
    at(f, u + HANDLEBAR, v + 0.31, 1),
    at(f, u + HANDLEBAR, v + 0.37, 1),
    at(f, u - HANDLEBAR, v + 0.37, 1),
    PROPS.wheel,
    [0, 1, 0],
  );
}

function addBikes(mesh: MeshBuilder, f: Frame, stands: number, seed: number): void {
  const { rows, perRow } = rackRows(stands);
  for (let row = 0; row < rows; row++) {
    // A second row stands behind the first, away from the kerb.
    const v = rows === 1 ? 0 : row === 0 ? ROW_GAP : -ROW_GAP;
    for (let i = 0; i < perRow; i++) {
      const slot = row * perRow + i;
      if (hash(seed, slot) > OCCUPANCY) continue;
      const u = (i - (perRow - 1) / 2) * STAND_SPACING;
      // Bikes are never parked quite straight.
      const shift = (hash(seed + 1, slot) - 0.5) * 2 * BIKE_SHIFT;
      addBike(mesh, f, u, v + shift, pick(BIKES, seed * 31 + slot));
    }
  }
}

function addFigure(mesh: MeshBuilder, f: Frame, y0: number, height: number): void {
  spindle(mesh, f, [0, 0], [0.32, 0.32], [y0, y0 + height * 0.45, y0 + height], 6, PROPS.bronze);
}

const MODELS: Record<PropKind, (mesh: MeshBuilder, f: Frame, p: Prop, seed: number) => void> = {
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
  bikes(mesh, f, p, seed) {
    addBikes(mesh, f, p.size, seed);
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
  statue(mesh, f, p) {
    // A tagged height is drawn true; untagged statues are a typical one, drawn large.
    const height = p.size ? p.size / f.scale : 3.2;
    box(mesh, f, [-0.6, 0.6], [-0.6, 0.6], [0, height * 0.4], PROPS.stone);
    addFigure(mesh, f, height * 0.4, height * 0.6);
  },
  fountain(mesh, f) {
    const sides = 8;
    const radius = 2;
    const rim = (i: number, r: number, y: number) => {
      const t = (i / sides) * Math.PI * 2;
      return at(f, Math.cos(t) * r, Math.sin(t) * r, y);
    };
    for (let i = 0; i < sides; i++) {
      const out = away(
        f,
        Math.cos(((i + 0.5) / sides) * Math.PI * 2),
        Math.sin(((i + 0.5) / sides) * Math.PI * 2),
      );
      mesh.quad(
        rim(i, radius, 0),
        rim(i + 1, radius, 0),
        rim(i + 1, radius, 0.5),
        rim(i, radius, 0.5),
        PROPS.stone,
        out,
      );
      mesh.triangle(
        rim(i, radius, 0.42),
        rim(i + 1, radius, 0.42),
        at(f, 0, 0, 0.42),
        GROUND.water,
        [0, 1, 0],
      );
    }
    box(mesh, f, [-0.25, 0.25], [-0.25, 0.25], [0, 1.6], PROPS.stone);
    addFigure(mesh, f, 1.6, 1.1);
  },
  pump(mesh, f) {
    box(mesh, f, [-0.3, 0.3], [-0.3, 0.3], [0, 2], PROPS.stone, false);
    spindle(mesh, f, [0, 0], [0.42, 0.42], [2, 2, 2.6], 4, PROPS.stone);
  },
  needle(mesh, f, p) {
    const height = p.size;
    spindle(mesh, f, [0, 0], [0.8, 0.8], [0, 0, height], 4, PROPS.iron);
    // The beetle, speared lengthwise near the top: drawn larger than life so it reads from afar.
    spindle(
      mesh,
      f,
      [0, 0],
      [1.4, 2.4],
      [height * 0.72, height * 0.77, height * 0.84],
      8,
      PROPS.beetle,
    );
  },
};

/** One prop, in its own frame, written into `mesh`. */
export function addProp(mesh: MeshBuilder, p: Prop): void {
  const f = {
    x: p.x,
    z: p.z,
    fx: Math.cos(p.angle),
    fz: Math.sin(p.angle),
    scale: propScale(p.kind),
  };
  MODELS[p.kind](mesh, f, p, Math.round(p.x * 7) ^ Math.round(p.z * 13));
}
