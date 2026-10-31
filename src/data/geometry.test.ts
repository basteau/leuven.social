import { describe, expect, test } from 'bun:test';

import {
  clipRing,
  normalizeRing,
  orientedRect,
  pointInRing,
  ringInside,
  signedArea,
} from './geometry.ts';

const bounds = { minX: 0, minZ: 0, maxX: 10, maxZ: 10 };

describe('signedArea and normalizeRing', () => {
  test('counter-clockwise in (x, z) is positive', () => {
    expect(signedArea([0, 0, 2, 0, 2, 3, 0, 3])).toBe(6);
    expect(signedArea([0, 0, 0, 3, 2, 3, 2, 0])).toBe(-6);
  });

  test('orients rings and drops the closing point', () => {
    expect(normalizeRing([0, 0, 0, 1, 1, 1, 1, 0, 0, 0])).toEqual([1, 0, 1, 1, 0, 1, 0, 0]);
  });
});

describe('clipRing', () => {
  test('keeps a ring that is fully inside', () => {
    const ring = [1, 1, 4, 1, 4, 4, 1, 4];
    expect(Math.abs(signedArea(clipRing(ring, bounds)))).toBe(9);
    expect(ringInside(ring, bounds)).toBe(true);
  });

  test('cuts a ring that crosses the edge', () => {
    const clipped = clipRing([5, 5, 15, 5, 15, 15, 5, 15], bounds);
    expect(Math.abs(signedArea(clipped))).toBeCloseTo(25);
    expect(ringInside(clipped, bounds)).toBe(true);
  });

  test('drops a ring that is fully outside', () => {
    expect(clipRing([20, 20, 30, 20, 30, 30], bounds)).toEqual([]);
  });
});

describe('orientedRect', () => {
  test('fits a rotated rectangle exactly', () => {
    const a = Math.PI / 6;
    const [c, s] = [Math.cos(a), Math.sin(a)];
    const pts = [
      [0, 0],
      [8, 0],
      [8, 3],
      [0, 3],
    ].flatMap(([x, z]) => [x! * c - z! * s, x! * s + z! * c]);
    const r = orientedRect(pts);
    expect(r.halfLength).toBeCloseTo(4);
    expect(r.halfWidth).toBeCloseTo(1.5);
    expect(r.fill).toBeCloseTo(1);
    expect(Math.abs(r.ux * c + r.uz * s)).toBeCloseTo(1);
  });

  test('reports a low fill for an L-shape', () => {
    expect(orientedRect([0, 0, 10, 0, 10, 2, 2, 2, 2, 10, 0, 10]).fill).toBeCloseTo(0.36);
  });
});

test('pointInRing works for concave rings', () => {
  const ell = [0, 0, 10, 0, 10, 2, 2, 2, 2, 10, 0, 10];
  expect(pointInRing(ell, 1, 1)).toBe(true);
  expect(pointInRing(ell, 1, 8)).toBe(true);
  expect(pointInRing(ell, 6, 6)).toBe(false);
  expect(pointInRing(ell, -1, 1)).toBe(false);
});
