/**
 * Scene colours (sRGB hex). Warm golden-hour Leuven: brick and plaster walls, slate and
 * terracotta roofs, sandy cobbles. DESIGN.md explains the choices; change them here only.
 */

import type { Kind } from '../data/city.ts';
import { fromOklab, toOklab } from '../data/colour.ts';

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
  road: 0x8b8780,
  plaza: 0xd9b98a,
  water: 0x5f9fc4,
  /** Paved footpaths: pale slabs, lighter than the roads. */
  path: 0xb9b0a0,
  /** Gravel and earth trails through the parks. */
  trail: 0xd6bf90,
} as const;

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

/** Shop awnings over the ground-floor windows: one canvas per bay. */
export const AWNINGS = [0xd2553f, 0x2f6b4f, 0x4a77a8, 0xe8b94a, 0x7a3e31, 0xf6eedc] as const;

/** Window glass, and the few windows that catch the low sun. */
export const WINDOW = { glass: 0x2f3a4a, lit: 0xf3c873 } as const;

export const OUTLINE = 0x2b2420;
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
