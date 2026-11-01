import { describe, expect, test } from 'bun:test';

import type { V3 } from './mesh-builder.ts';
import {
  depthRange,
  fitShadow,
  lightFrame,
  shadowCovers,
  shadowNeeds,
  shadowPoint,
} from './shadow-fit.ts';

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const frame = lightFrame([-0.55, 0.62, 0.56]);

test('the light frame is orthonormal, with right level and dir towards the sun', () => {
  const { dir, right, up } = frame;
  for (const v of [dir, right, up]) expect(dot(v, v)).toBeCloseTo(1);
  expect(dot(dir, right)).toBeCloseTo(0);
  expect(dot(dir, up)).toBeCloseTo(0);
  expect(dot(right, up)).toBeCloseTo(0);
  expect(right[1]).toBeCloseTo(0);
  expect(dir[1]).toBeGreaterThan(0);
});

describe('fitting the shadow map to the view', () => {
  const ground: V3[] = [
    [-100, 0, -100],
    [100, 0, -100],
    [100, 0, 100],
    [-100, 0, 100],
  ];

  test('the need is the square around the points on the shadow plane', () => {
    const need = shadowNeeds(frame, ground);
    for (const p of ground) {
      expect(Math.abs(dot(p, frame.right) - need.x)).toBeLessThanOrEqual(need.half + 1e-9);
      expect(Math.abs(dot(p, frame.up) - need.y)).toBeLessThanOrEqual(need.half + 1e-9);
    }
  });

  test('the fit has room to pan, a stepped size and a texel-snapped centre', () => {
    const need = { x: 10.3, y: -7.9, half: 300 };
    const fit = fitShadow(need, 2048);
    expect(fit.half).toBeGreaterThanOrEqual(300 * 1.3);
    expect(Math.log2(fit.half) * 4).toBeCloseTo(Math.round(Math.log2(fit.half) * 4));
    const texel = (2 * fit.half) / 2048;
    expect((fit.x / texel) % 1).toBeCloseTo(0);
    expect(shadowCovers(fit, need)).toBe(true);
  });

  test('a fit is redone when the view leaves it or zooms in far enough', () => {
    const fit = fitShadow({ x: 0, y: 0, half: 300 }, 2048);
    expect(shadowCovers(fit, { x: 30, y: 0, half: 300 })).toBe(true);
    expect(shadowCovers(fit, { x: 400, y: 0, half: 300 })).toBe(false);
    expect(shadowCovers(fit, { x: 0, y: 0, half: 1000 })).toBe(false);
    expect(shadowCovers(fit, { x: 0, y: 0, half: 50 })).toBe(false);
    // Up close it asks for sharper: 2× too coarse is already too coarse.
    expect(shadowCovers(fit, { x: 0, y: 0, half: 120 })).toBe(true);
    expect(shadowCovers(fit, { x: 0, y: 0, half: 120 }, 1.6)).toBe(false);
  });
});

test('points on the shadow plane and depths along the sun', () => {
  const p = shadowPoint(frame, 5, -3, 100);
  expect(dot(p, frame.right)).toBeCloseTo(5);
  expect(dot(p, frame.up)).toBeCloseTo(-3);
  expect(dot(p, frame.dir)).toBeCloseTo(100);
  const [near, far] = depthRange(frame, [
    [0, 0, 0],
    [0, 90, 0],
  ]);
  expect(near).toBe(0);
  expect(far).toBeCloseTo(90 * frame.dir[1]);
});
