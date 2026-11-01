import { expect, test } from 'bun:test';

import { toOklab } from '../data/colour.ts';
import { FLAT_ROOFS, PITCHED_ROOFS, ROOF_SWATCHES, roofColor } from './palette.ts';

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
