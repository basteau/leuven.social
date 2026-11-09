import { describe, expect, test } from 'bun:test';

import {
  FLAT,
  FLAT_GRID,
  Terrain,
  clipPolygon,
  clipStep,
  landform,
  stripRings,
} from './terrain.ts';
import type { Corner, GroundStep } from './terrain.ts';

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

  test('knows its steepest triangle', () => {
    // The west square's north half climbs 4 m east and falls 3 m south across 10 m.
    expect(hill.steepest).toBeCloseTo(0.5);
    expect(FLAT.steepest).toBe(0);
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

test('clipPolygon keeps what is inside a rectangle, each value interpolated', () => {
  const quad = [
    [-10, 0, 0, 0],
    [10, 0, 0, 20],
    [10, 0, 4, 20],
    [-10, 0, 4, 0],
  ];
  const b = { minX: 0, minZ: -5, maxX: 100, maxZ: 5 };
  const out = clipPolygon(quad, b);
  expect(Math.min(...out.map((p) => p[0]!))).toBe(0);
  expect(out.find((p) => p[0] === 0)?.[3]).toBe(10);
  expect(clipPolygon(quad, { minX: 50, minZ: 0, maxX: 60, maxZ: 5 })).toHaveLength(0);
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
      // The ground is one plane over the piece: its slope at the middle reaches every corner.
      const h = hill.height(cx, cz);
      const [sx, sz] = [hill.height(cx + 0.01, cz) - h, hill.height(cx, cz + 0.01) - h];
      for (const p of piece) {
        const plane = h + ((p[0]! - cx) * sx + (p[2]! - cz) * sz) / 0.01;
        expect(plane).toBeCloseTo(hill.height(p[0]!, p[2]!), 3);
      }
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

describe('landform', () => {
  const ramp = { line: Float32Array.of(10, 0, 30, 0), rise: Float32Array.of(4, 0), half: 3 };
  const ground = landform(FLAT_GRID, [ramp], []);

  test('lifts a strip along its centre line, and leaves the rest', () => {
    expect(ground.height(10, 0)).toBeCloseTo(4, 5);
    expect(ground.height(20, 0)).toBeCloseTo(2, 5);
    expect(ground.height(30, 0)).toBeCloseTo(0, 5);
    expect(ground.height(20, 3.5)).toBe(0);
    expect(ground.height(0, 0)).toBe(0);
  });

  test('never moves the bare landform', () => {
    expect(ground.plain(20, 0)).toBe(0);
  });

  test('a building beside a cutting stands on the landform, not down in it', () => {
    const cutting = { line: Float32Array.of(10, 0, 30, 0), rise: Float32Array.of(-5, -5), half: 3 };
    const sunk = landform(FLAT_GRID, [cutting], []);
    expect(sunk.height(20, 0)).toBe(-5);
    expect(sunk.base([18, 0, 22, 0, 22, 8, 18, 8])).toBe(0);
  });

  test('cuts what lies across a strip along its edges', () => {
    const pieces = ground.clip([
      [15, 0, -10],
      [25, 0, -10],
      [25, 0, 10],
      [15, 0, 10],
    ]);
    expect(pieces.length).toBeGreaterThan(1);
    // A lifted piece and the ground beside it: one lies over the other.
    expect(Math.max(...pieces.flat().map((p) => p[1]!))).toBeGreaterThan(1);
    expect(Math.min(...pieces.flat().map((p) => p[1]!))).toBe(0);
  });

  test('a piece wholly on the strip comes back lifted', () => {
    const pieces = ground.clip([
      [18, 0, -1],
      [22, 0, -1],
      [22, 0, 1],
      [18, 0, 1],
    ]);
    // Two, as a piece of a strip is two flat triangles, each corner at the strip's height there.
    expect(pieces).toHaveLength(2);
    expect(pieces[0]![0]![1]).toBeCloseTo(2.4, 4);
    for (const piece of pieces) {
      for (const p of piece) expect(p[1]).toBeCloseTo(ground.height(p[0]!, p[2]!), 4);
    }
  });

  test('a line across a strip stops at its edges', () => {
    const points = ground.cut([20, 0, -10], [20, 0, 10]);
    expect(points.length).toBeGreaterThan(2);
    expect(points.some((p) => p[1]! > 1)).toBe(true);
    expect(points[0]![1]).toBe(0);
    expect(points.at(-1)![1]).toBe(0);
  });

  test('a line along a ramp lies on it at every point', () => {
    const points = ground.cut([12, 0, 0], [28, 0, 0]);
    for (const p of points) expect(p[1]).toBeCloseTo(ground.height(p[0]!, p[2]!), 4);
  });

  test('a piece only near a strip is not cut', () => {
    const near = [
      [15, 0, 3.5],
      [25, 0, 3.5],
      [25, 0, 6],
      [15, 0, 6],
    ];
    expect(ground.clip(near)).toEqual([near]);
  });

  test('where strips overlap the stronger one wins', () => {
    const low = { line: Float32Array.of(0, 0, 40, 0), rise: Float32Array.of(1, 1), half: 5 };
    const both = landform(FLAT_GRID, [low, ramp], []);
    expect(both.height(12, 0)).toBeCloseTo(3.6, 4);
  });

  test('a bend shares its cross-section between its two quads', () => {
    const bend = {
      line: Float32Array.of(0, 0, 10, 0, 10, 10),
      rise: Float32Array.of(0, 5, 5),
      half: 2,
    };
    const bent = landform(FLAT_GRID, [bend], []);
    expect(bent.height(10, 0)).toBeCloseTo(5, 3);
    expect(bent.height(10, 5)).toBeCloseTo(5, 3);
  });

  test('its tracks follow only the ramps that carry them', () => {
    const rail = { ...ramp, rail: true };
    const road = { ...ramp, line: Float32Array.of(10, 20, 30, 20) };
    const both = landform(FLAT_GRID, [rail, road], []);
    expect(both.rails.height(20, 0)).toBeCloseTo(2, 5);
    expect(both.rails.height(20, 20)).toBe(0);
    expect(both.height(20, 20)).toBeCloseTo(2, 5);
  });

  test('its decks lie on a surface of their own', () => {
    const deck = { line: Float32Array.of(0, 0, 20, 0), rise: Float32Array.of(5, 5), half: 4 };
    const raised = landform(FLAT_GRID, [], [deck]);
    expect(raised.decks.height(10, 0)).toBeCloseTo(5, 5);
    expect(raised.height(10, 0)).toBe(0);
  });
});

const dropsRight = ({ ax, az, bx, bz, high, low }: GroundStep, ground: Terrain) => {
  const length = Math.hypot(bx - ax, bz - az);
  const [mx, mz] = [(ax + bx) / 2, (az + bz) / 2];
  const [rx, rz] = [((bz - az) / length) * 0.2, (-(bx - ax) / length) * 0.2];
  const [right, left] = [ground.height(mx + rx, mz + rz), ground.height(mx - rx, mz - rz)];
  expect(left).toBeCloseTo((high[0] + high[1]) / 2, 1);
  expect(right).toBeCloseTo((low[0] + low[1]) / 2, 1);
};

const heightsAt = (pieces: readonly (readonly Corner[])[]) => {
  for (const piece of pieces) {
    const corner = piece.find((p) => Math.hypot(p[0]! - 10, p[2]!) < 1e-6);
    if (corner) return corner[1]!;
  }
  return Number.NaN;
};

describe('the steps in the ground', () => {
  const up = {
    line: Float32Array.of(0, 0, 40, 0),
    rise: Float32Array.of(3, 3),
    half: 3,
  };
  test('plain ground has none', () => {
    expect(FLAT.steps()).toEqual([]);
  });

  test('a lifted strip has a step all the way round it, the drop to the right', () => {
    const ground = landform(FLAT_GRID, [up], []);
    const steps = ground.steps();
    expect(steps).toHaveLength(4);
    for (const step of steps) dropsRight(step, ground);
    expect(ground.steps()).toBe(steps);
  });

  test('a sunk one too: its walls face in', () => {
    const ground = landform(FLAT_GRID, [{ ...up, rise: Float32Array.of(-3, -3) }], []);
    expect(ground.steps()).toHaveLength(4);
    for (const step of ground.steps()) dropsRight(step, ground);
  });

  test('two strips at one level overlapping are one road: nothing down the middle', () => {
    const beside = { ...up, line: Float32Array.of(0, 4, 40, 4) };
    const ground = landform(FLAT_GRID, [up, beside], []);
    for (const { az, bz } of ground.steps()) {
      const z = (az + bz) / 2;
      expect(z > 0.5 && z < 3.5).toBe(false);
    }
  });

  test('two at different levels meet in one step, at the height between them', () => {
    const higher = { ...up, line: Float32Array.of(0, 4, 40, 4), rise: Float32Array.of(5, 5) };
    const ground = landform(FLAT_GRID, [up, higher], []);
    const between = ground.steps().filter((s) => Math.abs(s.az - 1) < 1e-3 && s.ax !== s.bx);
    let length = 0;
    for (const step of between) {
      expect(step.high).toEqual([5, 5]);
      expect(step.low).toEqual([3, 3]);
      length += Math.abs(step.bx - step.ax);
    }
    expect(length).toBeCloseTo(40, 3);
  });

  test('neighbouring pieces of a strip that meet at one height have no step between them', () => {
    const bent = {
      ...up,
      line: Float32Array.of(0, 0, 20, 0, 40, 0),
      rise: Float32Array.of(3, 2, 1),
    };
    const ground = landform(FLAT_GRID, [bent], []);
    expect(ground.steps().filter((s) => s.ax === 20 && s.bx === 20)).toEqual([]);
  });

  test('a strip that comes down to the ground stops having one there', () => {
    const fall = { ...up, rise: Float32Array.of(3, 0) };
    const ground = landform(FLAT_GRID, [fall], []);
    for (const step of ground.steps()) dropsRight(step, ground);
    expect(ground.steps().every((s) => Math.max(s.ax, s.bx) <= 40)).toBe(true);
  });

  test('every jump in the ground has a step on it', () => {
    const strips = [
      up,
      { ...up, line: Float32Array.of(10, -6, 30, 8), rise: Float32Array.of(-4, 1), half: 2 },
      { ...up, line: Float32Array.of(-5, 3, 50, 5), rise: Float32Array.of(0.5, 6), half: 2.5 },
    ];
    const ground = landform(FLAT_GRID, strips, []);
    const near = (x: number, z: number) =>
      ground.steps().some(({ ax, az, bx, bz }) => {
        const [dx, dz] = [bx - ax, bz - az];
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
        return Math.hypot(ax + dx * t - x, az + dz * t - z) < 0.06;
      });
    let jumps = 0;
    for (let z = -9; z < 11; z += 0.73) {
      for (let x = -8; x < 54; x += 0.02) {
        const [a, b] = [ground.height(x, z), ground.height(x + 0.02, z)];
        if (Math.abs(a - b) < 0.05) continue;
        jumps++;
        expect(near(x + 0.01, z)).toBe(true);
      }
    }
    expect(jumps).toBeGreaterThan(20);
  });

  test('a strip can reach further to one side than the other', () => {
    const wide = { ...up, left: Float32Array.of(6, 2), right: Float32Array.of(1, 1) };
    const ground = landform(FLAT_GRID, [wide], []);
    const rings = stripRings(wide);
    expect(rings).toHaveLength(2);
    expect(ground.height(1, -5)).toBe(3);
    expect(ground.height(1, 2)).toBe(0);
  });

  test('a piece is flat: however the ground over it is cut, one height at a point', () => {
    // Ends far from parallel, the case that used to have no one height.
    const flared = {
      line: Float32Array.of(0, 0, 20, 0, 30, 15),
      rise: Float32Array.of(4, 2, 0),
      half: 3,
      left: Float32Array.of(2, 6, 3),
      right: Float32Array.of(5, 2, 4),
    };
    const ground = landform(FLAT_GRID, [flared], []);
    const [a, b, c] = [
      [6, 0, 1],
      [14, 0, 2],
      [9, 0, -2],
    ].map(([x, y, z]) => [x!, y!, z!] as Corner);
    const whole = ground.clip([a!, b!, c!]);
    const inside = [10, 0, 0] as const;
    expect(whole.length).toBeGreaterThan(0);
    // Cut across a second way first: the same height comes out at the same point.
    const m = [10, 0, 0] as Corner;
    const parts = [
      [a!, m, c!],
      [m, b!, c!],
    ].flatMap((p) => ground.clip(p));
    expect(heightsAt(parts)).toBeCloseTo(ground.height(...([inside[0], inside[2]] as const)), 6);
  });

  test('a strip that folds over itself leaves that length out, not a tangle', () => {
    const fold = {
      line: Float32Array.of(0, 0, 0.01, 0, 0.02, 0),
      rise: Float32Array.of(3, 3, 3),
      half: 3,
    };
    expect(stripRings({ ...fold, line: Float32Array.of(5, 5, 5, 5) })).toEqual([]);
    expect(stripRings(fold).length).toBeLessThanOrEqual(4);
  });

  test('a piece whose first diagonal lies outside it splits along the other', () => {
    const kite = {
      line: Float32Array.of(0, 0, 10, 0),
      rise: Float32Array.of(2, 2),
      half: 3,
      left: Float32Array.of(0.01, 8),
      right: Float32Array.of(8, 0.01),
    };
    expect(stripRings(kite)).toHaveLength(2);
  });

  test('a step can be cut to the part of a height', () => {
    const step = { ax: 0, az: 0, bx: 10, bz: 0, high: [4, 0], low: [0, 0] } as const;
    expect(clipStep(step, 0)).toBe(step);
    expect(clipStep(step, 2)).toMatchObject({ ax: 0, bx: 5, high: [4, 2] });
    expect(clipStep(step, 0, 2)).toMatchObject({ ax: 5, bx: 10, high: [2, 0] });
    expect(clipStep(step, 5)).toBeNull();
    expect(clipStep({ ...step, high: [1, 1] }, 0, 0.5)).toBeNull();
    expect(clipStep({ ...step, high: [1, 3] }, 2)).toMatchObject({ ax: 5, bx: 10 });
  });
});
