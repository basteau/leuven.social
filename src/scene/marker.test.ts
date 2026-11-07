import { describe, expect, test } from 'bun:test';

import { MARK, MARK_FROM, MARK_MIN, markerDrop, markerGeometry, markerRadius } from './marker.ts';

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
});

describe('the marker’s shape', () => {
  const geometry = markerGeometry();
  const position = geometry.getAttribute('position');

  test('is three bands, a dot and its rim', () => {
    expect(geometry.index!.count).toBe((3 * 20 * 2 + 18 + 20 * 2) * 3);
  });

  test('lies flat, inside radius 1', () => {
    let far = 0;
    for (let i = 0; i < position.count; i++) {
      expect(position.getY(i)).toBe(0);
      far = Math.max(far, Math.hypot(position.getX(i), position.getZ(i)));
    }
    expect(far).toBeCloseTo(1);
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
