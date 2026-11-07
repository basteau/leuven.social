import { describe, expect, test } from 'bun:test';

import {
  MARKER_INDICES,
  MARK,
  MARK_FROM,
  MARK_MIN,
  PUFF,
  PUFF_TO,
  avatarDot,
  markerDrop,
  markerGeometry,
  markerRadius,
  puff,
} from './marker.ts';

const range = (from: number, to: number, step: number) =>
  Array.from({ length: Math.round((to - from) / step) + 1 }, (_, i) => from + i * step);

describe('the marker', () => {
  test('drops onto the spot, overshooting once, then holds it', () => {
    expect(markerDrop(-1)).toBe(MARK_FROM);
    expect(markerDrop(0)).toBeCloseTo(MARK_FROM);
    expect(markerDrop(MARK)).toBe(1);
    expect(markerDrop(5)).toBe(1);
    const sizes = range(0, MARK, MARK / 40).map(markerDrop);
    expect(Math.min(...sizes)).toBeLessThan(0.95);
    expect(Math.min(...sizes)).toBeGreaterThan(0.8);
  });

  test('keeps one size on screen, but never smaller than a step', () => {
    expect(markerRadius(560)).toBeCloseTo(17.9, 1);
    expect(markerRadius(56)).toBeCloseTo(1.79, 2);
    expect(markerRadius(4)).toBe(MARK_MIN);
  });

  test('puffs dust outward, thinning until it is gone', () => {
    expect(puff(-0.1)).toBeNull();
    expect(puff(Number.NaN)).toBeNull();
    expect(puff(PUFF)).toBeNull();
    expect(puff(0)).toEqual([1, 1]);
    const [spread, left] = puff(PUFF * 0.9)!;
    expect(spread).toBeGreaterThan(2);
    expect(spread).toBeLessThanOrEqual(PUFF_TO);
    expect(left).toBeLessThan(0.25);
  });
});

test('far out, the avatar is two triangles lying flat, facing up', () => {
  const dot = avatarDot();
  expect(dot.index!.count).toBe(6);
  const position = dot.getAttribute('position');
  for (let i = 0; i < position.count; i++) expect(position.getY(i)).toBe(0);
  expect(dot.getAttribute('normal').getY(0)).toBeGreaterThan(0);
});

describe("the marker's shape", () => {
  const geometry = markerGeometry();
  const position = geometry.getAttribute('position');

  test('is the target first and the puffs after it', () => {
    // Seven hexagons of dust, four triangles each.
    expect(geometry.index!.count).toBe(MARKER_INDICES + 7 * 4 * 3);
  });

  test('lies flat, inside radius 1, puffs reaching just past it', () => {
    let far = 0;
    for (let i = 0; i < position.count; i++) {
      expect(position.getY(i)).toBe(0);
      far = Math.max(far, Math.hypot(position.getX(i), position.getZ(i)));
    }
    expect(far).toBeGreaterThan(1);
    expect(far).toBeLessThan(1.25);
  });

  test('faces up, so it shows from above', () => {
    const index = geometry.index!;
    for (let i = 0; i < index.count; i += 3) {
      const [a, b, c] = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
      const [ux, uz] = [position.getX(b) - position.getX(a), position.getZ(b) - position.getZ(a)];
      const [vx, vz] = [position.getX(c) - position.getX(a), position.getZ(c) - position.getZ(a)];
      // The y of (b - a) × (c - a): positive faces up.
      expect(uz * vx - ux * vz).toBeGreaterThan(0);
    }
  });
});
