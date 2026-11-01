import { expect, test } from 'bun:test';

import { deltaE, toOklab } from './colour.ts';
import { correctRoofColours, partyNeighbours, whitePoint } from './roof-colours.ts';

const box = (x: number) => new Float32Array([x, 0, x + 6, 0, x + 6, 10, x, 10]);
const roof = (x: number, roofColor: number | null, flat = false) => ({
  roofColor,
  flat,
  ring: box(x),
});

test('the white point is the median hue of the flat roofs', () => {
  const [a, b] = whitePoint([
    roof(0, 0x8a8f9a, true),
    roof(10, 0x8a8f9a, true),
    roof(20, 0xb0402a),
  ]);
  const [, wa, wb] = toOklab(0x8a8f9a);
  expect(a).toBeCloseTo(wa, 6);
  expect(b).toBeCloseTo(wb, 6);
  expect(whitePoint([roof(0, 0x8a8f9a)])).toEqual([0, 0]);
});

test('row houses sharing a wall are neighbours, lone houses are not', () => {
  expect(partyNeighbours([roof(0, null), roof(6, null), roof(30, null)])).toEqual([[1], [0], []]);
});

test('the cool cast comes off and the remaining hue is stretched', () => {
  // A bluish photo: grey flat roofs read blue, a faintly warm pitched roof reads grey.
  const roofs = [
    roof(100, 0x8a8f9a, true),
    roof(200, 0x8a8f9a, true),
    roof(300, 0x948c8f),
    roof(400, null),
  ];
  correctRoofColours(roofs);
  const [, fa, fb] = toOklab(roofs[0]!.roofColor!);
  expect(Math.hypot(fa, fb)).toBeLessThan(0.005);
  const [, a] = toOklab(roofs[2]!.roofColor!);
  expect(a).toBeGreaterThan(toOklab(0x948c8f)[1] * 1.5);
  expect(roofs[3]!.roofColor).toBeNull();
});

test('neighbours roofed alike are pulled together, different roofing is left alone', () => {
  const colours = [0x6a6f7c, 0x72747f, 0x666b78];
  const alike = colours.map((c, i) => roof(i * 6, c));
  const lone = colours.map((c, i) => roof(i * 20, c));
  correctRoofColours(alike);
  correctRoofColours(lone);
  const spread = (rs: typeof alike) => deltaE(rs[1]!.roofColor!, rs[2]!.roofColor!);
  expect(spread(alike)).toBeLessThan(spread(lone) / 2);
  const mixed = [roof(0, 0x6a6f7c), roof(6, 0xc06a48)];
  correctRoofColours(mixed);
  expect(mixed[1]!.roofColor).not.toBe(mixed[0]!.roofColor);
});
