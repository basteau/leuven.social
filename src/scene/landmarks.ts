import type { Tower } from '../data/city.ts';
import { orientedRect } from '../data/geometry.ts';
import { LANCETS } from './facade-codes.ts';
import type { LineBuilder, MeshBuilder, V3 } from './mesh-builder.ts';

/**
 * Hero landmarks as a few low-poly parts placed in their footprint's frame: u runs along the
 * footprint's long side (its oriented rectangle), v across it, both in metres from its centre.
 * The parts are fitted by hand to the LiDAR heights, so they stay true to the real building.
 */

/** A rectangular body with walls up to `eave` and a ridge roof (or a flat one). */
export interface Hall {
  type: 'hall';
  u: number;
  v: number;
  /** Half length along the ridge and half width across it. */
  length: number;
  width: number;
  /** The ridge runs along v instead of u, as in a transept. */
  across?: boolean;
  /** Bottom of the walls: dormers start on the roof. */
  from?: number;
  eave: number;
  /** Left out for a flat roof. */
  ridge?: number;
  /** How far the ridge stops short of each end: 0 is a gable, `width` a full hip. */
  hips?: readonly [number, number];
  windows?: boolean;
  wall?: number;
}

/** A square or octagonal tower or turret, topped by a pointed spire (or flat). */
export interface Spire {
  type: 'spire';
  u: number;
  v: number;
  /** Distance from the axis to each corner. */
  radius: number;
  sides: 4 | 8;
  from?: number;
  /** Top of the walls. */
  top: number;
  /** Tip of the spire; at or below `top` for a flat cap. */
  tip: number;
  wall?: number;
  roof?: number;
}

export type Part = Hall | Spire;

export interface LandmarkModel {
  /** Height the whole footprint is extruded to under the parts, instead of the LiDAR p90. */
  base: number;
  wall: number;
  roof: number;
  /** Whether the base and halls get the window grid, or a church's lancets. */
  windows: boolean | 'lancet';
  parts: readonly Part[];
}

interface Frame {
  cx: number;
  cz: number;
  ux: number;
  uz: number;
}

const point = (f: Frame, u: number, v: number, y: number): V3 => [
  f.cx + f.ux * u - f.uz * v,
  y,
  f.cz + f.uz * u + f.ux * v,
];

function addHall(mesh: MeshBuilder, lines: LineBuilder, f: Frame, h: Hall, m: LandmarkModel): void {
  const wall = h.wall ?? m.wall;
  const ridge = h.ridge ?? h.eave;
  const [h0, h1] = h.hips ?? [0, 0];
  // p runs along the ridge, q across it, both in the footprint frame's units.
  const at = (p: number, q: number, y: number): V3 =>
    h.across ? point(f, h.u - q, h.v + p, y) : point(f, h.u + p, h.v + q, y);
  const out = (p: number, q: number, y = 0): V3 => {
    const [x, , z] = at(p, q, 0);
    const [ox, , oz] = at(0, 0, 0);
    return [x - ox, y, z - oz];
  };
  const { length: L, width: W, eave, from = 0 } = h;
  const facade = m.windows === 'lancet' ? eave + LANCETS : h.windows && m.windows ? eave : 0;
  const corners = [
    [-L, -W],
    [L, -W],
    [L, W],
    [-L, W],
  ] as const;
  for (let i = 0; i < 4; i++) {
    const [ap, aq] = corners[i]!;
    const [bp, bq] = corners[(i + 1) % 4]!;
    const hint = out((ap + bp) / 2, (aq + bq) / 2);
    mesh.quad(
      at(ap, aq, from),
      at(bp, bq, from),
      at(bp, bq, eave),
      at(ap, aq, eave),
      wall,
      hint,
      facade,
    );
    lines.segment(at(ap, aq, eave), at(bp, bq, eave));
    lines.segment(at(ap, aq, from), at(ap, aq, eave));
  }

  if (ridge <= eave) {
    mesh.quad(
      at(-L, -W, eave),
      at(L, -W, eave),
      at(L, W, eave),
      at(-L, W, eave),
      m.roof,
      [0, 1, 0],
    );
    return;
  }
  const r0 = at(-L + h0, 0, ridge);
  const r1 = at(L - h1, 0, ridge);
  for (const q of [W, -W]) {
    mesh.quad(at(-L, q, eave), at(L, q, eave), r1, r0, m.roof, out(0, q, W));
    lines.segment(at(-L, q, eave), r0);
    lines.segment(at(L, q, eave), r1);
  }
  // Each end is a wall gable, or a roof hip when the ridge stops short of it.
  for (const [p, hip, r] of [
    [L, h1, r1],
    [-L, h0, r0],
  ] as const) {
    const hint = out(p, 0, hip > 0 ? Math.abs(p) : 0);
    mesh.triangle(at(p, -W, eave), at(p, W, eave), r, hip > 0 ? m.roof : wall, hint);
  }
  lines.segment(r0, r1);
}

function addSpire(
  mesh: MeshBuilder,
  lines: Pick<LineBuilder, 'segment'>,
  f: Frame,
  s: Spire,
  wall: number,
  roof: number,
): void {
  const from = s.from ?? 0;
  // Square towers sit square to the footprint; octagons put a face towards each axis too.
  const turn = Math.PI / s.sides;
  const ring = Array.from({ length: s.sides }, (_, k) => {
    const a = turn + (k * 2 * Math.PI) / s.sides;
    return [s.u + Math.cos(a) * s.radius, s.v + Math.sin(a) * s.radius] as const;
  });
  const centre = point(f, s.u, s.v, 0);
  const outward = (a: V3, b: V3, y: number): V3 => [
    (a[0] + b[0]) / 2 - centre[0],
    y,
    (a[2] + b[2]) / 2 - centre[2],
  ];
  const apex = point(f, s.u, s.v, Math.max(s.tip, s.top));
  const square = s.sides === 4;
  for (let k = 0; k < s.sides; k++) {
    const [au, av] = ring[k]!;
    const [bu, bv] = ring[(k + 1) % s.sides]!;
    const a = point(f, au, av, s.top);
    const b = point(f, bu, bv, s.top);
    mesh.quad(point(f, au, av, from), point(f, bu, bv, from), b, a, wall, outward(a, b, 0));
    if (s.tip > s.top) mesh.triangle(a, b, apex, roof, outward(a, b, s.radius));
    else mesh.triangle(a, b, apex, roof, [0, 1, 0]);
    lines.segment(a, b);
    // Octagon corners are too close together for ink: only square towers get their edges.
    if (square) {
      lines.segment(point(f, au, av, from), a);
      if (s.tip > s.top) lines.segment(a, apex);
    }
  }
}

/** The landmark's parts on top of its footprint, which the caller extrudes to `model.base`. */
export function addLandmark(
  mesh: MeshBuilder,
  lines: LineBuilder,
  ring: ArrayLike<number>,
  model: LandmarkModel,
): void {
  const frame = orientedRect(ring);
  for (const part of model.parts) {
    if (part.type === 'hall') addHall(mesh, lines, frame, part, model);
    else addSpire(mesh, lines, frame, part, part.wall ?? model.wall, part.roof ?? model.roof);
  }
}

/** Under this radius (m) a church's tower is a slender spire on the ridge: an octagon. */
const TURRET = 2;

/**
 * A church's tower from the LiDAR (tools/build_leuven_data.py), square to its footprint, in the
 * church's walls under a slate spire: the same tower a landmark model would get.
 */
export function addTower(
  mesh: MeshBuilder,
  lines: Pick<LineBuilder, 'segment'>,
  ring: ArrayLike<number>,
  tower: Tower,
  wall: number,
  roof: number,
): void {
  const { ux, uz } = orientedRect(ring);
  const sides = tower.radius < TURRET ? 8 : 4;
  const { radius, top, tip } = tower;
  const spire: Spire = { type: 'spire', u: 0, v: 0, radius, sides, top, tip };
  addSpire(mesh, lines, { cx: tower.x, cz: tower.z, ux, uz }, spire, wall, roof);
}
