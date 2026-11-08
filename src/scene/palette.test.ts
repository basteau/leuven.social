import { expect, test } from 'bun:test';

import { deltaE, toOklab } from '../data/colour.ts';
import {
  FLAT_ROOFS,
  PITCHED_ROOFS,
  ROOF_SWATCHES,
  WALLS,
  roofColor,
  wallColor,
} from './palette.ts';

test('sampled roof colours snap to the swatch they look like from the air', () => {
  // Near the cluster centres of Leuven's roofs in the corrected orthophoto colours.
  expect(roofColor(0x7c7d8a, false, 1)).toBe(ROOF_SWATCHES[1]!.pitched); // slate
  expect(roofColor(0xe0ab8a, false, 1)).toBe(ROOF_SWATCHES[6]!.pitched); // terracotta
  expect(roofColor(0x9a7d80, false, 1)).toBe(ROOF_SWATCHES[4]!.pitched); // old dark red tiles
  expect(roofColor(0x5a5a7e, true, 1)).toBe(ROOF_SWATCHES[0]!.flat);
});

test('flat roofs stay lighter than the streets', () => {
  // Road asphalt is 0x8b8780: a flat roof never reads as a hole in the block.
  for (const s of ROOF_SWATCHES)
    expect(toOklab(s.flat)[0]).toBeGreaterThan(toOklab(0x8b8780)[0] - 0.02);
});

test('unsampled roofs fall back to a stable pick', () => {
  expect(PITCHED_ROOFS).toContain(roofColor(null, false, 3));
  expect(FLAT_ROOFS).toContain(roofColor(null, true, 3));
  expect(roofColor(null, false, 3)).toBe(roofColor(null, false, 3));
});

test('walls stray a little from their swatch, the same way every time', () => {
  const colours = Array.from({ length: 200 }, (_, id) => wallColor('house', id));
  expect(wallColor('house', 7)).toBe(colours[7]!);
  // Neighbours painted from one swatch still differ.
  expect(new Set(colours).size).toBeGreaterThan(150);
  // Every wall stays near one of the kind's swatches.
  for (const colour of colours) {
    expect(Math.min(...WALLS.house.map((w) => deltaE(colour, w)))).toBeLessThan(0.05);
  }
});

const near = (c: number) => WALLS.house.findIndex((w) => deltaE(c, w) < 0.05);

test('a block shares one wall family, with a few strays', () => {
  const tones = Array.from({ length: 200 }, (_, id) => wallColor('house', id, 10, 10));
  const counts = new Map<number, number>();
  for (const c of tones) counts.set(near(c), (counts.get(near(c)) ?? 0) + 1);
  expect(Math.max(...counts.values())).toBeGreaterThan(110);
});
