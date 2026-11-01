/**
 * Scene colours (sRGB hex). Warm golden-hour Leuven: brick and plaster walls, slate and
 * terracotta roofs, sandy cobbles. DESIGN.md explains the choices; change them here only.
 */

import type { Kind } from '../data/city.ts';

export const WALLS: Record<Kind, readonly number[]> = {
  house: [0xb5523b, 0xc0674a, 0xa84a3a, 0xe8dcc4, 0xf0e6d0, 0xd9c7a8, 0xc98e6c],
  apartments: [0xd8cfc0, 0xc4b8a6, 0xb9a48a, 0xe2d6c2],
  retail: [0xe9dcc6, 0xd96f4e, 0xf2e8d5, 0xc8a882],
  civic: [0xe6dcc8, 0xd8c9a8, 0xcdbb94],
  church: [0xd2c4a2, 0xc9b994],
  shed: [0x9c8f80, 0x8a7d6e],
  other: [0xd6cbb8, 0xc7b8a0, 0xb8a58c],
};

/** Hero landmarks: their own stones and dark slate, so they stand out from the streets. */
export const LANDMARK = {
  sandstone: 0xe4cf9f,
  limestone: 0xd8cba8,
  brick: 0xb35a40,
  trim: 0xeee3c9,
  slate: 0x4a5161,
  spire: 0x3b4150,
} as const;

/** Café parasols on the squares: each café keeps one colour along its stretch of terrace. */
export const PARASOLS = [0xf6eedc, 0xd2553f, 0xe8b94a, 0xe07b4f, 0x8db36f] as const;

/**
 * Street furniture: dark lamp posts and shelters that read like the ink outlines, warm wood,
 * pale stone, bronze, and bikes in the colours Leuven actually rides.
 */
export const PROPS = {
  iron: 0x3b4150,
  lantern: 0xf3dfa8,
  wood: 0x9a6a42,
  stone: 0xd2c6ab,
  bronze: 0x7a6040,
  glass: 0xa9c4cf,
  roof: 0x4a5161,
  sign: 0xe8b94a,
  wheel: 0x2b2420,
  /** Jan Fabre's jewel beetle on the Totem. */
  beetle: 0x2f8a6e,
} as const;
/** Brewery tanks and silos in pale aluminium; bridge parapets in the warm stone of the quays. */
export const STRUCTURES = { tank: 0xd4d2c8, tankTop: 0xb9b6ab, parapet: 0xc4ad85 } as const;
export const BIKES = [
  0x2f3a4a, 0x2b2420, 0xd2553f, 0xf6eedc, 0x8db36f, 0x5b6170, 0xe8b94a,
] as const;

export const PITCHED_ROOFS = [0x4f5664, 0x5b6170, 0x46505e, 0xa9553e, 0xb8613f, 0x9b4a36];
export const FLAT_ROOFS = [0xb3aa9c, 0xa89f92, 0xbfb6a6];

/**
 * Roof colours sampled from the orthophotos snap to these swatches. `ref` is what that roof
 * looks like in the (hazy, winter) aerial photo; `pitched` and `flat` are how the diorama paints
 * it. Flat roofs stay light, never darker than the streets, so they read as quiet backdrop.
 */
export const ROOF_SWATCHES: readonly { ref: number; pitched: number; flat: number }[] = [
  { ref: 0x48536a, pitched: 0x3c4354, flat: 0x958f86 }, // dark slate, glazed black tiles
  { ref: 0x6c717c, pitched: 0x4a5161, flat: 0x9c958b }, // slate
  { ref: 0x82878c, pitched: 0x585e6c, flat: 0xa39b8f }, // weathered slate, bitumen
  { ref: 0x959a9a, pitched: 0x6a6f79, flat: 0xaba397 }, // grey tiles, zinc
  { ref: 0xadb1ad, pitched: 0x81827f, flat: 0xb6aea1 }, // concrete tiles, gravel
  { ref: 0xd0dace, pitched: 0x9a9a92, flat: 0xc8c1b2 }, // pale membrane, glass
  { ref: 0x8c7d73, pitched: 0x7e3f30, flat: 0xa08a7a }, // dark red tiles
  { ref: 0xada097, pitched: 0x9b4a36, flat: 0xae9a89 }, // old red tiles
  { ref: 0xcebbaa, pitched: 0xb8613f, flat: 0xbaa794 }, // terracotta
  { ref: 0x8c9c78, pitched: 0x667f4c, flat: 0x93a66d }, // moss, sedum
];

function linear(c: number): number {
  const u = c / 255;
  return u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4;
}

/** Oklab with chroma weighted 3×: on a roof, hue tells tile from slate more than lightness. */
function roofSpace(hex: number): [number, number, number] {
  const [r, g, b] = [linear((hex >> 16) & 255), linear((hex >> 8) & 255), linear(hex & 255)];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    3 * (1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s),
    3 * (0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s),
  ];
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
  plaza: 0xd7c6a3,
  water: 0x5f9fc4,
  /** Paved footpaths: pale slabs, lighter than the roads. */
  path: 0xb9b0a0,
  /** Gravel and earth trails through the parks. */
  trail: 0xd8c79f,
} as const;

export const TREE = {
  crown: 0x6a9a4a,
  trunk: 0x6b4a32,
  tints: [0xffffff, 0xe3eed6, 0xd2e0c2, 0xf4f1dc],
} as const;

/**
 * The walker: a Leuven student in a coat of the HUD's accent blue, with a mustard scarf and a
 * brick-red backpack, so they read against grey streets, sandy squares and green parks.
 */
export const WALKER = {
  skin: 0xf0c49c,
  hair: 0x7a4a2c,
  coat: 0x2f62a8,
  scarf: 0xe8b94a,
  trousers: 0x3d4250,
  shoes: 0x2b2420,
  bag: 0xb84c36,
} as const;

/** The route hint: pale dots and a target, ringed in ink like the HUD. */
export const ROUTE = { fill: 0xfaf3e3, ink: 0x2b2420 } as const;

/** Window glass, and the few windows that catch the low sun. */
export const WINDOW = { glass: 0x2f3a4a, lit: 0xf3c873 } as const;

export const OUTLINE = 0x2b2420;
export const SUN = 0xffe2b8;
export const SKY_LIGHT = 0xcfe3ff;
export const BOUNCE_LIGHT = 0x9a8a70;

/** Deterministic pick so a building keeps its colour across reloads and rebakes. */
export function pick<T>(list: readonly T[], seed: number): T {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return list[(h >>> 0) % list.length]!;
}
