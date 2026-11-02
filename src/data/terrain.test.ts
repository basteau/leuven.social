import { describe, expect, test } from 'bun:test';

import { FLAT, Terrain } from './terrain.ts';
import type { Corner } from './terrain.ts';

// A 3 × 3 grid of 10 m squares anchored at (-10, -10): a slope up to the east and a bump at
// node (1, 1), which sits on the origin.
const hill = new Terrain({
  step: 10,
  minX: -10,
  minZ: -10,
  cols: 3,
  rows: 3,
  heights: Float32Array.of(0, 1, 2, 0, 4, 2, 0, 1, 2),
});

/** Twice the signed area of a polygon in (x, z). */
const area = (polygon: readonly Corner[]) =>
  polygon.reduce((sum, p, i) => {
    const q = polygon[(i + 1) % polygon.length]!;
    return sum + p[0]! * q[2]! - q[0]! * p[2]!;
  }, 0);

describe('Terrain', () => {
  test('refuses a grid without a square in it', () => {
    expect(() => new Terrain({ ...hill, cols: 1, heights: new Float32Array(3) })).toThrow(
      RangeError,
    );
    expect(() => new Terrain({ ...hill, heights: new Float32Array(4) })).toThrow(RangeError);
    expect(() => new Terrain({ ...hill, step: 0 })).toThrow(RangeError);
  });

  test('knows its lowest and highest ground', () => {
    expect([hill.lowest, hill.highest]).toEqual([0, 4]);
    expect([FLAT.lowest, FLAT.highest]).toEqual([0, 0]);
  });

  test('is the grid at its nodes and linear across each triangle', () => {
    expect(hill.height(0, 0)).toBe(4);
    expect(hill.height(10, -10)).toBe(2);
    expect(hill.height(-10, 10)).toBe(0);
    // Along the diagonal from (i, j) to (i + 1, j + 1), both triangles agree.
    expect(hill.height(-5, -5)).toBeCloseTo(2);
    // Upper triangle of the first square, (-10,-10), (0,-10), (0,0): 0, 1, 4.
    expect(hill.height(-2, -8)).toBeCloseTo(0 + 0.8 * 1 + 0.2 * 3);
    // Lower triangle, (-10,-10), (0,0), (-10,0): 0, 4, 0.
    expect(hill.height(-8, -2)).toBeCloseTo(0.2 * 4);
  });

  test('holds the edge height off the grid', () => {
    expect(hill.height(50, 0)).toBe(2);
    expect(hill.height(-50, -50)).toBe(0);
  });

  test('gives the plane of the triangle under a point', () => {
    for (const [x, z] of [
      [-2, -8],
      [-8, -2],
      [3, 7],
      [7, 3],
    ] as const) {
      const [a, b, c] = hill.plane(x, z);
      // Anywhere in the same triangle, the plane is the ground.
      for (const [dx, dz] of [
        [0, 0],
        [0.5, 0],
        [0, -0.5],
      ] as const) {
        expect(a + b * (x + dx) + c * (z + dz)).toBeCloseTo(hill.height(x + dx, z + dz));
      }
    }
  });

  test('stands a ring on its lowest corner', () => {
    expect(hill.base([-1, -1, 1, -1, 1, 1, -1, 1])).toBeCloseTo(hill.height(-1, 1));
    expect(hill.base([0, 0])).toBe(4);
  });

  test('gives the range of the ground within bounds', () => {
    expect(hill.range({ minX: -9, minZ: -9, maxX: -1, maxZ: -1 })).toEqual([0, 4]);
    expect(hill.range({ minX: -100, minZ: -100, maxX: 100, maxZ: 100 })).toEqual([0, 4]);
    expect(FLAT.range({ minX: 5, minZ: 5, maxX: 6, maxZ: 6 })).toEqual([0, 0]);
  });
});

describe('clip', () => {
  const square: Corner[] = [
    [-7, 0.1, -7, -7],
    [7, 0.1, -7, 7],
    [7, 0.1, 7, 7],
    [-7, 0.1, 7, -7],
  ];

  test('cuts a polygon into pieces that each lie in one triangle', () => {
    const pieces = hill.clip(square);
    // Four squares, each cut on its diagonal.
    expect(pieces.length).toBe(8);
    let total = 0;
    for (const piece of pieces) {
      total += area(piece);
      const [cx, cz] = [
        piece.reduce((s, p) => s + p[0]!, 0) / piece.length,
        piece.reduce((s, p) => s + p[2]!, 0) / piece.length,
      ];
      const [a, b, c] = hill.plane(cx, cz);
      for (const p of piece)
        expect(a + b * p[0]! + c * p[2]!).toBeCloseTo(hill.height(p[0]!, p[2]!));
    }
    expect(total).toBeCloseTo(area(square));
  });

  test('carries values along, and cut points are the same either side', () => {
    const pieces = hill.clip(square);
    const seen = new Map<string, number>();
    for (const piece of pieces) {
      for (const p of piece) {
        // The fourth value was x at every corner, so it still is.
        expect(p[3]).toBeCloseTo(p[0]!);
        expect(p[1]).toBeCloseTo(0.1);
        const key = p.join(',');
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
    }
    const cut = [...seen.keys()].filter((k) => !square.some((p) => p.join(',') === k));
    expect(cut.length).toBeGreaterThan(0);
    for (const key of cut) expect(seen.get(key)).toBeGreaterThanOrEqual(2);
  });

  test('keeps the area of a concave polygon', () => {
    // A U open to the south, its arms either side of x = 0.
    const u: Corner[] = [
      [-8, 0, -8],
      [8, 0, -8],
      [8, 0, 8],
      [4, 0, 8],
      [4, 0, -4],
      [-4, 0, -4],
      [-4, 0, 8],
      [-8, 0, 8],
    ];
    const total = hill.clip(u).reduce((sum, piece) => sum + area(piece), 0);
    expect(total).toBeCloseTo(area(u));
  });

  test('leaves a polygon inside one triangle whole', () => {
    const small: Corner[] = [
      [1, 0, 6],
      [3, 0, 6],
      [3, 0, 8],
    ];
    expect(hill.clip(small)).toEqual([small]);
  });

  test('cuts walls standing on a line into upright pieces', () => {
    const wall: Corner[] = [
      [-5, 0, -2],
      [5, 0, -2],
      [5, 1, -2],
      [-5, 1, -2],
    ];
    const pieces = hill.clip(wall);
    // Cut at x = 0 and on the diagonal x - z = -10 + 10 = 0… where it crosses z = -2: x = -2.
    expect(pieces.length).toBe(3);
    for (const piece of pieces) expect(new Set(piece.map((p) => p[2])).size).toBe(1);
  });

  test('cuts nothing on level ground', () => {
    expect(FLAT.clip(square)).toEqual([square]);
  });
});

describe('cut', () => {
  test('gives the points where a segment crosses the edges, in order', () => {
    const points = hill.cut([-8, 0, -1], [8, 0, -1]);
    expect(points.map((p) => p[0]!)).toEqual([-8, expect.closeTo(-1), expect.closeTo(0), 8]);
    expect(points.every((p) => p[2] === -1)).toBe(true);
  });

  test('counts a node once, and walks the other way just as well', () => {
    const points = hill.cut([5, 0, 5], [-5, 0, -5]);
    expect(points.map((p) => p[0]!)).toEqual([5, expect.closeTo(0), -5]);
  });

  test('leaves an upright or level segment whole', () => {
    expect(hill.cut([1, 0, 1], [1, 5, 1])).toEqual([
      [1, 0, 1],
      [1, 5, 1],
    ]);
    expect(FLAT.cut([-9, 0, 0], [9, 0, 0])).toEqual([
      [-9, 0, 0],
      [9, 0, 0],
    ]);
  });
});
