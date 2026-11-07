import type { Outfit } from '../scene/viewer.ts';

/**
 * What a player can wear: a few colours for each part, each with a name a screen reader can say.
 * The first of each is the avatar's own (WALKER in the palette), so a new player looks like the
 * figure the map has always had until they choose.
 */

export type Part = keyof Outfit;

export interface Swatch {
  colour: number;
  name: string;
}

export const PARTS: readonly { part: Part; label: string; swatches: readonly Swatch[] }[] = [
  {
    part: 'shirt',
    label: 'Shirt',
    swatches: [
      { colour: 0xfa8064, name: 'Coral' },
      { colour: 0xd2553f, name: 'Brick red' },
      { colour: 0xe8b94a, name: 'Mustard' },
      { colour: 0x8db36f, name: 'Leaf green' },
      { colour: 0x2f6b4f, name: 'Bottle green' },
      { colour: 0x8fb6d6, name: 'Sky blue' },
      { colour: 0x4a77a8, name: 'Leuven blue' },
      { colour: 0x8a63b8, name: 'Violet' },
      { colour: 0xf0b3c0, name: 'Pink' },
      { colour: 0xf6eedc, name: 'Cream' },
      { colour: 0x3d4250, name: 'Charcoal' },
    ],
  },
  {
    part: 'shorts',
    label: 'Shorts',
    swatches: [
      { colour: 0xe9dcbf, name: 'Cream' },
      { colour: 0xc9b48e, name: 'Khaki' },
      { colour: 0x3b4a6b, name: 'Denim' },
      { colour: 0x5a6270, name: 'Slate' },
      { colour: 0x2b2f3a, name: 'Black' },
      { colour: 0xb5402f, name: 'Red' },
      { colour: 0x2f6b4f, name: 'Green' },
    ],
  },
  {
    part: 'skin',
    label: 'Skin',
    swatches: [
      { colour: 0xf0c49c, name: 'Light' },
      { colour: 0xf6d6bc, name: 'Fair' },
      { colour: 0xe2ad84, name: 'Medium light' },
      { colour: 0xc68a62, name: 'Medium' },
      { colour: 0x9a6444, name: 'Medium dark' },
      { colour: 0x6e4630, name: 'Dark' },
    ],
  },
  {
    part: 'hair',
    label: 'Hair',
    swatches: [
      { colour: 0x7a4a2c, name: 'Chestnut' },
      { colour: 0x2b2420, name: 'Black' },
      { colour: 0x5a3a24, name: 'Dark brown' },
      { colour: 0xc79a5a, name: 'Dark blond' },
      { colour: 0xe8cf8a, name: 'Blond' },
      { colour: 0xb5402f, name: 'Red' },
      { colour: 0x9a9a96, name: 'Grey' },
      { colour: 0xe27aa8, name: 'Bubblegum' },
      { colour: 0x4a8fd0, name: 'Electric blue' },
    ],
  },
];

/** The look every player starts with until they choose: the avatar's own. */
export const FIRST_OUTFIT: Outfit = Object.fromEntries(
  PARTS.map(({ part, swatches }) => [part, swatches[0]!.colour]),
) as unknown as Outfit;

/** A random look from the swatches, never the same as `not` (when given). */
export function surprise(random: () => number = Math.random, not?: Outfit): Outfit {
  for (;;) {
    const outfit = Object.fromEntries(
      PARTS.map(({ part, swatches }) => [
        part,
        swatches[Math.floor(random() * swatches.length) % swatches.length]!.colour,
      ]),
    ) as unknown as Outfit;
    if (!not || PARTS.some(({ part }) => outfit[part] !== not[part])) return outfit;
  }
}

/** A colour as CSS. */
export const css = (colour: number) => `#${colour.toString(16).padStart(6, '0')}`;
