import type { Prop, PropKind } from '../data/city.ts';
import { GROUND, BIKES, PROPS, pick } from './palette.ts';
import type { MeshBuilder, V3 } from './mesh-builder.ts';

/**
 * Low-poly street furniture, a few boxes and panels each, written into a cell's props mesh.
 * Models are true to life, then drawn a third larger, as a diorama does: at life size a lamp
 * post or a bike is a pixel or two even zoomed in. Each prop stands in its own frame: v along
 * its facing (towards the nearest kerb, path or wall), u across it.
 */

/** Props that stay in view at every zoom, in the cell's main mesh; the rest hide when far. */
export const LARGE_PROPS: ReadonlySet<PropKind> = new Set(['needle']);
/** How much larger than life small props are drawn. */
export const PROP_SCALE = 1.3;
/** Share of a rack's stands that hold a bike. Leuven's racks are rarely empty. */
const OCCUPANCY = 0.8;
/** Stands per row; bigger racks get a second row, back to back. */
const ROW = 12;
const STAND_SPACING = 0.7;

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

/** A thin panel seen from both sides: glass, a bench leg, a wheel, a frame. */
function panel(mesh: MeshBuilder, corners: readonly V3[], color: number): void {
  const [a, b, c] = corners as [V3, V3, V3];
  const n: V3 = [
    (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
    (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
  ];
  for (const hint of [n, [-n[0], -n[1], -n[2]] as V3]) {
    for (let i = 1; i + 1 < corners.length; i++) {
      mesh.triangle(a, corners[i]!, corners[i + 1]!, color, hint);
    }
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

function addBike(mesh: MeshBuilder, f: Frame, u: number, v: number, color: number): void {
  const r = 0.33;
  const [rear, front] = [v - 0.55, v + 0.55];
  for (const c of [rear, front]) {
    panel(
      mesh,
      [at(f, u, c - r, r), at(f, u, c, 0), at(f, u, c + r, r), at(f, u, c, 2 * r)],
      PROPS.wheel,
    );
  }
  panel(mesh, [at(f, u, rear, r), at(f, u, front, r), at(f, u, v - 0.15, 0.95)], color);
}

function addBikes(mesh: MeshBuilder, f: Frame, stands: number, seed: number): void {
  const rows = stands > ROW ? 2 : 1;
  const perRow = Math.ceil(stands / rows);
  for (let row = 0; row < rows; row++) {
    // A second row stands behind the first, away from the kerb.
    const v = rows === 1 ? 0 : row === 0 ? 0.9 : -0.9;
    for (let i = 0; i < perRow; i++) {
      const slot = row * perRow + i;
      if (hash(seed, slot) > OCCUPANCY) continue;
      const u = (i - (perRow - 1) / 2) * STAND_SPACING;
      // Bikes are never parked quite straight.
      const shift = (hash(seed + 1, slot) - 0.5) * 0.3;
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
    box(mesh, f, [-0.28, 0.28], [-0.05, 0.05], [2.15, 2.75], PROPS.sign);
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
  const scale = LARGE_PROPS.has(p.kind) ? 1 : PROP_SCALE;
  const f = { x: p.x, z: p.z, fx: Math.cos(p.angle), fz: Math.sin(p.angle), scale };
  MODELS[p.kind](mesh, f, p, Math.round(p.x * 7) ^ Math.round(p.z * 13));
}
