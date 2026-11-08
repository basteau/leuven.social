/**
 * The signs that say what a shop sells or what a public place is without a word: a symbol on an
 * iron bracket square to the wall, so it reads from down the street (a cup, a pint, a croissant,
 * a book, a shirt, a bike, a pencil), a barber's pole, a university's banner, a hotel's flags, a
 * cinema's marquee. A few boxes and flat shapes each, in the trade's colours, merged into the
 * cell's furniture like the awnings (storefronts.ts). Part of the furniture chunk.
 */

import type { ShopKind } from '../data/shop-kinds.ts';
import type { MeshBuilder, V3 } from './mesh-builder.ts';
import { FRONTS, PROPS } from './palette.ts';
import { at, away, box, fan, prism } from './prop-shapes.ts';
import type { Frame } from './prop-shapes.ts';

/** The ground floor's height (m) of a wall `top` high, as the facade shader draws its storeys. */
export const groundFloor = (top: number): number =>
  Math.min(4, Math.max(2.8, top / Math.max(1, Math.floor(top / 3.2 + 0.5))));

/** What hangs over the pavement keeps its lowest edge this high (m): over the walker's head. */
export const LOW_EDGE = 2.6;

/**
 * A sign's reach out from the wall and half its height (m), as drawn before SIGN_SCALE: life
 * size. Drawn larger, as the street furniture is, so a cup or a pint reads from across the street.
 */
export const BOARD = { out: [0.25, 1.15], half: 0.45 } as const;
export const SIGN_SCALE = 1.4;
/** Where a sign's symbol is centred, out from the wall (m). */
const MID = (BOARD.out[0] + BOARD.out[1]) / 2;

/** The sign's middle (m over the foot): at the first-floor sill, over the walker's head. */
export const signHeight = (top: number): number =>
  Math.max(groundFloor(top) + 0.6, LOW_EDGE + BOARD.half * SIGN_SCALE + 0.1);

// The symbols' own colours, beside each kind's two (FRONTS): kept here, with the shapes, so the
// palette the first frame loads doesn't carry them.
const PAPER = 0xf6eedc;
const GOLD = 0xe8b94a;
const DARK_GOLD = 0xc48a2c;
const LOAF = 0xd99a52;
const FRIES = 0xf2cf5b;
const KETCHUP = 0xd2553f;
const WAFFLE = 0xd9a35a;
const PINK = 0xf08aa0;
const PATTY = 0x6a3a22;
const LETTUCE = 0x6aa84a;
const ORANGE = 0xe8902f;
const COVER = 0xb5453a;
const BARBER = [0xd2453f, PAPER, 0x2f62a8, PAPER] as const;
const FLAGS = [0xd2553f, 0x2f62a8, GOLD] as const;
const GRAPHITE = 0x3a3a40;
const ERASER = 0xf08aa0;
const STEEL = 0xa9adb3;

/** A point in a sign's plane: out from the wall (v) and up (y), metres. */
type P2 = readonly [number, number];

/**
 * A flat convex shape in the sign's plane (v out from the wall, y up), from u0 to u1 along the
 * wall: its two faces, seen from down the street both ways, and its edges. 6 vertices a corner.
 */
export function slab(
  mesh: MeshBuilder,
  f: Frame,
  [u0, u1]: readonly [number, number],
  outline: readonly P2[],
  color: number,
): void {
  const n = outline.length;
  const [cv, cy] = outline.reduce(([sv, sy], [v, y]) => [sv + v / n, sy + y / n], [0, 0]);
  const side = (u: number) => outline.map(([v, y]) => at(f, u, v, y));
  const [a, b] = [side(u0), side(u1)];
  mesh.polygon(a, fan(n), color, away(f, -1, 0));
  mesh.polygon(b, fan(n), color, away(f, 1, 0));
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const [[va, ya], [vb, yb]] = [outline[i]!, outline[j]!];
    // Square to the edge, turned away from the middle whichever way the outline winds.
    const [nv, ny] = [yb - ya, va - vb];
    const s = Math.sign(nv * ((va + vb) / 2 - cv) + ny * ((ya + yb) / 2 - cy)) || 1;
    mesh.quad(a[i]!, a[j]!, b[j]!, b[i]!, color, away(f, 0, nv * s, ny * s));
  }
}

/** A straight bar `width` wide from a to b in the sign's plane, `half` either side of u = 0. */
export function bar(
  mesh: MeshBuilder,
  f: Frame,
  half: number,
  [va, ya]: P2,
  [vb, yb]: P2,
  width: number,
  color: number,
): void {
  const length = Math.hypot(vb - va, yb - ya) || 1;
  const [dv, dy] = [((ya - yb) / length) * (width / 2), ((vb - va) / length) * (width / 2)];
  const outline: P2[] = [
    [va + dv, ya + dy],
    [vb + dv, yb + dy],
    [vb - dv, yb - dy],
    [va - dv, ya - dy],
  ];
  slab(mesh, f, [-half, half], outline, color);
}

/** A regular polygon of `sides` round (v, y) in the sign's plane, `half` either side of u = 0. */
export function disc(
  mesh: MeshBuilder,
  f: Frame,
  half: number,
  [v, y]: P2,
  radius: number,
  sides: number,
  color: number,
): void {
  const outline = Array.from({ length: sides }, (_, i): P2 => {
    const t = ((i + 0.5) / sides) * Math.PI * 2;
    return [v + Math.cos(t) * radius, y + Math.sin(t) * radius];
  });
  slab(mesh, f, [-half, half], outline, color);
}

/** The iron arm a sign hangs from, out from the wall over its top. 20 vertices. */
function bracket(mesh: MeshBuilder, f: Frame, y: number, reach: number = BOARD.out[1]): void {
  box(mesh, f, [-0.03, 0.03], [0, reach], [y, y + 0.06], PROPS.iron);
}

/** A board in its kind's colour under the symbol through it. 20 vertices. */
function board(mesh: MeshBuilder, f: Frame, y: number, color: number): void {
  const [o0, o1] = BOARD.out;
  box(mesh, f, [-0.04, 0.04], [o0, o1], [y - BOARD.half, y + BOARD.half], color);
}

/**
 * A sign on an iron bracket, square to the wall so it reads down the street, at the first-floor
 * sill, `middle` over its foot: the kind's symbol, on a board in its colour where the symbol alone
 * would be lost against a wall. Each one tells its trade from across the street without a word.
 * False for a kind with no sign of its own (a counter, a greengrocer's crates say it instead).
 */
export function addSign(mesh: MeshBuilder, f: Frame, kind: ShopKind, middle: number): boolean {
  const symbol = SYMBOLS[kind];
  if (!symbol) return false;
  // Drawn at life size round a middle that the scale brings back to `middle`.
  const [g, y] = [{ ...f, scale: SIGN_SCALE }, middle / SIGN_SCALE];
  bracket(mesh, g, y + BOARD.half);
  const { canvas, stripe = canvas, board: boardColor = canvas } = FRONTS[kind];
  if (BOARDED.has(kind)) board(mesh, g, y, boardColor);
  symbol(mesh, g, y, canvas, stripe);
  return true;
}

type Symbol = (mesh: MeshBuilder, f: Frame, y: number, canvas: number, stripe: number) => void;

/** Kinds whose symbol stands on a board in their colour. */
const BOARDED = new Set<ShopKind>([
  'cafe',
  'bar',
  'bakery',
  'bank',
  'books',
  'fashion',
  'food',
  'restaurant',
  'shop',
  'library',
  'hospital',
]);

/** A book lying open, its pages over its cover, in the sign's plane. 96 vertices. */
const openBook: Symbol = (mesh, f, y) => {
  for (const s of [-1, 1]) {
    bar(mesh, f, 0.08, [MID + s * 0.3, y + 0.04], [MID, y - 0.08], 0.08, COVER);
    bar(mesh, f, 0.07, [MID + s * 0.28, y + 0.11], [MID, y - 0.01], 0.1, PAPER);
  }
};

/** A cross in the second colour: a pharmacy's green on its own, a hospital's red on white. */
const cross: Symbol = (mesh, f, y, _canvas, stripe) => {
  box(mesh, f, [-0.06, 0.06], [MID - 0.12, MID + 0.12], [y - 0.36, y + 0.36], stripe);
  box(mesh, f, [-0.06, 0.06], [MID - 0.36, MID + 0.36], [y - 0.12, y + 0.12], stripe);
};

const SYMBOLS: Partial<Record<ShopKind, Symbol>> = {
  // A paper cone of fries, three standing out of it.
  frituur: (mesh, f, y) => {
    cone(mesh, f, 0.24, 0.06, y + 0.15, y - BOARD.half, KETCHUP, FRIES);
    for (const [du, dv, h] of [
      [-0.06, -0.08, 0.36],
      [0.04, 0.1, 0.42],
      [0.02, -0.02, 0.3],
    ] as const) {
      prism(mesh, f, [du, MID + dv], [0.035, 0.035], [y + 0.15, y + 0.15 + h], FRIES, 1, 3);
    }
  },
  // A coffee cup on its saucer, its handle out.
  cafe: (mesh, f, y) => {
    box(mesh, f, [-0.1, 0.1], [MID - 0.22, MID + 0.22], [y - 0.2, y - 0.16], PAPER);
    box(mesh, f, [-0.1, 0.1], [MID - 0.14, MID + 0.14], [y - 0.16, y + 0.1], PAPER);
    box(mesh, f, [-0.06, 0.06], [MID + 0.13, MID + 0.24], [y - 0.1, y + 0.04], PAPER);
  },
  // A pint under its head of foam.
  bar: (mesh, f, y) => {
    box(mesh, f, [-0.1, 0.1], [MID - 0.11, MID + 0.11], [y - 0.26, y + 0.1], GOLD);
    box(mesh, f, [-0.11, 0.11], [MID - 0.12, MID + 0.12], [y + 0.1, y + 0.2], PAPER);
  },
  // A croissant: a crescent of five pieces, fattest in the middle.
  bakery: (mesh, f, y) => {
    const widths = [0.09, 0.14, 0.17, 0.14, 0.09];
    const point = (i: number): P2 => {
      const t = ((200 + i * 28) * Math.PI) / 180;
      return [MID + Math.cos(t) * 0.24, y + 0.1 + Math.sin(t) * 0.24];
    };
    for (const [i, w] of widths.entries()) bar(mesh, f, 0.09, point(i), point(i + 1), w, LOAF);
  },
  // An ice cream: a pink scoop on a waffle cone.
  icecream: (mesh, f, y) => {
    cone(mesh, f, 0.14, 0, y + 0.06, y - 0.4, WAFFLE, WAFFLE);
    prism(mesh, f, [0, MID], [0.17, 0.17], [y + 0.02, y + 0.16], PINK, 1, 8, false);
    prism(mesh, f, [0, MID], [0.17, 0.17], [y + 0.16, y + 0.3], PINK, 0.55, 8);
  },
  pharmacy: cross,
  hospital: cross,
  // A gold coin, its rim standing proud.
  bank: (mesh, f, y) => {
    disc(mesh, f, 0.07, [MID, y], 0.26, 8, GOLD);
    disc(mesh, f, 0.09, [MID, y], 0.16, 8, DARK_GOLD);
  },
  books: openBook,
  library: openBook,
  // A shirt: its body, the shoulders and two sleeves.
  fashion: (mesh, f, y) => {
    const [l, r] = [MID - 0.15, MID + 0.15];
    slab(
      mesh,
      f,
      [-0.07, 0.07],
      [
        [l, y - 0.27],
        [r, y - 0.27],
        [r + 0.02, y + 0.17],
        [l - 0.02, y + 0.17],
      ],
      PAPER,
    );
    for (const s of [-1, 1]) {
      bar(mesh, f, 0.07, [MID + s * 0.12, y + 0.14], [MID + s * 0.32, y - 0.02], 0.13, PAPER);
    }
  },
  // A city bike: two wheels and a blue frame, as the bike shops paint theirs.
  bicycle: (mesh, f, y, canvas) => {
    const rear: P2 = [MID - 0.24, y - 0.15];
    const front: P2 = [MID + 0.24, y - 0.15];
    const crank: P2 = [MID - 0.02, y - 0.15];
    const seat: P2 = [MID - 0.08, y + 0.12];
    const head: P2 = [MID + 0.16, y + 0.12];
    for (const hub of [rear, front]) wheel(mesh, f, hub, 0.18);
    for (const [a, b] of [
      [rear, crank],
      [crank, seat],
      [seat, rear],
      [seat, head],
      [head, crank],
      [head, front],
    ] as const) {
      bar(mesh, f, 0.03, a, b, 0.05, canvas);
    }
    box(mesh, f, [-0.05, 0.05], [MID - 0.14, MID - 0.02], [y + 0.12, y + 0.17], PROPS.iron);
  },
  // A shopping basket with fruit in it.
  food: (mesh, f, y) => {
    disc(mesh, f, 0.06, [MID - 0.08, y + 0.06], 0.1, 6, LETTUCE);
    disc(mesh, f, 0.065, [MID + 0.08, y + 0.07], 0.1, 6, ORANGE);
    slab(
      mesh,
      f,
      [-0.08, 0.08],
      [
        [MID - 0.24, y + 0.04],
        [MID + 0.24, y + 0.04],
        [MID + 0.17, y - 0.24],
        [MID - 0.17, y - 0.24],
      ],
      KETCHUP,
    );
  },
  // A knife and fork, crossed.
  restaurant: (mesh, f, y) => {
    bar(mesh, f, 0.07, [MID - 0.22, y - 0.3], [MID + 0.2, y + 0.3], 0.06, PAPER);
    bar(mesh, f, 0.075, [MID + 0.22, y - 0.3], [MID - 0.2, y + 0.3], 0.06, PAPER);
    bar(mesh, f, 0.08, [MID - 0.24, y + 0.2], [MID - 0.14, y + 0.33], 0.14, PAPER);
  },
  // A burger: the bun, the patty, a leaf of lettuce and the bun's dome.
  snack: (mesh, f, y) => {
    const layer = (y0: number, y1: number, r: number, color: number, taper = 1) =>
      prism(mesh, f, [0, MID], [r, r], [y0, y1], color, taper, 6, taper !== 1);
    layer(y - 0.24, y - 0.14, 0.22, WAFFLE);
    layer(y - 0.14, y - 0.05, 0.24, PATTY);
    layer(y - 0.05, y, 0.25, LETTUCE);
    layer(y, y + 0.16, 0.23, WAFFLE, 0.6);
  },
  // A paper shopping bag with its handle.
  shop: (mesh, f, y) => {
    box(mesh, f, [-0.07, 0.07], [MID - 0.16, MID + 0.16], [y - 0.28, y + 0.08], PAPER);
    for (const s of [-1, 1]) {
      bar(mesh, f, 0.03, [MID + s * 0.09, y + 0.08], [MID + s * 0.07, y + 0.2], 0.03, PROPS.iron);
    }
    bar(mesh, f, 0.03, [MID - 0.08, y + 0.19], [MID + 0.08, y + 0.19], 0.03, PROPS.iron);
  },
  // A yellow pencil, hanging point down: its eraser, the band and the sharpened wood.
  school: (mesh, f, y, canvas) => {
    prism(mesh, f, [0, MID], [0.08, 0.08], [y + 0.32, y + 0.42], ERASER, 1, 6);
    prism(mesh, f, [0, MID], [0.08, 0.08], [y + 0.25, y + 0.32], STEEL, 1, 6, false);
    prism(mesh, f, [0, MID], [0.08, 0.08], [y - 0.2, y + 0.25], canvas, 1, 6, false);
    prism(mesh, f, [0, MID], [0.08, 0.08], [y - 0.2, y - 0.36], LOAF, 0.3, 6, false);
    prism(mesh, f, [0, MID], [0.024, 0.024], [y - 0.36, y - 0.42], GRAPHITE, 0, 6);
  },
  // A mortarboard over a tassel: a university, in its pale colour on its blue.
  university: (mesh, f, y, _canvas, stripe) => {
    slab(
      mesh,
      f,
      [-0.12, 0.12],
      [
        [MID - 0.4, y + 0.12],
        [MID, y + 0.28],
        [MID + 0.4, y + 0.12],
        [MID, y - 0.02],
      ],
      stripe,
    );
    bar(mesh, f, 0.11, [MID - 0.19, y + 0.03], [MID - 0.19, y - 0.22], 0.05, stripe);
    bar(mesh, f, 0.11, [MID + 0.19, y + 0.03], [MID + 0.19, y - 0.22], 0.05, stripe);
    bar(mesh, f, 0.11, [MID - 0.19, y - 0.2], [MID + 0.19, y - 0.2], 0.05, stripe);
    bar(mesh, f, 0.13, [MID + 0.34, y + 0.12], [MID + 0.34, y - 0.24], 0.03, GOLD);
    disc(mesh, f, 0.14, [MID + 0.34, y - 0.27], 0.06, 6, GOLD);
  },
  // A temple front: pediment, three columns and a step.
  museum: (mesh, f, y, _canvas, stripe) => {
    slab(
      mesh,
      f,
      [-0.1, 0.1],
      [
        [MID - 0.42, y + 0.14],
        [MID + 0.42, y + 0.14],
        [MID, y + 0.42],
      ],
      PAPER,
    );
    for (const c of [-0.28, 0, 0.28]) {
      bar(mesh, f, 0.09, [MID + c, y + 0.12], [MID + c, y - 0.3], 0.1, PAPER);
    }
    bar(mesh, f, 0.1, [MID - 0.42, y - 0.34], [MID + 0.42, y - 0.34], 0.08, stripe);
  },
  // A bed: head and foot boards, a mattress under a blanket, a pillow.
  hotel: (mesh, f, y, _canvas, stripe) => {
    bar(mesh, f, 0.08, [MID - 0.4, y - 0.3], [MID - 0.4, y + 0.22], 0.08, stripe);
    bar(mesh, f, 0.08, [MID + 0.4, y - 0.3], [MID + 0.4, y - 0.02], 0.08, stripe);
    bar(mesh, f, 0.09, [MID - 0.36, y - 0.14], [MID + 0.36, y - 0.14], 0.2, PAPER);
    bar(mesh, f, 0.1, [MID - 0.06, y - 0.02], [MID + 0.36, y - 0.02], 0.08, stripe);
    disc(mesh, f, 0.1, [MID - 0.22, y - 0.01], 0.13, 6, PAPER);
  },
  // A film reel: a disc in gold, its four holes dark, and a run of film.
  cinema: (mesh, f, y, _canvas, stripe) => {
    disc(mesh, f, 0.09, [MID, y], 0.36, 12, stripe);
    for (const [dv, dy] of [
      [0.16, 0],
      [-0.16, 0],
      [0, 0.16],
      [0, -0.16],
    ] as const) {
      disc(mesh, f, 0.12, [MID + dv, y + dy], 0.08, 6, PATTY);
    }
    disc(mesh, f, 0.12, [MID, y], 0.05, 6, PAPER);
  },
  // A mask: its face, two eyes and a smile.
  theatre: (mesh, f, y, _canvas, stripe) => {
    slab(
      mesh,
      f,
      [-0.1, 0.1],
      [
        [MID - 0.32, y + 0.32],
        [MID + 0.32, y + 0.32],
        [MID + 0.3, y - 0.06],
        [MID + 0.14, y - 0.34],
        [MID - 0.14, y - 0.34],
        [MID - 0.3, y - 0.06],
      ],
      PAPER,
    );
    for (const s of [-1, 1]) disc(mesh, f, 0.13, [MID + s * 0.14, y + 0.12], 0.08, 6, stripe);
    bar(mesh, f, 0.13, [MID - 0.14, y - 0.12], [MID, y - 0.22], 0.05, stripe);
    bar(mesh, f, 0.13, [MID, y - 0.22], [MID + 0.14, y - 0.12], 0.05, stripe);
  },
  // A ball in the sports hall's orange, its seams dark.
  sports: (mesh, f, y, canvas, stripe) => {
    disc(mesh, f, 0.08, [MID, y], 0.3, 8, canvas);
    bar(mesh, f, 0.09, [MID - 0.3, y], [MID + 0.3, y], 0.03, stripe);
    bar(mesh, f, 0.09, [MID, y - 0.3], [MID, y + 0.3], 0.03, stripe);
  },
};

/** A wheel: a ring of six spokeless pieces of dark tyre round its hub. 144 vertices. */
function wheel(mesh: MeshBuilder, f: Frame, [v, y]: P2, r: number): void {
  const point = (i: number): P2 => {
    const t = (i / 6) * Math.PI * 2;
    return [v + Math.cos(t) * r, y + Math.sin(t) * r];
  };
  for (let i = 0; i < 6; i++) bar(mesh, f, 0.035, point(i), point(i + 1), 0.05, PROPS.wheel);
}

/**
 * A cone of six sides hanging point down from `y1` to `y0`, `r1` wide at the top and `r0` at
 * its point, and what fills it showing on top.
 */
function cone(
  mesh: MeshBuilder,
  f: Frame,
  r1: number,
  r0: number,
  y1: number,
  y0: number,
  color: number,
  fill: number,
): void {
  const ring = (r: number, h: number) =>
    Array.from({ length: 6 }, (_, i): V3 => {
      const t = ((i + 0.5) / 6) * Math.PI * 2;
      return at(f, Math.cos(t) * r, MID + Math.sin(t) * r, h);
    });
  const [low, high] = [ring(r0, y0), ring(r1, y1)];
  for (let i = 0; i < 6; i++) {
    const j = (i + 1) % 6;
    const t = ((j / 6) * Math.PI * 2 + (i / 6) * Math.PI * 2) / 2;
    const out = away(f, Math.cos(t), Math.sin(t));
    if (r0 > 0) mesh.quad(low[i]!, low[j]!, high[j]!, high[i]!, color, out);
    else mesh.triangle(low[0]!, high[j]!, high[i]!, color, out);
  }
  mesh.polygon(high, fan(6), fill, [0, 1, 0]);
}

/**
 * A barber's pole by a hairdresser's door, flat to the wall on a short arm: its red, white and
 * blue bands wind round it, each a side further along than the one under it, between two brass
 * caps. Its foot over the walker's head. 220 vertices.
 */
export function addBarberPole(mesh: MeshBuilder, f: Frame, top: number): void {
  const [y0, y1] = [
    LOW_EDGE - 0.2,
    Math.max(LOW_EDGE + 0.6, Math.min(LOW_EDGE + 0.9, groundFloor(top) + 0.4)),
  ];
  const [v, r, sides, bands] = [0.26, 0.12, 8, 5];
  box(mesh, f, [-0.03, 0.03], [0, v], [y1 - 0.25, y1 - 0.19], PROPS.iron);
  const corner = (i: number, y: number): V3 => {
    const t = (i / sides) * Math.PI * 2;
    return at(f, Math.cos(t) * r, v + Math.sin(t) * r, y);
  };
  const step = (y1 - y0) / bands;
  for (let b = 0; b < bands; b++) {
    for (let i = 0; i < sides; i++) {
      const [ya, yb] = [y0 + b * step, y0 + (b + 1) * step];
      const t = ((i + 0.5) / sides) * Math.PI * 2;
      const color = BARBER[(i + b) % BARBER.length]!;
      const out = away(f, Math.cos(t), Math.sin(t));
      mesh.quad(corner(i, ya), corner(i + 1, ya), corner(i + 1, yb), corner(i, yb), color, out);
    }
  }
  box(mesh, f, [-0.14, 0.14], [v - 0.14, v + 0.14], [y1, y1 + 0.1], GOLD);
  box(mesh, f, [-0.14, 0.14], [v - 0.14, v + 0.14], [y0 - 0.1, y0], GOLD);
}

/** Half the size of a public place's medallion (m, before SIGN_SCALE). */
const MEDALLION = 0.62;
/** Drawn larger than a shop's sign: it says what the whole building is. */
const MEDALLION_SCALE = 1.7;
const BRASS = 0xd9a441;

/**
 * A public place's medallion on an iron arm, square to the wall so it reads down the street, at
 * the first-floor sill: a brass ring, an enamel disc in the place's colour, and its symbol in the
 * middle, the same on both faces. A public place says what it is by this one sign; a shop by a
 * smaller one. 200 to 400 vertices.
 */
export function addMedallion(mesh: MeshBuilder, f: Frame, kind: ShopKind, middle: number): void {
  const symbol = SYMBOLS[kind];
  if (!symbol) return;
  // Its rim over the walker's head.
  const high = Math.max(middle, LOW_EDGE + MEDALLION * MEDALLION_SCALE + 0.1);
  const [g, y] = [{ ...f, scale: MEDALLION_SCALE }, high / MEDALLION_SCALE];
  const [c, r] = [BOARD.out[0] + MEDALLION + 0.05, MEDALLION];
  box(mesh, g, [-0.03, 0.03], [0, c + r * 0.7], [y + r + 0.08, y + r + 0.15], PROPS.iron);
  bar(mesh, g, 0.03, [c - r * 0.4, y + r + 0.1], [c - r * 0.4, y + r * 0.7], 0.05, PROPS.iron);
  const { canvas, stripe = canvas } = FRONTS[kind];
  disc(mesh, g, 0.05, [c, y], r, 16, BRASS);
  disc(mesh, g, 0.075, [c, y], r * 0.86, 16, canvas);
  // Each symbol is drawn round the middle of a shop's board, so stand it in the medallion's.
  symbol(mesh, { ...g, ...slide(g, c - MID) }, y, canvas, stripe);
}

/** Where a frame's origin moves to, `v` further out of the wall. */
function slide(f: Frame, v: number): Pick<Frame, 'x' | 'z'> {
  return { x: f.x + f.fx * v * f.scale, z: f.z + f.fz * v * f.scale };
}

/**
 * A flag on a pole from the front's cornice, up over the eaves: a public place shows from up the
 * street and from the map. A two-tone pennant, drawn large. 56 vertices.
 */
export function addRoofFlag(mesh: MeshBuilder, f: Frame, kind: ShopKind, top: number): void {
  const { canvas, stripe = canvas } = FRONTS[kind];
  const [y0, y1] = [top - 0.5, top + 4.2];
  box(mesh, f, [-0.05, 0.05], [0.2, 0.3], [y0, y1], PROPS.iron, false);
  prism(mesh, f, [0, 0.25], [0.09, 0.09], [y1, y1 + 0.14], BRASS, 0.3, 4);
  const pennant = (from: number, to: number, y: number, h: number, color: number) =>
    slab(
      mesh,
      f,
      [-0.015, 0.015],
      [
        [from, y],
        [to, y],
        [to, y - h],
        [from, y - h],
      ],
      color,
    );
  pennant(0.3, 2.3, y1 - 0.05, 0.7, canvas);
  pennant(0.3, 2.3, y1 - 0.75, 0.7, stripe);
}

/** Stone a place's door is framed in, and the door's dark wood. */
const PORTAL = { stone: 0xded3bb, wood: 0x3a2c22, glass: 0xf0dfae } as const;

/**
 * The way in to a public place: two stone jambs, a lintel under a pediment in the place's colour,
 * a double door with a fanlight, and two steps up to it. Against the wall at the middle of the
 * front; what a person walks towards. 130 vertices.
 */
export function addPortal(mesh: MeshBuilder, f: Frame, kind: ShopKind): void {
  const { canvas } = FRONTS[kind];
  const [half, high] = [0.95, 2.75];
  for (const s of [-1, 1]) {
    box(mesh, f, [s * half - 0.18, s * half + 0.18], [0, 0.26], [0, high], PORTAL.stone);
  }
  box(mesh, f, [-half - 0.28, half + 0.28], [0, 0.32], [high, high + 0.34], PORTAL.stone);
  slab(
    mesh,
    { ...f, fx: -f.fz, fz: f.fx },
    [-0.34, 0],
    [
      [-half - 0.42, high + 0.34],
      [half + 0.42, high + 0.34],
      [0, high + 1.05],
    ],
    canvas,
  );
  box(mesh, f, [-half + 0.18, half - 0.18], [0.02, 0.1], [0, high - 0.5], PORTAL.wood);
  box(mesh, f, [-0.025, 0.025], [0.08, 0.12], [0.02, high - 0.5], PROPS.iron);
  box(mesh, f, [-half + 0.18, half - 0.18], [0.02, 0.1], [high - 0.45, high - 0.02], PORTAL.glass);
  box(mesh, f, [-half - 0.35, half + 0.35], [0, 0.6], [0, 0.1], PORTAL.stone);
  box(mesh, f, [-half - 0.2, half + 0.2], [0, 0.34], [0.1, 0.2], PORTAL.stone);
}

/**
 * A banner hanging from a pole out of the wall, high on the front: a university's in KU
 * Leuven's blue over a pale band, as the faculties hang theirs. Its foot over the walker's head;
 * none on a wall too low to hang one. 60 vertices.
 */
export function addBanner(mesh: MeshBuilder, f: Frame, kind: ShopKind, top: number): boolean {
  const { canvas, stripe = canvas } = FRONTS[kind];
  const y1 = Math.min(top - 0.4, groundFloor(top) + 3.6);
  const y0 = Math.max(LOW_EDGE, y1 - 2.4);
  if (y1 - y0 < 1) return false;
  bracket(mesh, f, y1, 1.05);
  const band = y0 + Math.min(0.35, (y1 - y0) / 4);
  box(mesh, f, [-0.025, 0.025], [0.3, 1], [band, y1], canvas);
  box(mesh, f, [-0.03, 0.03], [0.32, 0.98], [y0, band], stripe);
  return true;
}

/**
 * Three flags on poles out of the wall over a hotel's door, a metre and a bit apart, each
 * hanging in its own colour. 120 vertices.
 */
export function addFlags(mesh: MeshBuilder, f: Frame, top: number): void {
  const y = Math.max(signHeight(top) + BOARD.half, LOW_EDGE + 1);
  for (const [i, color] of FLAGS.entries()) {
    const g = { ...f, x: f.x - f.fz * (i - 1) * 1.2, z: f.z + f.fx * (i - 1) * 1.2 };
    bracket(mesh, g, y, 1.2);
    box(mesh, g, [-0.02, 0.02], [0.4, 1.15], [y - 0.95, y], color);
  }
}

/**
 * Two long banners flat on a museum's front either side of its door, from over the ground floor
 * nearly to the eaves, in its red over a gold foot. None on a front lower than two storeys.
 * 80 vertices.
 */
export function addHangings(mesh: MeshBuilder, f: Frame, kind: ShopKind, top: number): boolean {
  const { canvas, stripe = canvas } = FRONTS[kind];
  const [y0, y1] = [groundFloor(top) + 0.3, top - 0.5];
  if (y1 - y0 < 2.5) return false;
  for (const s of [-1, 1]) {
    const u: [number, number] = [s * 1.2 - 0.4, s * 1.2 + 0.4];
    box(mesh, f, u, [0.02, 0.07], [y0 + 0.4, y1], canvas);
    box(mesh, f, u, [0.02, 0.08], [y0, y0 + 0.4], stripe);
  }
  return true;
}

/**
 * A marquee over a cinema's or a theatre's door: a deep canopy in its colour with a row of bulbs
 * along its edge and down its sides, as picture houses have. 200 vertices.
 */
export function addMarquee(mesh: MeshBuilder, f: Frame, kind: ShopKind, top: number): void {
  const { canvas, stripe = canvas } = FRONTS[kind];
  const y0 = Math.max(LOW_EDGE + 0.1, Math.min(groundFloor(top) - 0.1, LOW_EDGE + 0.5));
  const [half, reach] = [1.6, 1.3];
  box(mesh, f, [-half, half], [0, reach], [y0, y0 + 0.35], canvas);
  for (let i = 0; i < 7; i++) {
    const u = -half + 0.2 + (i * (2 * half - 0.4)) / 6;
    box(
      mesh,
      f,
      [u - 0.05, u + 0.05],
      [reach - 0.02, reach + 0.04],
      [y0 + 0.13, y0 + 0.22],
      stripe,
    );
  }
  for (const s of [-1, 1]) {
    for (const v of [0.45, 0.9]) {
      const u = s * half;
      box(mesh, f, [u - 0.05, u + 0.05], [v - 0.05, v + 0.05], [y0 + 0.13, y0 + 0.22], stripe);
    }
  }
}
