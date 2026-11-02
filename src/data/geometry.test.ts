import { describe, expect, test } from 'bun:test';

import {
  areaIndex,
  areaOutline,
  boundsOf,
  clampToArea,
  clipRing,
  clipRingToArea,
  normalizeRing,
  orientedRect,
  pointInRing,
  ringInArea,
  ringInside,
  signedArea,
  joinRings,
  pointAlong,
  simplifyLine,
  simplifyRing,
  clipLine,
  uncoveredPieces,
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

describe('areas of abutting rectangles', () => {
  // An L: a 100 m square with a 50 × 50 m square under its left half.
  const area = [
    { minX: 0, minZ: 0, maxX: 100, maxZ: 100 },
    { minX: 0, minZ: 100, maxX: 50, maxZ: 150 },
  ];

  test('bounds, membership and clamping', () => {
    expect(boundsOf(area)).toEqual({ minX: 0, minZ: 0, maxX: 100, maxZ: 150 });
    expect(areaIndex(area, 10, 120)).toBe(1);
    expect(areaIndex(area, 80, 120)).toBe(-1);
    expect(ringInArea([10, 90, 40, 90, 40, 140, 10, 140], area)).toBe(true);
    expect(ringInArea([60, 90, 80, 90, 80, 120, 60, 120], area)).toBe(false);
    expect(clampToArea(area, 80, 140)).toEqual([50, 140]);
    expect(clampToArea(area, 120, 20)).toEqual([100, 20]);
    expect(clampToArea(area, -20, 125)).toEqual([0, 125]);
  });

  test('a ring across the seam is clipped into one piece per rectangle', () => {
    const pieces = clipRingToArea([10, 80, 90, 80, 90, 140, 10, 140], area);
    expect(pieces.map((p) => Math.abs(signedArea(p))).toSorted((a, b) => a - b)).toEqual([
      1600, 1600,
    ]);
  });

  test('the outline leaves out the stretch the two rectangles share', () => {
    const edges = areaOutline(area);
    expect(edges).toHaveLength(7);
    const length = edges.reduce((sum, e) => sum + Math.hypot(e.x1 - e.x0, e.z1 - e.z0), 0);
    expect(length).toBe(500);
    // The open half of the big square's bottom side faces south (+z).
    expect(edges).toContainEqual({ x0: 50, z0: 100, x1: 100, z1: 100, nx: 0, nz: 1 });
  });
});

describe('simplifyRing', () => {
  test('drops near-collinear vertices and keeps real corners', () => {
    const wobbly = [0, 0, 5, 0.05, 10, 0, 10, 10, 5, 10.1, 0, 10];
    expect(simplifyRing(wobbly, 0.2)).toEqual([0, 0, 10, 0, 10, 10, 0, 10]);
    expect(simplifyRing(wobbly, 0)).toEqual(wobbly);
  });

  test('never collapses below a triangle', () => {
    expect(simplifyRing([0, 0, 10, 0.01, 20, 0, 10, 0.02], 1).length).toBeGreaterThanOrEqual(6);
  });
});

test('simplifyLine keeps the ends and the shape of a curve, and drops what lies on a straight', () => {
  expect(simplifyLine([0, 0, 5, 0.05, 10, 0], 0.1)).toEqual([0, 0, 10, 0]);
  expect(simplifyLine([0, 0, 5, 3, 10, 0, 15, 0.02, 20, 0], 0.1)).toEqual([
    0, 0, 5, 3, 10, 0, 20, 0,
  ]);
  expect(simplifyLine([0, 0, 1, 1], 5)).toEqual([0, 0, 1, 1]);
  // A loop back to its start still keeps the far point.
  expect(simplifyLine([0, 0, 5, 0, 0, 0], 0.1)).toEqual([0, 0, 5, 0, 0, 0]);
});

test('joinRings chains open ways into closed rings, either way round', () => {
  const square = [
    [0, 0, 10, 0],
    [10, 10, 10, 0], // runs backwards
    [10, 10, 0, 10, 0, 0],
  ];
  const [ring] = joinRings(square);
  expect(ring).toHaveLength(8);
  expect(Math.abs(signedArea(ring!))).toBe(100);
  // Already closed, and a chain that never closes.
  expect(joinRings([[0, 0, 4, 0, 4, 4, 0, 0]])).toEqual([[0, 0, 4, 0, 4, 4]]);
  expect(
    joinRings([
      [0, 0, 4, 0],
      [4, 0, 4, 4],
      [9, 9],
    ]),
  ).toEqual([]);
});

test('clipLine keeps the parts of a line inside the area, split where it leaves', () => {
  const area = { minX: 0, minZ: 0, maxX: 10, maxZ: 10 };
  expect(clipLine([2, 2, 8, 2], area)).toEqual([[2, 2, 8, 2]]);
  expect(clipLine([-5, 5, 5, 5, 5, 15], area)).toEqual([[0, 5, 5, 5, 5, 10]]);
  expect(clipLine([2, 2, 2, 20, 8, 20, 8, 2], area)).toEqual([
    [2, 2, 2, 10],
    [8, 10, 8, 2],
  ]);
  expect(clipLine([-5, -5, -1, 20], area)).toEqual([]);
  expect(clipLine([20, 5, 30, 5], area)).toEqual([]);
});

/** A road across x = 10..20. */
const road = (x: number) => x > 10 && x < 20;

describe('uncoveredPieces', () => {
  test('cuts a line where it goes under and keeps its own vertices elsewhere', () => {
    const pieces = uncoveredPieces([0, 0, 5, 0, 30, 0, 30, 5], (x) => road(x));
    expect(pieces.length).toBe(2);
    expect(pieces[0]!.slice(0, 4)).toEqual([0, 0, 5, 0]);
    expect(pieces[0]!.at(-2)).toBeCloseTo(10, 0);
    expect(pieces[1]![0]).toBeCloseTo(20, 0);
    expect(pieces[1]!.slice(-4)).toEqual([30, 0, 30, 5]);
  });

  test('a line that never goes under comes back whole, one fully under not at all', () => {
    expect(uncoveredPieces([0, 0, 5, 0, 5, 5], () => false)).toEqual([[0, 0, 5, 0, 5, 5]]);
    expect(uncoveredPieces([12, 0, 18, 0], (x) => road(x))).toEqual([]);
  });
});

test('pointAlong walks a polyline by its length and heads along the segment it lands on', () => {
  const line = [0, 0, 10, 0, 10, 10];
  expect(pointAlong(line, 0)).toEqual([0, 0, 1, 0]);
  expect(pointAlong(line, 0.25)).toEqual([5, 0, 1, 0]);
  expect(pointAlong(line, 0.75)).toEqual([10, 5, 0, 1]);
  expect(pointAlong(line, 1)).toEqual([10, 10, 0, 1]);
  expect(pointAlong(line, 2)).toEqual([10, 10, 0, 1]);
  expect(pointAlong([3, 4], 0.5)).toEqual([3, 4, 1, 0]);
});
