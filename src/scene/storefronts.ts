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
import { DOOR_PLANT, END_GAP, MIN_ROOM, awningRoom, doorPlants } from '../data/awnings.ts';
import { CAFE_TABLE, TERRACE, frontPoint } from '../data/shops.ts';
import type { FrontPoint } from '../data/shops.ts';
import type { MeshBuilder, V3 } from './mesh-builder.ts';
import { FRONTS, GUESTS, PROPS, pick } from './palette.ts';
import { at as frameAt, away, box, panel, prism } from './prop-shapes.ts';
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
  'restaurant',
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
const WOOD = 0x9a6a42;
const WICKER = 0xc9a46a;
const CHALK = 0x2f3b38;
/** Fronts that put a menu board on the pavement. */
const BOARDS = new Set<ShopKind>([
  'cafe',
  'bar',
  'restaurant',
  'snack',
  'bakery',
  'icecream',
  'frituur',
]);
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
  // A cream rim round the board, the same on every kind, so a sign keeps its edge against any wall.
  box(
    mesh,
    f,
    [-0.03, 0.03],
    [o0 - 0.05, o1 + 0.05],
    [y - BOARD.half - 0.05, y + BOARD.half + 0.05],
    PAPER,
  );
  box(mesh, f, [-0.07, 0.07], [o0, o1], [y - BOARD.half, y + BOARD.half], canvas);
  if (kind === 'restaurant') {
    // A plate between two bars, a knife and a fork.
    token(0.1, 0.12, 0.12, PAPER);
    for (const s of [-1, 1])
      box(
        mesh,
        f,
        [-0.1, 0.1],
        [mid + s * 0.27 - 0.025, mid + s * 0.27 + 0.025],
        [y - 0.2, y + 0.2],
        PAPER,
      );
  } else if (kind === 'cafe') token(0.1, 0.16, 0.13, PAPER);
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
 * table on an iron leg, the chairs in the café's colour turned to it, and guests on some.
 */
export function addTerrace(mesh: MeshBuilder, p: FrontPoint, kind: ShopKind, seed = 0): void {
  const [x, z] = [p.x + p.nx * TERRACE.out, p.z + p.nz * TERRACE.out];
  const color = FRONTS[kind].canvas;
  const layout = roll(seed * 3 + 11);
  if (kind === 'bar' && layout < 0.55) {
    // Standing tables: a tall round top on a post, two glasses and nobody sitting.
    const f: Frame = { x, z, fx: p.nx, fz: p.nz, scale: 1 };
    for (const u of [-0.55, 0.55]) {
      prism(mesh, f, [u, 0], [0.32, 0.32], [1.08, 1.12], PAPER, 1, 6);
      box(mesh, f, [u - 0.04, u + 0.04], [-0.04, 0.04], [0, 1.08], PROPS.iron, false);
      box(mesh, f, [u - 0.04, u + 0.04], [0.06, 0.14], [1.12, 1.3], GUESTS.drinks[0]);
    }
    return;
  }
  if (layout < 0.3) {
    // A bistro pair: one table, two chairs, the first taken.
    addCafeTable(mesh, x, z, p.nx, p.nz, 2, color, seed, true);
  } else if (layout < 0.75) {
    // The same in wicker, whatever the café's colour.
    addCafeTable(mesh, x, z, p.nx, p.nz, 2, WICKER, seed, true);
  } else {
    // A long communal table with a bench each side.
    const f: Frame = { x, z, fx: p.nx, fz: p.nz, scale: 1 };
    box(mesh, f, [-0.95, 0.95], [-0.2, 0.2], [0.9, 0.95], WOOD);
    for (const u of [-0.8, 0.8]) {
      box(mesh, f, [u - 0.04, u + 0.04], [-0.15, 0.15], [0, 0.9], PROPS.iron, false);
    }
    for (const v of [-0.34, 0.34]) {
      box(mesh, f, [-0.9, 0.9], [v - 0.1, v + 0.1], [0.44, 0.5], color);
      for (const u of [-0.7, 0.7]) {
        box(mesh, f, [u - 0.04, u + 0.04], [v - 0.04, v + 0.04], [0, 0.44], PROPS.iron, false);
      }
    }
  }
}

/** A sandwich board on the pavement by a door: two chalk-black leaves in a wooden A-frame, no words. */
export function addBoard(mesh: MeshBuilder, f: Frame): void {
  for (const s of [-1, 1]) {
    mesh.quad(
      frameAt(f, -0.3, s * 0.32, 0),
      frameAt(f, 0.3, s * 0.32, 0),
      frameAt(f, 0.3, 0, 0.95),
      frameAt(f, -0.3, 0, 0.95),
      CHALK,
      away(f, 0, s, 0.4),
    );
  }
  box(mesh, f, [-0.33, 0.33], [-0.03, 0.03], [0.93, 0.98], WOOD);
  // A few pale chalk lines of menu, no readable words.
  for (const y of [0.55, 0.42, 0.3]) {
    panel(
      mesh,
      [
        frameAt(f, -0.18, 0.15 * (1 - y / 0.95) + 0.015, y),
        frameAt(f, 0.18, 0.15 * (1 - y / 0.95) + 0.015, y),
        frameAt(f, 0.18, 0.15 * (1 - y / 0.95) + 0.015, y + 0.035),
        frameAt(f, -0.18, 0.15 * (1 - y / 0.95) + 0.015, y + 0.035),
      ],
      PAPER,
    );
  }
}

/** Pots in terracotta or anthracite, and the bay's two greens. */
const POTS = [0xb5653f, 0x4a4e57] as const;
const BAY = [0x3f7a3a, 0x2f6436] as const;

/**
 * A clipped bay tree in a pot beside a café's door (`doorPlants`): a pot a little wider at the
 * top and a cone of leaves on it. 50 vertices.
 */
export function addDoorPlant(mesh: MeshBuilder, f: Frame, seed: number): void {
  const r = DOOR_PLANT.radius;
  prism(mesh, f, [0, 0], [r * 0.8, r * 0.8], [0, 0.5], POTS[seed % 2]!, 1.25);
  prism(mesh, f, [0, 0], [r * 1.25, r * 1.25], [0.5, 1.6], BAY[(seed >> 1) % 2]!, 0.15, 6);
}

/** Of the chairs at a table, the share someone sits on. */
const TAKEN = 0.55;
/** A small, stable number in [0, 1) from a seed, for which chairs are taken and by whom. */
const roll = (seed: number) => {
  const h = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return h - Math.floor(h);
};

/**
 * A café table as seen from all round it: its pale top (on an iron leg, unless a parasol's pole
 * holds it), `seats` chairs in the café's colour turned to it, their backs outward, guests on
 * some of them and a glass in front of each guest. `fx`, `fz` turn it; with two seats they stand
 * either side across that direction, as along a wall. 20 vertices (36 with its leg), 56 a chair,
 * 156 a guest with their glass.
 */
export function addCafeTable(
  mesh: MeshBuilder,
  x: number,
  z: number,
  fx: number,
  fz: number,
  seats: number,
  chair: number,
  seed: number,
  leg: boolean,
): void {
  const f: Frame = { x, z, fx, fz, scale: 1 };
  box(mesh, f, [-0.42, 0.42], [-0.42, 0.42], [0.9, 0.95], PAPER);
  if (leg) box(mesh, f, [-0.05, 0.05], [-0.05, 0.05], [0, 0.9], PROPS.iron, false);
  for (let s = 0; s < seats; s++) {
    const t = Math.PI / 2 + (s * 2 * Math.PI) / seats + (seats === 2 ? 0 : Math.PI / 4);
    const [dx, dz] = [Math.cos(t) * fx - Math.sin(t) * fz, Math.cos(t) * fz + Math.sin(t) * fx];
    const c: Frame = {
      x: x + dx * CAFE_TABLE.chair,
      z: z + dz * CAFE_TABLE.chair,
      fx: dx,
      fz: dz,
      scale: 1,
    };
    box(mesh, c, [-0.22, 0.22], [-0.22, 0.22], [0.52, 0.58], chair);
    box(mesh, c, [-0.22, 0.22], [0.19, 0.27], [0.58, 1.15], chair);
    box(mesh, c, [-0.04, 0.04], [-0.04, 0.04], [0, 0.52], PROPS.iron, false);
    const who = seed * 7 + s;
    if (roll(who) < TAKEN) {
      addGuest(mesh, c, who);
      addGlass(mesh, { ...f, x: x + dx * 0.24, z: z + dz * 0.24 }, who);
    }
  }
}

/**
 * Someone sitting on a chair in frame `c`, its back at +v, facing the table at -v: thighs and
 * shins, a torso in a shirt, forearms on the table's edge, a head and its hair. 116 vertices.
 */
export function addGuest(mesh: MeshBuilder, c: Frame, seed: number): void {
  const legs = pick(GUESTS.legs, seed * 5 + 1);
  const skin = pick(GUESTS.skin, seed * 11 + 2);
  const shirt = pick(GUESTS.shirts, seed * 3 + 3);
  box(mesh, c, [-0.15, 0.15], [-0.38, 0.08], [0.58, 0.72], legs);
  box(mesh, c, [-0.14, 0.14], [-0.44, -0.32], [0, 0.62], legs, false);
  box(mesh, c, [-0.2, 0.2], [-0.04, 0.18], [0.72, 1.32], shirt);
  box(mesh, c, [-0.19, 0.19], [-0.5, -0.06], [0.95, 1.02], shirt);
  box(mesh, c, [-0.13, 0.13], [-0.06, 0.18], [1.36, 1.62], skin);
  box(mesh, c, [-0.14, 0.14], [-0.03, 0.21], [1.56, 1.69], pick(GUESTS.hair, seed * 13 + 4));
}

/** A glass on the table: a pils under its head, a Trappist, a white wine, or a coffee cup. 40 vertices. */
function addGlass(mesh: MeshBuilder, f: Frame, seed: number): void {
  const drink = pick(GUESTS.drinks, seed * 17 + 5);
  const cup = drink === GUESTS.drinks.at(-1);
  const top = cup ? 1.02 : 1.12;
  box(mesh, f, [-0.045, 0.045], [-0.045, 0.045], [0.95, top], drink);
  box(mesh, f, [-0.05, 0.05], [-0.05, 0.05], [top, top + 0.035], cup ? 0x6a3220 : GUESTS.foam);
}

/**
 * What the storefronts take from the engine rather than import (see `FurnitureKit`): where a
 * building stands and its wall top, and `AWNING` (facade-codes.ts).
 */
export interface StorefrontKit {
  awning: number;
  footing: (b: Building) => number;
  wallTop: (b: Building) => number;
}

/**
 * The awnings (into `awnings`, which carries the `facade` attribute for their stripes: on the
 * rest of the furniture it would cost 4 bytes a vertex), signs and terraces of a cell's fronts,
 * on the `ground` as drawn. An awning spans its front, but stops short of the next front along
 * the same wall, and of the wall's ends; a sign hangs at an end of it.
 */
export function addStorefronts(
  mesh: MeshBuilder,
  awnings: MeshBuilder,
  fronts: readonly { building: Building; front: ShopFront }[],
  kit: StorefrontKit,
  ground: (x: number, z: number) => number,
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
    // Over the street in front, where that's higher than the house's foot (on a slope, or on
    // a pavement), so the awning's edge stays over the walker's head.
    mesh.lift = awnings.lift = Math.max(
      kit.footing(building),
      ground(p.x + p.nx * REACH, p.z + p.nz * REACH),
    );
    if (FRONTS[front.kind].awning) addAwning(awnings, p, front.kind, top, room, kit.awning);
    // Beside the awning, at the end with room.
    const end = [room + 0.3, -room - 0.3].find(
      (t) => front.along + t >= END_GAP && front.along + t <= p.length - END_GAP,
    );
    if (SIGNS.has(front.kind) && end !== undefined) addSign(mesh, frame(p, end), front.kind, top);
    if (BOARDS.has(front.kind) && roll(front.building * 13 + Math.round(front.along)) < 0.6) {
      const out = REACH + 0.55;
      const sideways = end === undefined ? 0 : -Math.sign(end) * (room * 0.5);
      addBoard(mesh, {
        ...frame(p, sideways),
        x: p.x + p.ux * sideways + p.nx * out,
        z: p.z + p.uz * sideways + p.nz * out,
      });
    }
    const plants = doorPlants(p, front, room);
    for (let i = 0; i < plants.length; i += 2) {
      const [x, z] = [plants[i]!, plants[i + 1]!];
      mesh.lift = ground(x, z);
      addDoorPlant(mesh, { x, z, fx: p.nx, fz: p.nz, scale: 1 }, front.building + i);
    }
    if (front.terrace) {
      mesh.lift = ground(p.x + p.nx * TERRACE.out, p.z + p.nz * TERRACE.out);
      addTerrace(mesh, p, front.kind, front.building * 31 + Math.round(front.along * 10));
    }
  }
  [mesh.lift, awnings.lift] = [lift, awningLift];
}
