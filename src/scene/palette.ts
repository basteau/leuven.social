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

export const PITCHED_ROOFS = [0x4f5664, 0x5b6170, 0x46505e, 0xa9553e, 0xb8613f, 0x9b4a36];
export const FLAT_ROOFS = [0xb3aa9c, 0xa89f92, 0xbfb6a6];

export const GROUND = {
  base: 0xb4be8e,
  earth: 0x6b4f3a,
  green: 0x86b064,
  road: 0x8b8780,
  plaza: 0xd7c6a3,
  water: 0x5f9fc4,
} as const;

export const TREE = {
  crown: 0x6a9a4a,
  trunk: 0x6b4a32,
  tints: [0xffffff, 0xe3eed6, 0xd2e0c2, 0xf4f1dc],
} as const;

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
