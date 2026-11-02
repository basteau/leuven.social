/**
 * Scene colours (sRGB hex). Warm golden-hour Leuven: brick and plaster walls, slate and
 * terracotta roofs, sandy cobbles. DESIGN.md explains the choices; change them here only.
 */

import type { CarriagewayKind, Kind, Material } from '../data/city.ts';
import { fromOklab, toOklab } from '../data/colour.ts';
import type { PitchSurface } from '../data/pitches.ts';
import type { ShopKind } from '../data/shop-kinds.ts';

export const WALLS: Record<Kind, readonly number[]> = {
  // Red and dark brown brick, yellow brick, whitewash, cream and sand plaster.
  house: [0xb5523b, 0xc0674a, 0xa84a3a, 0x94573f, 0xd6bd85, 0xe5d9c0, 0xebe2cc, 0xd9c7a8, 0xc98e6c],
  apartments: [0xd8cfc0, 0xc4b8a6, 0xb9a48a, 0xe2d6c2],
  retail: [0xe9dcc6, 0xd96f4e, 0xf2e8d5, 0xc8a882],
  civic: [0xe6dcc8, 0xd8c9a8, 0xcdbb94],
  church: [0xd2c4a2, 0xc9b994],
  shed: [0x9c8f80, 0x8a7d6e],
  other: [0xd6cbb8, 0xc7b8a0, 0xb8a58c],
};

/**
 * Hero landmarks: their own stones and dark slate. Each is the lightest, most colourful thing
 * in its street, so the eye finds it first.
 */
export const LANDMARK = {
  sandstone: 0xf4dca2,
  limestone: 0xf0e2bb,
  brick: 0xc85c3a,
  trim: 0xfaf0d8,
  slate: 0x4a5161,
  spire: 0x3b4150,
} as const;

/**
 * Café parasols on the squares: each café keeps one colour along its stretch of terrace. Beer
 * brand reds, cream, mustard, orange and a blue; no green, which read as a hedge from above.
 */
export const PARASOLS = [0xf6eedc, 0xd2553f, 0xe8b94a, 0xe07b4f, 0x4a77a8] as const;

/**
 * Street furniture: dark lamp posts and shelters that read like the ink outlines, warm wood,
 * and bikes in the colours Leuven actually rides. Monuments take `MATERIAL`.
 */
export const PROPS = {
  iron: 0x3b4150,
  lantern: 0xf3dfa8,
  wood: 0x9a6a42,
  glass: 0xa9c4cf,
  roof: 0x4a5161,
  sign: 0xe8b94a,
  wheel: 0x2b2420,
  /** A bike wheel's rim and spokes, read as one pale disc inside the tyre. */
  spokes: 0xb7b3aa,
  /** The red crate on the front of one bike in ten, and its dark inside. */
  crate: 0xb5402f,
  crateInside: 0x5a2a20,
  /** Jan Fabre's jewel beetle on the Totem. */
  beetle: 0x2f8a6e,
} as const;
/**
 * What monuments are made of (OSM `material`): dark warm bronze, pale stone and marble, Belgian
 * bluestone (pumps, and what a pale figure stands on), cool steel, rusty weathering steel,
 * concrete, wood and brick; a fountain's jet is pale water.
 */
export const MATERIAL: Record<Material, number> = {
  bronze: 0x7a6040,
  stone: 0xd2c6ab,
  marble: 0xeee8dc,
  bluestone: 0x8a8a86,
  steel: 0x9aa4ad,
  rust: 0x9a5532,
  concrete: 0xb5afa4,
  wood: 0x9a6a42,
  brick: 0xa8553f,
  water: 0xbfe2ec,
};
/** Brewery tanks and silos in pale aluminium; bridge parapets in the warm stone of the quays. */
export const STRUCTURES = {
  tank: 0xd4d2c8,
  tankTop: 0xb9b6ab,
  parapet: 0xc4ad85,
  /** The parapet's capstone, a paler, newer-looking stone. */
  coping: 0xddd0b4,
} as const;
export const BIKES = [
  0x2f3a4a, 0x2b2420, 0xd2553f, 0xf6eedc, 0x8db36f, 0x5b6170, 0xe8b94a,
] as const;

export const PITCHED_ROOFS = [0x4f5666, 0x3c4354, 0x6c707a, 0x7a3e31, 0x9c4a35, 0xb85e3c];
export const FLAT_ROOFS = [0x8e8f92, 0x9a9996, 0xa7a49d];

/**
 * Roof colours sampled from the orthophotos snap to these swatches. `ref` is what that roofing
 * looks like in the white-balanced, stretched aerial photo (src/data/roof-colours.ts): the
 * centres of Leuven's own roof colour clusters. `pitched` and `flat` are how the diorama paints
 * it. Flat roofs are cool greys a step darker than the plaster walls, so a block doesn't read as
 * one solid slab, but never darker than the streets.
 */
export const ROOF_SWATCHES: readonly { ref: number; pitched: number; flat: number }[] = [
  { ref: 0x5b5b7f, pitched: 0x3c4354, flat: 0x85878e }, // dark slate, glazed black tiles
  { ref: 0x7e7e8b, pitched: 0x4f5666, flat: 0x8e8f92 }, // slate
  { ref: 0x9f9e9a, pitched: 0x6c707a, flat: 0x9a9996 }, // zinc, grey tiles, bitumen
  { ref: 0xcac8b4, pitched: 0x8e8b84, flat: 0xaeaaa0 }, // concrete tiles, pale membrane, glass
  { ref: 0x9c7e81, pitched: 0x7a3e31, flat: 0x958680 }, // old dark red tiles
  { ref: 0xbf9c8b, pitched: 0x9c4a35, flat: 0x9c8b80 }, // red tiles
  { ref: 0xe5af8c, pitched: 0xb85e3c, flat: 0xa99482 }, // terracotta
  { ref: 0x7e8c6c, pitched: 0x667f4c, flat: 0x8d9e6a }, // moss, sedum
];

/** Oklab with chroma weighted 3×: on a roof, hue tells tile from slate more than lightness. */
function roofSpace(hex: number): [number, number, number] {
  const [l, a, b] = toOklab(hex);
  return [l, 3 * a, 3 * b];
}

const SWATCH_SPACE = ROOF_SWATCHES.map((s) => roofSpace(s.ref));

/**
 * A roof's diorama colour: the swatch nearest its sampled orthophoto colour, or a deterministic
 * pick from the generic roofs where nothing was sampled.
 */
export function roofColor(sampled: number | null, flat: boolean, seed: number): number {
  if (sampled === null) return flat ? pick(FLAT_ROOFS, seed) : pick(PITCHED_ROOFS, seed * 7);
  const [l, a, b] = roofSpace(sampled);
  let best = 0;
  let bestDistance = Infinity;
  for (const [i, [sl, sa, sb]] of SWATCH_SPACE.entries()) {
    const d = (l - sl) ** 2 + (a - sa) ** 2 + (b - sb) ** 2;
    if (d < bestDistance) [best, bestDistance] = [i, d];
  }
  const swatch = ROOF_SWATCHES[best]!;
  return flat ? swatch.flat : swatch.pitched;
}

export const GROUND = {
  base: 0xb4be8e,
  earth: 0x6b4f3a,
  green: 0x86b064,
  /** The floor of woods and scrub: a deeper, cooler green under the trees. */
  woods: 0x6a9450,
  /** Car parks: asphalt like the streets, a shade lighter. */
  parking: 0x97938b,
  /** The road surface where no carriageway lies on it: pale slabs, like the footpaths. */
  pavement: 0xb3afa6,
  plaza: 0xd8bb90,
  water: 0x5f9fc4,
  /** Bridge decks: the pavement's slabs a shade warmer, so a street runs on over the bridge. */
  bridge: 0xb8b0a1,
  /** Paved footpaths: pale slabs, lighter than the roads. */
  path: 0xb9b0a0,
  /** Gravel and earth trails through the parks. */
  trail: 0xd6bf90,
  /** Railway land: the gravel between and beside the tracks, paler than their ballast. */
  railway: 0xaca291,
} as const;

/**
 * Sports pitches by what they're made of (src/data/pitches.ts): mown grass the brightest green on
 * the map, artificial turf brighter and bluer still, tennis clay a red-orange, running tracks a
 * deeper brick red, hard courts a grey a shade cooler than the car parks, beach volleyball sand
 * and boules gravel the pale yellows of the trails.
 */
export const PITCH: Record<PitchSurface, number> = {
  grass: 0x8fbd5a,
  turf: 0x5fb552,
  clay: 0xc9693f,
  tartan: 0xb0503d,
  hard: 0x9a9c98,
  sand: 0xe6d29c,
  gravel: 0xcfbb92,
};

/**
 * Railways: running lines on grey ballast and concrete sleepers, yards on rusty ballast and
 * old timber, platforms in pale concrete. Rails and masts are ink lines.
 */
export const RAIL = {
  main: { ballast: 0x9a8f80, sleepers: 0xc9c0ae },
  yard: { ballast: 0x8d7b68, sleepers: 0x7a6250 },
  parapet: 0xb7ab95,
  platform: 0xd9d0bd,
  platformSide: 0xa79c88,
  /** Leuven's platform roof is white steel and glass. */
  canopy: 0xeeece4,
  canopyEnd: 0xd3cfc3,
} as const;

/**
 * Carriageways, by what they're made of (src/data/roads.ts). Asphalt darkens on the ring and main
 * roads; setts are warm grey-brown and paving a pale stone, both greyer than the sand of the
 * squares; cycle tracks are Flemish red asphalt.
 */
export const CARRIAGEWAYS: Record<CarriagewayKind, number> = {
  cycleway: 0xa8604c,
  street: 0x8b8780,
  main: 0x77746f,
  sett: 0xa69886,
  paving: 0xb3aa9a,
};

/** Road paint: white lines and bars, the grey they average to from afar, and cycle-lane red. */
export const PAINT = { line: 0xf1ede2, patch: 0xb0aca4, bike: 0xa8604c } as const;

/**
 * Trees: one crown green that each tree strays from (lighter or darker, towards yellow or blue
 * green), so a park reads as many trees rather than one pattern. Old, tall trees are darker.
 */
export const TREE = {
  crown: 0x6a9a4a,
  trunk: 0x6b4a32,
  /** Oklab spread: lightness, and a turn of the hue (radians) between yellow and blue green. */
  jitter: { l: 0.035, hue: 0.16 },
  /** Lightness lost by a 25 m tree against a 7 m one. */
  age: 0.05,
} as const;

/**
 * Shop fronts by what they sell (src/data/shop-kinds.ts): the canvas of the awning, or of the
 * fascia board where there's none (a pharmacy's green, a bank's blue), and a second colour it is
 * striped with where that's the trade's (a frituur's red and yellow, a bakery's cream and brown).
 * Cafés, bars and restaurants have warm panes, open into the evening; shops goods in the window.
 */
export interface FrontStyle {
  canvas: number;
  stripe?: number;
  /** A canvas awning over the front (else only the board). */
  awning: boolean;
  lit?: boolean;
  goods?: boolean;
}
const PAPER = 0xf6eedc;
export const FRONTS: Record<ShopKind, FrontStyle> = {
  frituur: { canvas: 0xe8b94a, stripe: 0xd2553f, awning: true, lit: true },
  cafe: { canvas: 0x2f6b4f, awning: true, lit: true },
  bar: { canvas: 0x7a3e31, awning: true, lit: true },
  restaurant: { canvas: 0x8c2f3a, stripe: PAPER, awning: true, lit: true },
  snack: { canvas: 0xe07b4f, awning: true, lit: true },
  bakery: { canvas: PAPER, stripe: 0xb07a3e, awning: true, goods: true },
  icecream: { canvas: 0xf0b3c0, stripe: PAPER, awning: true, goods: true },
  food: { canvas: 0x2f6b4f, stripe: PAPER, awning: true, goods: true },
  pharmacy: { canvas: 0x3e9a5a, awning: false, goods: true },
  bank: { canvas: 0x4a77a8, awning: false },
  books: { canvas: 0x2c4a6e, awning: true, goods: true },
  fashion: { canvas: 0x3d4250, awning: true, goods: true },
  bicycle: { canvas: 0x4a77a8, awning: true, goods: true },
  service: { canvas: 0x6c707a, awning: false },
  shop: { canvas: 0xd2553f, awning: true, goods: true },
};

/**
 * The walker: a Leuven student dressed for a sunny day, in a coral short-sleeved shirt and
 * cream shorts and sneakers, so they read against grey streets, sandy squares and green parks.
 * Hidden behind a building, their silhouette is the HUD's accent blue (`xray`).
 */
export const WALKER = {
  skin: 0xf0c49c,
  hair: 0x7a4a2c,
  shirt: 0xfa8064,
  shorts: 0xe9dcbf,
  sneakers: 0x2c2b30,
  xray: 0x2f62a8,
} as const;

/** The route hint: pale dots and a target, ringed in ink like the HUD. */
export const ROUTE = 0x4a3c33;

/** Window glass, and the few windows that catch the low sun. */
export const WINDOW = { glass: 0x2f3a4a, lit: 0xf3c873 } as const;

export const OUTLINE = 0x2b2420;
/**
 * The enamel plates on the facades (house numbers, street names): the HUD street plate's
 * `--sign` blue and `--paper` rim and letters (app.css), edged in the outlines' ink. Paper on
 * enamel is 7.6:1.
 */
export const PLATE = { enamel: 0x14518c, paper: 0xfbf6ec, ink: OUTLINE } as const;
export const SUN = 0xffe2b8;
export const SKY_LIGHT = 0xcfe3ff;
export const BOUNCE_LIGHT = 0x9a8a70;

/** How far a building's wall strays from its swatch: lightness, and each hue axis (Oklab). */
const WALL_JITTER = { l: 0.035, ab: 0.007 } as const;

/**
 * A building's wall colour: a swatch for its kind, nudged a little lighter or darker, warmer
 * or cooler by its id, so a row of houses painted from the same swatch still reads as separate
 * houses. Deterministic, like `pick`.
 */
export function wallColor(kind: Kind, id: number): number {
  const [l, a, b] = toOklab(pick(WALLS[kind], id));
  const unit = (salt: number) => (hash(id * 31 + salt) / 0xffffffff) * 2 - 1;
  return fromOklab([
    l + unit(1) * WALL_JITTER.l,
    a + unit(2) * WALL_JITTER.ab,
    b + unit(3) * WALL_JITTER.ab,
  ]);
}

function hash(seed: number): number {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Deterministic pick so a building keeps its colour across reloads and rebakes. */
export function pick<T>(list: readonly T[], seed: number): T {
  return list[hash(seed) % list.length]!;
}

/**
 * The sky behind the walking camera, and the haze that fades the far city into it: the HUD's
 * `--sky-top` and `--sky-horizon` (app.css), so the map's sky and the street's are one.
 */
export const SKY = { top: 0xa2cee9, horizon: 0xfce4c4 } as const;
