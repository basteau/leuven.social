import { describe, expect, test } from 'bun:test';

import { Router, clearLine } from './route.ts';
import { WalkGrid } from './walkable.ts';
import { town } from './walkable.fixture.ts';

/** Every point along the route, every quarter metre, is walkable. */
function walkableAlong(grid: WalkGrid, route: Float32Array): boolean {
  for (let i = 0; i + 3 < route.length; i += 2) {
    const [ax, az, bx, bz] = [route[i]!, route[i + 1]!, route[i + 2]!, route[i + 3]!];
    const steps = Math.ceil(Math.hypot(bx - ax, bz - az) * 4);
    for (let s = 0; s <= steps; s++) {
      if (!grid.walkable(ax + ((bx - ax) * s) / steps, az + ((bz - az) * s) / steps)) return false;
    }
  }
  return true;
}

describe('Router', () => {
  const grid = new WalkGrid(town);
  const router = new Router(grid);

  test('a straight street is one leg, from and to the exact points', () => {
    expect(Array.from(router.route(12.2, 47.3, 30.8, 47.3)!)).toEqual([
      12.199999809265137, 47.29999923706055, 30.799999237060547, 47.29999923706055,
    ]);
  });

  test('walks round a building, keeping clear of its wall', () => {
    const route = router.route(30, 41, 70, 41)!;
    expect(route.length).toBeGreaterThan(4);
    expect(walkableAlong(grid, route)).toBe(true);
    for (let i = 2; i < route.length - 2; i += 2) expect(route[i + 1]!).toBeGreaterThan(45.4);
  });

  test('turns onto a footpath and follows it', () => {
    const route = router.route(150, 47, 38, 5.5)!;
    expect(walkableAlong(grid, route)).toBe(true);
    expect(route.at(-2)).toBeCloseTo(38);
    expect(route.at(-1)).toBeCloseTo(5.5);
  });

  test('crosses into the square', () => {
    const route = router.route(15, 45, 85, 75)!;
    expect(walkableAlong(grid, route)).toBe(true);
  });

  test('nothing leads to a closed spot, an island or a far corner', () => {
    expect(router.route(15, 45, 30, 25)).toBeNull(); // garden
    expect(router.route(30, 25, 15, 45)).toBeNull();
    expect(router.route(15, 45, 155, 105)).toBeNull(); // the square nothing reaches
  });

  test('a start and goal in one cell is a single step', () => {
    expect(Array.from(router.route(15.1, 45.1, 15.6, 45.6)!)).toHaveLength(4);
  });

  test('refuses routes longer than a view', () => {
    const long = new WalkGrid({
      area: [{ minX: 0, minZ: 0, maxX: 700, maxZ: 20 }],
      bounds: { minX: 0, minZ: 0, maxX: 700, maxZ: 20 },
      roads: [Float32Array.of(0, 5, 700, 5, 700, 15, 0, 15)],
      plazas: [],
      paths: [],
      buildings: [],
    });
    const far = new Router(long);
    expect(far.route(5, 10, 695, 10)).toBeNull();
    expect(far.route(5, 10, 300, 10)).not.toBeNull();
  });
});

test('searches a wide open square to its edges before giving up', () => {
  const square = new WalkGrid({
    area: [{ minX: 0, minZ: 0, maxX: 400, maxZ: 400 }],
    bounds: { minX: 0, minZ: 0, maxX: 400, maxZ: 400 },
    roads: [],
    plazas: [
      Float32Array.of(0, 0, 300, 0, 300, 300, 0, 300),
      Float32Array.of(390, 390, 399, 390, 399, 399, 390, 399),
    ],
    paths: [],
    buildings: [],
  });
  const router = new Router(square);
  expect(router.route(150, 150, 395, 395)).toBeNull();
  expect(router.route(10, 10, 290, 290)).toHaveLength(4);
});

test('routes along the very edge of the grid, whose size is a whole number of tiles', () => {
  const edge = new WalkGrid({
    area: [{ minX: 0, minZ: 0, maxX: 128, maxZ: 64 }],
    bounds: { minX: 0, minZ: 0, maxX: 128, maxZ: 64 },
    roads: [Float32Array.of(0, 60, 128, 60, 128, 64, 0, 64)],
    plazas: [],
    paths: [],
    buildings: [],
  });
  const route = new Router(edge).route(0.5, 63.5, 127.5, 63.5)!;
  expect(Array.from(route.slice(-2))).toEqual([127.5, 63.5]);
  expect(edge.value(128 * 64)).toBe(0);
});

describe('clearLine', () => {
  const grid = new WalkGrid(town);

  test('needs room on both sides', () => {
    expect(clearLine(grid, 12, 47, 30, 47)).toBe(true);
    expect(clearLine(grid, 30, 45.3, 70, 45.3)).toBe(false); // scrapes the wall
    expect(clearLine(grid, 15, 47, 15, 47)).toBe(true);
    expect(clearLine(grid, 30, 25, 30, 25)).toBe(false);
  });
});
