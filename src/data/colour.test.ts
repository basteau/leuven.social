import { expect, test } from 'bun:test';

import { deltaE, fromOklab, toOklab } from './colour.ts';

test('Oklab round-trips sRGB colours', () => {
  for (const hex of [0x000000, 0xffffff, 0xb5523b, 0x4a5161, 0x86b064]) {
    expect(fromOklab(toOklab(hex))).toBe(hex);
  }
});

test('white has full lightness and no hue; out-of-gamut colours clip', () => {
  const [l, a, b] = toOklab(0xffffff);
  expect(l).toBeCloseTo(1, 4);
  expect(Math.hypot(a, b)).toBeLessThan(1e-4);
  expect(fromOklab([0.7, 0.5, 0])).toBe(fromOklab([0.7, 0.5, 0]) & 0xffffff);
  expect(fromOklab([2, 0, 0])).toBe(0xffffff);
});

test('ΔE is zero for the same colour and grows with the difference', () => {
  expect(deltaE(0x808080, 0x808080)).toBe(0);
  expect(deltaE(0x808080, 0x828282)).toBeLessThan(deltaE(0x808080, 0xa08080));
});
