/**
 * What makes a shop front read from across the street, up close (from zoom 2, with the street
 * furniture): a canvas awning over it, its trade's sign on a bracket (signs.ts), what stands by
 * its door (a café's bay trees, a bar's barrel, a greengrocer's crates, a florist's buckets), and
 * a café table with two chairs where OSM maps a terrace (placed by `fitTerraces`). A public
 * place gets its sign alone: a banner, flags, a marquee. The facade shader already glazes a
 * shop's ground floor under the kind's canvas (facade-material.ts); these are the few shapes it
 * can't paint. Part of the furniture chunk.
 */

import type { Building, ShopFront } from '../data/city.ts';
import { PLACES, SHOP_KINDS } from '../data/shop-kinds.ts';
import type { ShopKind } from '../data/shop-kinds.ts';
import { DOOR_PLANT, END_GAP, MIN_ROOM, awningRoom, doorPlants } from '../data/awnings.ts';
import { CAFE_TABLE, TERRACE, frontPoint } from '../data/shops.ts';
import type { FrontPoint } from '../data/shops.ts';
import type { MeshBuilder, V3 } from './mesh-builder.ts';
import { FRONTS, GUESTS, PROPS, pick } from './palette.ts';
import { at as frameAt, away, box, panel, prism } from './prop-shapes.ts';
import type { Frame } from './prop-shapes.ts';
import {
  LOW_EDGE,
  addBanner,
  addBarberPole,
  addFlags,
  addHangings,
  addMarquee,
  addMedallion,
  addPortal,
  addRoofFlag,
  addSign,
  groundFloor,
  signHeight,
} from './signs.ts';

/**
 * An awning reaches this far out (m), sloping down this much, with a valance this deep. Its low
 * edge stays over the walker's head (PARASOL_RIM, terraces.ts).
 */
const REACH = 1;
const SLOPE = 0.4;
const VALANCE = 0.2;
const PAPER = 0xf6eedc;
const WOOD = 0x9a6a42;
const WICKER = 0xc9a46a;
const CHALK = 0x2f3b38;
/** Fronts that put a menu board on the pavement. */
const BOARDS = new Set<ShopKind>(['cafe', 'bar', 'restaurant', 'bakery', 'icecream']);

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
    box(mesh, f, [-0.5, 0.5], [-0.12, 0.12], [0, 0.9], PROPS.iron, false);
    for (const v of [-0.34, 0.34]) box(mesh, f, [-0.9, 0.9], [v - 0.1, v + 0.1], [0, 0.5], color);
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
  // A few pale chalk lines of menu, no readable words.
  for (const y of [0.45]) {
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

const BARREL = { wood: 0x8a5a36, hoop: 0x3b4150 } as const;

/**
 * A beer barrel on end by a bar's door, bellied, with two iron hoops, as Belgian cafés stand
 * them outside to lean on. 136 vertices.
 */
export function addBarrel(mesh: MeshBuilder, f: Frame): void {
  const r = DOOR_PLANT.radius * 0.95;
  prism(mesh, f, [0, 0], [r, r], [0, 0.45], BARREL.wood, 1.1, 8, false);
  prism(mesh, f, [0, 0], [r * 1.1, r * 1.1], [0.45, 0.95], BARREL.wood, 1 / 1.1, 8);
  for (const y of [0.18, 0.72]) {
    prism(mesh, f, [0, 0], [r * 1.09, r * 1.09], [y, y + 0.06], BARREL.hoop, 1, 8, false);
  }
}

/** Apples, oranges, pears and lemons, by a crate's seed. */
const FRUIT = [0xc8463a, 0xe8902f, 0x8ab04a, 0xe8c84a] as const;

/**
 * A greengrocer's stand by its door: a wooden trestle with two crates of fruit on it, the one
 * against the wall raised behind the other, each heaped a little over its rim. 136 vertices.
 */
export function addCrates(mesh: MeshBuilder, f: Frame, seed: number): void {
  box(mesh, f, [-0.27, 0.27], [-0.2, 0.2], [0, 0.5], PROPS.wood, false);
  for (const [i, [v0, v1, y]] of [
    [-0.2, 0, 0.85],
    [0, 0.2, 0.68],
  ].entries()) {
    box(mesh, f, [-0.27, 0.27], [v0!, v1!], [0.5, y!], BARREL.wood);
    const fruit = FRUIT[(seed + i) % FRUIT.length]!;
    box(mesh, f, [-0.24, 0.24], [v0! + 0.03, v1! - 0.03], [y! - 0.1, y! + 0.05], fruit);
    prism(mesh, f, [0, (v0! + v1!) / 2], [0.17, 0.05], [y! + 0.05, y! + 0.09], fruit, 0.6);
  }
}

/** Zinc buckets, and the flowers in them. */
const ZINC = 0x9aa3a8;
const FLOWERS = [0xe0567a, 0xf2cf5b, 0xf6eedc, 0xd2453f, 0xb57ad0] as const;
const STEMS = 0x4f8a45;

/**
 * A florist's buckets of flowers by its door: three, the one at the back the tallest, each a
 * bunch of leaves under flowers of its own colour. 234 vertices.
 */
export function addBuckets(mesh: MeshBuilder, f: Frame, seed: number): void {
  for (const [i, [u, v, h]] of [
    [-0.13, 0.08, 0],
    [0.13, 0.08, 0.08],
    [0, -0.1, 0.2],
  ].entries()) {
    prism(mesh, f, [u!, v!], [0.1, 0.1], [0, 0.32 + h!], ZINC, 1.2, 6, false);
    prism(mesh, f, [u!, v!], [0.13, 0.13], [0.32 + h!, 0.5 + h!], STEMS, 1.15, 6, false);
    const bunch = FLOWERS[(seed + i) % FLOWERS.length]!;
    prism(mesh, f, [u!, v!], [0.15, 0.15], [0.5 + h!, 0.68 + h!], bunch, 0.5, 6);
  }
}

/** Places that are not public buildings to walk into: a sign says it, with no door or flag. */
export const QUIET_PLACES: ReadonlySet<ShopKind> = new Set(['clinic', 'worship', 'dorm']);

/** A wall lower than this (m) has no room for a public place's portal under its eaves. */
const PORTAL_WALL = 4.4;
/** Nor this little of a front (m either side of its middle): a corner has no room for one. */
const PORTAL_ROOM = 1.4;
/** Two signs on one building keep at least this far apart (m). */
const SIGN_APART = 2.2;

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
 * A public place's sign, by its door: a university's banner and a school's, library's,
 * hospital's or sports hall's sign beside it (`end`, where a shop's sign would hang), a hotel's
 * flags, a museum's hangings and a cinema's or theatre's marquee over it, where the front has
 * the room.
 */
function addPlace(
  mesh: MeshBuilder,
  p: FrontPoint,
  kind: ShopKind,
  top: number,
  room: number,
  end: number | undefined,
  first: boolean,
): void {
  const middle = frame(p);
  if (first && room >= PORTAL_ROOM && !QUIET_PLACES.has(kind)) {
    if (top >= PORTAL_WALL) addPortal(mesh, middle, kind);
    addRoofFlag(mesh, frame(p, room > 2 ? -room * 0.6 : 0), kind, top);
  }
  if (end !== undefined) addMedallion(mesh, frame(p, end), kind, signHeight(top));
  if (kind === 'hotel') {
    if (room >= 1.4) addFlags(mesh, middle, top);
  } else if (kind === 'museum') {
    if (room >= 1.6) addHangings(mesh, middle, kind, top);
  } else if (kind === 'cinema' || kind === 'theatre') {
    if (room >= 1.6) addMarquee(mesh, middle, kind, top);
  } else if (kind === 'university' && end !== undefined && room >= 1.2) {
    addBanner(mesh, frame(p, -Math.sign(end) * Math.min(room, 2.4)), kind, top);
  }
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
 * rest of the furniture it would cost 4 bytes a vertex), signs, what stands by the doors and the
 * terraces of a cell's fronts, on the `ground` as drawn. An awning spans its front, but stops
 * short of the next front along the same wall, and of the wall's ends; a sign hangs at an end of
 * it.
 */
export function addStorefronts(
  mesh: MeshBuilder,
  awnings: MeshBuilder,
  fronts: readonly { building: Building; front: ShopFront }[],
  kit: StorefrontKit,
  ground: (x: number, z: number) => number,
): void {
  const [lift, awningLift] = [mesh.lift, awnings.lift];
  /** One building, one flag and door, whatever else is inside it; signs keep a little apart. */
  const flagged = new Set<Building>();
  const signs: { building: Building; x: number; z: number }[] = [];
  const signRoom = (building: Building, x: number, z: number) => {
    if (signs.some((o) => o.building === building && Math.hypot(o.x - x, o.z - z) < SIGN_APART)) {
      return false;
    }
    signs.push({ building, x, z });
    return true;
  };
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
    const { kind } = front;
    if (FRONTS[kind].awning) addAwning(awnings, p, kind, top, room, kit.awning);
    // Beside the awning, at the end with room.
    const end = [room + 0.3, -room - 0.3].find(
      (t) => front.along + t >= END_GAP && front.along + t <= p.length - END_GAP,
    );
    const signAt = end === undefined ? undefined : frame(p, end);
    const signed = !!signAt && signRoom(building, signAt.x, signAt.z);
    if (PLACES.has(kind)) {
      const first = !flagged.has(building);
      flagged.add(building);
      addPlace(mesh, p, kind, top, room, signed ? end : undefined, first);
    } else if (signed && kind === 'hairdresser') addBarberPole(mesh, signAt, top);
    else if (signed) addSign(mesh, signAt, kind, signHeight(top));
    if (BOARDS.has(kind) && roll(front.building * 13 + Math.round(front.along)) < 0.6) {
      const out = REACH + 0.55;
      const sideways = end === undefined ? 0 : -Math.sign(end) * (room * 0.5);
      addBoard(mesh, {
        ...frame(p, sideways),
        x: p.x + p.ux * sideways + p.nx * out,
        z: p.z + p.uz * sideways + p.nz * out,
      });
    }
    const spots = doorPlants(p, front, room);
    for (let i = 0; i < spots.length; i += 2) {
      const [x, z] = [spots[i]!, spots[i + 1]!];
      const [f, seed] = [{ x, z, fx: p.nx, fz: p.nz, scale: 1 }, front.building + i];
      mesh.lift = ground(x, z);
      if (kind === 'greengrocer') addCrates(mesh, f, seed);
      else if (kind === 'florist') addBuckets(mesh, f, seed);
      else if (kind === 'bar' && i === 0) addBarrel(mesh, f);
      else addDoorPlant(mesh, f, seed);
    }
    if (front.terrace) {
      mesh.lift = ground(p.x + p.nx * TERRACE.out, p.z + p.nz * TERRACE.out);
      addTerrace(mesh, p, front.kind, front.building * 31 + Math.round(front.along * 10));
    }
  }
  [mesh.lift, awnings.lift] = [lift, awningLift];
}
