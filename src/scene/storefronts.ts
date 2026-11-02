/**
 * What makes a shop front read from across the street, up close (from zoom 2, with the street
 * furniture): a canvas awning over it, a sign on a bracket for the trades people look for, and a
 * café table with two chairs where OSM maps a terrace (placed by `fitTerraces`). The facade
 * shader already glazes the ground floor under the kind's canvas (facade-material.ts); these are
 * the few shapes it can't paint. Part of the furniture chunk.
 */

import type { Building, ShopFront } from '../data/city.ts';
import { SHOP_KINDS } from '../data/shop-kinds.ts';
import type { ShopKind } from '../data/shop-kinds.ts';
import { END_GAP, MIN_ROOM, awningRoom } from '../data/awnings.ts';
import { TERRACE, frontPoint } from '../data/shops.ts';
import type { FrontPoint } from '../data/shops.ts';
import type { MeshBuilder, V3 } from './mesh-builder.ts';
import { FRONTS, PROPS } from './palette.ts';
import { box } from './prop-shapes.ts';
import type { Frame } from './prop-shapes.ts';

/** The ground floor's height (m) of a wall `top` high, as the facade shader draws its storeys. */
export const groundFloor = (top: number): number =>
  Math.min(4, Math.max(2.8, top / Math.max(1, Math.floor(top / 3.2 + 0.5))));

/**
 * An awning reaches this far out (m), sloping down this much, with a valance this deep. Its low
 * edge stays over the walker's head (PARASOL_RIM, terraces.ts).
 */
const REACH = 1;
const SLOPE = 0.4;
const VALANCE = 0.2;
const LOW_EDGE = 2.6;

/** The trades whose sign people look for down a street. */
const SIGNS = new Set<ShopKind>([
  'frituur',
  'cafe',
  'bar',
  'bakery',
  'pharmacy',
  'icecream',
  'bicycle',
  'books',
  'bank',
]);
/** A sign's board, half its reach out from the wall and half its height (m); a third over life. */
const BOARD = { out: [0.25, 1.15], half: 0.45 } as const;
const PAPER = 0xf6eedc;
const GOLD = 0xe8b94a;
const LOAF = 0xd99a52;
const FRIES = 0xf2cf5b;

/** A front's frame for `box` and `prism`: u along its wall, v out of it, y up from `y`. */
const frame = (p: FrontPoint, along = 0): Frame => ({
  x: p.x + p.ux * along,
  z: p.z + p.uz * along,
  fx: p.nx,
  fz: p.nz,
  scale: 1,
});

/**
 * A canvas awning `half` metres each side of the front: a sloped top, a valance and two side
 * cheeks, 14 vertices. Its `facade` code stripes it in its kind's second colour.
 */
export function addAwning(
  mesh: MeshBuilder,
  p: FrontPoint,
  kind: ShopKind,
  top: number,
  half: number,
  awning: number,
): void {
  const style = FRONTS[kind];
  const y0 = Math.max(0.97 * groundFloor(top), LOW_EDGE + SLOPE + VALANCE);
  const [y1, y2] = [y0 - SLOPE, y0 - SLOPE - VALANCE];
  const at = (t: number, out: number, y: number): V3 => [
    p.x + p.ux * t + p.nx * out,
    y,
    p.z + p.uz * t + p.nz * out,
  ];
  const code = awning + SHOP_KINDS.indexOf(kind);
  const [a, b] = [-half, half];
  mesh.quad(
    at(a, 0.02, y0),
    at(b, 0.02, y0),
    at(b, REACH, y1),
    at(a, REACH, y1),
    style.canvas,
    [p.nx, 1, p.nz],
    code,
  );
  mesh.quad(
    at(a, REACH, y1),
    at(b, REACH, y1),
    at(b, REACH, y2),
    at(a, REACH, y2),
    style.canvas,
    [p.nx, 0, p.nz],
    code,
  );
  for (const [t, s] of [
    [a, -1],
    [b, 1],
  ] as const) {
    mesh.triangle(
      at(t, 0.02, y0),
      at(t, REACH, y1),
      at(t, REACH, y2),
      style.canvas,
      [p.ux * s, 0, p.uz * s],
      code,
    );
  }
}

/**
 * A sign on an iron bracket, square to the wall so it reads down the street, at the first-floor
 * sill: a board in the kind's colour with its token through it (a cup, a pint, a loaf, an ice),
 * a pharmacy's green cross, a frituur's cone of fries. 40 to 95 vertices.
 */
export function addSign(mesh: MeshBuilder, f: Frame, kind: ShopKind, top: number): void {
  const canvas = FRONTS[kind].canvas;
  const y = Math.max(groundFloor(top) + 0.6, LOW_EDGE + BOARD.half + 0.1);
  const [o0, o1] = BOARD.out;
  const mid = (o0 + o1) / 2;
  box(mesh, f, [-0.03, 0.03], [0, o1], [y + BOARD.half, y + BOARD.half + 0.06], PROPS.iron);
  const token = (u: number, v: number, h: number, color: number, dy = 0) =>
    box(mesh, f, [-u, u], [mid - v, mid + v], [y + dy - h, y + dy + h], color);
  if (kind === 'pharmacy') {
    token(0.06, 0.15, BOARD.half, canvas);
    token(0.06, BOARD.half, 0.15, canvas);
    return;
  }
  if (kind === 'frituur') {
    // A paper cone, wider at the top, with three fries standing out of it.
    const [u, v] = [0, mid];
    prismCone(mesh, f, u, v, y);
    for (const [du, dv, h] of [
      [-0.06, -0.08, 0.36],
      [0.04, 0.1, 0.42],
      [0.02, -0.02, 0.3],
    ] as const) {
      triangleColumn(mesh, f, du, mid + dv, y + 0.15, y + 0.15 + h);
    }
    return;
  }
  box(mesh, f, [-0.04, 0.04], [o0, o1], [y - BOARD.half, y + BOARD.half], canvas);
  if (kind === 'cafe') token(0.1, 0.16, 0.13, PAPER);
  else if (kind === 'bar') token(0.1, 0.11, 0.24, GOLD);
  else if (kind === 'bakery') token(0.1, 0.27, 0.11, LOAF);
  else if (kind === 'icecream') token(0.1, 0.13, 0.2, PAPER, 0.08);
}

/** A cone of six sides hanging point down from y + 0.15, and the fries' top filling it. */
function prismCone(mesh: MeshBuilder, f: Frame, u: number, v: number, y: number): void {
  const ring = (r: number, h: number) =>
    Array.from({ length: 6 }, (_, i): V3 => {
      const t = ((i + 0.5) / 6) * Math.PI * 2;
      const [cu, cv] = [u + Math.cos(t) * r, v + Math.sin(t) * r];
      return [f.x - f.fz * cu + f.fx * cv, h, f.z + f.fx * cu + f.fz * cv];
    });
  const [low, high] = [ring(0.06, y - BOARD.half), ring(0.24, y + 0.15)];
  for (let i = 0; i < 6; i++) {
    const j = (i + 1) % 6;
    const out: V3 = [high[i]![0] + high[j]![0] - 2 * f.x, 0, high[i]![2] + high[j]![2] - 2 * f.z];
    mesh.quad(low[i]!, low[j]!, high[j]!, high[i]!, 0xd2553f, out);
  }
  mesh.polygon(
    high,
    [
      [0, 1, 2],
      [0, 2, 3],
      [0, 3, 4],
      [0, 4, 5],
    ],
    FRIES,
    [0, 1, 0],
  );
}

/** A chip: a three-sided column from y0 to y1, capped. */
function triangleColumn(
  mesh: MeshBuilder,
  f: Frame,
  u: number,
  v: number,
  y0: number,
  y1: number,
): void {
  const r = 0.035;
  const corner = (k: number, y: number): V3 => {
    const t = (k / 3) * Math.PI * 2;
    const [cu, cv] = [u + Math.cos(t) * r, v + Math.sin(t) * r];
    return [f.x - f.fz * cu + f.fx * cv, y, f.z + f.fx * cu + f.fz * cv];
  };
  for (let k = 0; k < 3; k++) {
    const t = ((k + 0.5) / 3) * Math.PI * 2;
    const out: V3 = [
      -f.fz * Math.cos(t) + f.fx * Math.sin(t),
      0,
      f.fx * Math.cos(t) + f.fz * Math.sin(t),
    ];
    mesh.quad(corner(k, y0), corner(k + 1, y0), corner(k + 1, y1), corner(k, y1), FRIES, out);
  }
  mesh.triangle(corner(0, y1), corner(1, y1), corner(2, y1), FRIES, [0, 1, 0]);
}

/**
 * A café table with two chairs, along the wall, inside `TERRACE` (src/data/shops.ts): the pale
 * table on an iron leg, the chairs in the café's colour, their backs outward. 148 vertices.
 */
export function addTerrace(mesh: MeshBuilder, p: FrontPoint, kind: ShopKind): void {
  const f = frame({ ...p, x: p.x + p.nx * TERRACE.out, z: p.z + p.nz * TERRACE.out });
  const chair = FRONTS[kind].canvas;
  box(mesh, f, [-0.42, 0.42], [-0.42, 0.42], [0.9, 0.95], PAPER);
  box(mesh, f, [-0.05, 0.05], [-0.05, 0.05], [0, 0.9], PROPS.iron, false);
  for (const s of [-1, 1]) {
    const c = s * 0.85;
    box(mesh, f, [c - 0.22, c + 0.22], [-0.22, 0.22], [0.52, 0.58], chair);
    const back = s * 1.08;
    box(mesh, f, [back - 0.04, back + 0.04], [-0.22, 0.22], [0.58, 1.15], chair);
    box(mesh, f, [c - 0.04, c + 0.04], [-0.04, 0.04], [0, 0.52], PROPS.iron, false);
  }
}

/**
 * What the storefronts take from the engine rather than import (see `FurnitureKit`): where a
 * building stands and its wall top, the ground, and `AWNING` (facade-codes.ts).
 */
export interface StorefrontKit {
  awning: number;
  footing: (b: Building) => number;
  wallTop: (b: Building) => number;
  ground: (x: number, z: number) => number;
}

/**
 * The awnings (into `awnings`, which carries the `facade` attribute for their stripes: on the
 * rest of the furniture it would cost 4 bytes a vertex), signs and terraces of a cell's fronts. An awning spans its front, but stops short
 * of the next front along the same wall, and of the wall's ends; a sign hangs at an end of it.
 */
export function addStorefronts(
  mesh: MeshBuilder,
  awnings: MeshBuilder,
  fronts: readonly { building: Building; front: ShopFront }[],
  kit: StorefrontKit,
): void {
  const [lift, awningLift] = [mesh.lift, awnings.lift];
  for (const { building, front } of fronts) {
    const p = frontPoint(building.ring, front);
    const top = kit.wallTop(building);
    const others = fronts
      .filter((o) => o.building === building && o.front.edge === front.edge && o.front !== front)
      .map((o) => o.front.along);
    const room = awningRoom(front.along, p.length, others);
    if (room <= MIN_ROOM) continue;
    mesh.lift = awnings.lift = kit.footing(building);
    if (FRONTS[front.kind].awning) addAwning(awnings, p, front.kind, top, room, kit.awning);
    // Beside the awning, at the end with room.
    const end = [room + 0.3, -room - 0.3].find(
      (t) => front.along + t >= END_GAP && front.along + t <= p.length - END_GAP,
    );
    if (SIGNS.has(front.kind) && end !== undefined) addSign(mesh, frame(p, end), front.kind, top);
    if (front.terrace) {
      mesh.lift = kit.ground(p.x + p.nx * TERRACE.out, p.z + p.nz * TERRACE.out);
      addTerrace(mesh, p, front.kind);
    }
  }
  [mesh.lift, awnings.lift] = [lift, awningLift];
}
