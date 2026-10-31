import { expect, test } from 'bun:test';

import { FLAT_ROOFS, PITCHED_ROOFS, ROOF_SWATCHES, roofColor } from './palette.ts';

test('sampled roof colours snap to the swatch they look like from the air', () => {
  // Cluster centres of Leuven's roofs in the white-balanced winter orthophoto.
  expect(roofColor(0x6c757c, false, 1)).toBe(ROOF_SWATCHES[1]!.pitched); // slate
  expect(roofColor(0xcebbaa, false, 1)).toBe(ROOF_SWATCHES[8]!.pitched); // terracotta
  expect(roofColor(0xada097, false, 1)).toBe(ROOF_SWATCHES[7]!.pitched); // old red tiles
  expect(roofColor(0x48536a, true, 1)).toBe(ROOF_SWATCHES[0]!.flat);
});

test('flat roofs never come out darker than the generic ones', () => {
  for (const s of ROOF_SWATCHES) expect(s.flat >> 16).toBeGreaterThanOrEqual(0x90);
});

test('unsampled roofs fall back to a stable pick', () => {
  expect(PITCHED_ROOFS).toContain(roofColor(null, false, 3));
  expect(FLAT_ROOFS).toContain(roofColor(null, true, 3));
  expect(roofColor(null, false, 3)).toBe(roofColor(null, false, 3));
});
