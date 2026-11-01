import { expect, test } from 'bun:test';

import { capShedsUnderTrees, shedHeight } from './sheds.ts';

const square = (x: number, z: number, side: number) =>
  new Float32Array([x, z, x + side, z, x + side, z + side, x, z + side]);
const shed = (x: number, height: number, side = 4) => ({
  ring: square(x, 0, side),
  height,
  eave: height - 1,
});

test('a lone shed under a crown of its height is capped to a shed height', () => {
  const sheds = [shed(0, 15)];
  expect(capShedsUnderTrees(sheds, [[3, 3, 16]])).toBe(1);
  expect(sheds[0]!.height).toBe(shedHeight(16));
  expect(sheds[0]!.eave).toBeLessThanOrEqual(sheds[0]!.height);
});

test('a lone tower with no tree beside it keeps its height', () => {
  const towers = [shed(0, 15)];
  // A crown far away, and a low one close by: neither explains a 15 m reading.
  expect(
    capShedsUnderTrees(towers, [
      [40, 0, 16],
      [2, 2, 6],
    ]),
  ).toBe(0);
  expect(towers[0]!.height).toBe(15);
});

test('row houses, big buildings and low sheds are left alone', () => {
  const row = [shed(0, 12, 5), shed(5, 12, 5)];
  const big = [shed(0, 15, 9)];
  const low = [shed(0, 4)];
  const crown = [[3, 3, 14]] as const;
  expect(capShedsUnderTrees(row, crown)).toBe(0);
  expect(capShedsUnderTrees(big, crown)).toBe(0);
  expect(capShedsUnderTrees(low, crown)).toBe(0);
});

test('shed heights grow with the footprint, from 3 m', () => {
  expect(shedHeight(2)).toBe(3);
  expect(shedHeight(36)).toBe(9);
});
