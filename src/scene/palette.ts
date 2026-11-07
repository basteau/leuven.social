/**
 * Scene colours (sRGB hex). Warm golden-hour Leuven: brick and plaster walls, slate and
 * terracotta roofs, sandy cobbles. DESIGN.md explains the choices; change them here only.
 */

import type { CarriagewayKind, Kind, Material, Surface } from '../data/city.ts';
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
  /** A lantern lit at night, and the pool of light it throws on the street. */
  lamplight: 0xfff2c4,
  pool: 0xe0bc74,
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
 * People on the café terraces: shirts in the colours a sunny Leuven evening wears, jeans and
 * chinos, a range of skin and hair, and what's on the tables (a pils with its head, a dark
 * Trappist, a white wine, a coffee cup).
 */
export const GUESTS = {
  shirts: [
    0xf6eedc, 0x4a77a8, 0xd2553f, 0xe8b94a, 0x2f6b4f, 0x3d4250, 0xf0b3c0, 0x8fb6d6, 0x9a6a42,
  ],
  legs: [0x3b4a6b, 0x2b2f3a, 0xc9b48e, 0x5a6270, 0x3b4a6b],
  skin: [0xf0c49c, 0xe2ad84, 0xc68a62, 0x9a6444, 0x6e4630],
  hair: [0x2b2420, 0x5a3a24, 0x7a4a2c, 0xc79a5a, 0xb5402f, 0x8a8a86],
  drinks: [0xe8a838, 0xe8a838, 0x6a3220, 0xf0e6b0, 0xf6eedc],
  foam: 0xfbf6ea,
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
/** A bike's lamp on the fork and its red reflector, which glow at night. */
export const BIKE_LAMPS = { lamp: 0xfff4d0, reflector: 0xd23a2a } as const;
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
  /** The kerbstones along the carriageways: Belgian bluestone, a cool grey between slabs and asphalt. */
  kerb: 0x9a9ea6,
  plaza: 0xd8bb90,
  water: 0x5f9fc4,
  /** Bridge decks: the pavement's slabs a shade warmer, so a street runs on over the bridge. */
  bridge: 0xb8b0a1,
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
 * Every surface a road or path is made of (`SURFACES` in src/data/city.ts): asphalt and
 * concrete greys, warm grey-brown setts and pale stone paving (both greyer than the sand of the
 * squares), pale gravel like the park trails, brown earth for a dirt road or a field track,
 * green-grey grass pavers.
 */
export const SURFACE_COLOURS: Record<Surface, number> = {
  asphalt: 0x8b8780,
  concrete: 0xa9a69e,
  sett: 0xa69886,
  paving: 0xb3aa9a,
  gravel: 0xd0b98c,
  earth: 0x9f8460,
  grass: 0x8fa870,
};

/**
 * A carriageway's colour: its surface's, except that asphalt darkens on the ring and main roads
 * and cycle tracks are Flemish red asphalt.
 */
export function carriagewayColor(kind: CarriagewayKind, surface: Surface): number {
  if (surface !== 'asphalt') return SURFACE_COLOURS[surface];
  return kind === 'main' ? 0x77746f : kind === 'cycleway' ? 0xa8604c : SURFACE_COLOURS.asphalt;
}

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
  /** A cherry or a magnolia in flower, now and then among the smaller trees. */
  blossom: 0xeba3bb,
} as const;

/**
 * Shop fronts by what they sell (src/data/shop-kinds.ts): the canvas of the awning, or of the
 * fascia board where there's none (a pharmacy's green, a bank's blue), and a second colour it is
 * striped with where that's the trade's (a frituur's red and yellow, a bakery's cream and brown).
 * Cafés, bars and restaurants have warm panes, open into the evening; shops goods in the window.
 * A public place has no front of glass: its two colours are its sign's (storefronts.ts), a
 * university's KU Leuven blue, a hotel's wine and gold.
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
  hairdresser: { canvas: 0x2b3f63, awning: false },
  greengrocer: { canvas: 0x3f8a3a, stripe: PAPER, awning: true, goods: true },
  florist: { canvas: 0xc8577a, stripe: 0x4f8a45, awning: true, goods: true },
  university: { canvas: 0x1d6fa8, stripe: PAPER, awning: false },
  school: { canvas: 0xf2c14e, stripe: 0xd2553f, awning: false },
  hotel: { canvas: 0x6b2d3c, stripe: 0xe8b94a, awning: false },
  museum: { canvas: 0xa8322d, stripe: 0xe8b94a, awning: false },
  library: { canvas: 0x2f6b4f, stripe: PAPER, awning: false },
  cinema: { canvas: 0x8c2f3a, stripe: 0xf2cf5b, awning: false },
  theatre: { canvas: 0x5a2d6b, stripe: 0xf2cf5b, awning: false },
  hospital: { canvas: PAPER, stripe: 0xd2453f, awning: false },
  sports: { canvas: 0xe07b2f, stripe: 0x2c2b30, awning: false },
};

/**
 * The walker: a Leuven student dressed for a sunny day, in a coral short-sleeved shirt and
 * cream shorts and sneakers, so they read against grey streets, sandy squares and green parks.
 * Hidden behind a building, their silhouette is the shirt's coral (`XRAY_LOOK`).
 */
export const WALKER = {
  skin: 0xf0c49c,
  hair: 0x7a4a2c,
  shirt: 0xfa8064,
  shorts: 0xe9dcbf,
  sneakers: 0x2c2b30,
} as const;

/** The route hint: pale dots and a target, ringed in ink like the HUD. */
export const ROUTE = 0x4a3c33;

/** Chimney stacks on pale houses: a dark red brick (darker houses darken their own). */
export const CHIMNEY = 0x8a4a3c;
/** Window glass, and the few windows that catch the low sun. */
export const WINDOW = { glass: 0x2f3a4a, lit: 0xf3c873 } as const;

export const OUTLINE = 0x2b2420;
/** The app's `--paper` (app.css), for the few specks of white in the scene: buttons, glints. */
export const PAPER_WHITE = 0xfbf6ec;
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
 * The sky behind the map, and the haze that fades the far end of a street into it: the HUD's
 * `--sky-top` and `--sky-horizon` (app.css), so the map's sky and the street's are one.
 */
export const SKY = { top: 0xa2cee9, horizon: 0xfce4c4 } as const;
