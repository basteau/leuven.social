/**
 * The colours a new account starts in: a pick from the same palettes as the guests on the
 * terraces (src/scene/palette.ts, copied rather than imported, so the server needs no scene
 * code), so a newcomer looks like they belong. They can change it later.
 */

import type { Outfit } from '../src/net/protocol.ts';

const SKIN = [0xf0c49c, 0xe2ad84, 0xc68a62, 0x9a6444, 0x6e4630];
const HAIR = [0x2b2420, 0x5a3a24, 0x7a4a2c, 0xc79a5a, 0xb5402f, 0x8a8a86];
const SHIRTS = [
  0xfa8064, 0xf6eedc, 0x4a77a8, 0xd2553f, 0xe8b94a, 0x2f6b4f, 0x3d4250, 0xf0b3c0, 0x8fb6d6,
  0x9a6a42,
];
const SHORTS = [0xe9dcbf, 0x3b4a6b, 0x2b2f3a, 0xc9b48e, 0x5a6270];

const pick = (list: readonly number[], random: () => number) =>
  list[Math.floor(random() * list.length) % list.length]!;

export function randomOutfit(random: () => number = Math.random): Outfit {
  return {
    skin: pick(SKIN, random),
    hair: pick(HAIR, random),
    shirt: pick(SHIRTS, random),
    shorts: pick(SHORTS, random),
  };
}
