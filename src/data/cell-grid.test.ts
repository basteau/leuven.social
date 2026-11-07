import { describe, expect, test } from 'bun:test';

import { CellGrid, TILE, inRing, ringBox, ringDistance, wallPush } from './cell-grid.ts';
import type { Wall } from './cell-grid.ts';

describe('a grid of cells', () => {
  const box = { minX: -10, minZ: 0, maxX: 90, maxZ: 40 };

  test('fills a tile the first time it is asked, and again after a refill', () => {
    let fills = 0;
    let value = 1;
    const grid = new CellGrid(
      box,
      (tile) => {
        fills++;
        tile.fill(value);
      },
      0.5,
    );
    expect([grid.cols, grid.rows, grid.tilesX]).toEqual([200, 80, Math.ceil(200 / TILE)]);
    expect(grid.value(grid.cellAt(0, 0))).toBe(1);
    expect(grid.value(grid.cellAt(1, 1))).toBe(1);
    expect(fills).toBe(1);
    value = 2;
    grid.refill({ minX: 0, minZ: 0, maxX: 1, maxZ: 1 });
    expect(grid.value(grid.cellAt(0, 0))).toBe(2);
    expect(fills).toBe(2);
    expect(grid.value(-1, 9)).toBe(9);
    expect(grid.cellAt(-11, 0)).toBe(-1);
    expect(grid.centre(grid.cellAt(-9.9, 0.1))).toEqual([-9.75, 0.25]);
  });

  test('rings and ribbons fill the cells whose centres they cover', () => {
    const grid = new CellGrid(box, (tile, x0, z0) => {
      grid.fillRing(tile, [0, 0, 10, 0, 10, 10, 0, 10], 1, x0, z0);
      grid.fillRibbon(tile, [20, 5, 30, 5], 1, 2, x0, z0);
      grid.fillRibbon(tile, [25, 5, 25, 5], 2, 3, x0, z0, (old) => old === 2);
    });
    expect(grid.value(grid.cellAt(5, 5))).toBe(1);
    expect(grid.value(grid.cellAt(15, 5))).toBe(0);
    expect(grid.value(grid.cellAt(25, 5))).toBe(2); // kept
    expect(grid.value(grid.cellAt(25, 6.5))).toBe(3);
    expect(grid.blend(5, 5, (v) => v === 0)).toBe(0);
    expect(grid.blend(-20, 5, (v) => v === 0)).toBe(1);
    expect(grid.nearest(15, 5, 6, (c) => grid.value(c) === 1)).toEqual([9.5, 5.5]);
    expect(grid.nearest(50, 30, 3, (c) => grid.value(c) === 1)).toBeNull();
  });
});

test('rings: inside, and the box round them', () => {
  const ring = [0, 0, 4, 0, 4, 4, 0, 4];
  expect(inRing(ring, 2, 2)).toBe(true);
  expect(inRing(ring, 5, 2)).toBe(false);
  expect(ringBox(ring, 1)).toEqual({ minX: -1, minZ: -1, maxX: 5, maxZ: 5 });
  expect(ringDistance(ring, 2, 2)).toBe(2);
  expect(ringDistance(ring, 7, 2)).toBe(3);
  expect(ringDistance(ring, 7, 8)).toBe(5);
});

test('walls push a body out, by the deepest reach', () => {
  const walls: Wall[] = [
    { line: [0, 0, 4, 0, 4, 4, 0, 4], ring: true, half: 0, box: ringBox([0, 0, 4, 4]), seen: 0 },
    { line: [10, 0, 10, 4], ring: false, half: 0.2, box: ringBox([10, 0, 10, 4], 0.2), seen: 0 },
  ];
  const sum: [number, number, number] = [0, 0, 0];
  wallPush(walls, 4.3, 2, 0.5, 1, sum);
  expect(sum[0]).toBeGreaterThan(0);
  expect(sum[2]).toBeCloseTo(0.2);
  // Inside the ring: out through the nearest face.
  const inside: [number, number, number] = [0, 0, 0];
  wallPush(walls, 3.8, 2, 0.5, 2, inside);
  expect(inside[0]).toBeGreaterThan(0);
  // The same query meets a wall once.
  const twice: [number, number, number] = [0, 0, 0];
  wallPush(walls, 9.6, 2, 0.5, 3, twice);
  expect(twice[0]).toBeLessThan(0);
});

test('places round a spot: the nearest open ones first, spread out, as many as asked', () => {
  // Open everywhere but a wall along x 4–5.
  const grid = new CellGrid({ minX: 0, minZ: 0, maxX: 20, maxZ: 20 }, (tile, x0, z0) => {
    tile.fill(1);
    grid.fillRing(tile, [4, 0, 5, 0, 5, 20, 4, 20], 0, x0, z0);
  });
  const open = (cell: number) => grid.value(cell) === 1;
  const places = grid.around(4.5, 10.5, 4, open, 5);
  expect(places).toHaveLength(5);
  const d = places.map(([x, z]) => Math.hypot(x - 4.5, z - 10.5));
  expect(d).toEqual(d.toSorted((a, b) => a - b));
  for (const [x] of places) expect(x < 4 || x > 5).toBe(true);
  for (const [i, [x, z]] of places.entries()) {
    for (const [px, pz] of places.slice(0, i))
      expect(Math.hypot(x - px, z - pz)).toBeGreaterThanOrEqual(1.5);
  }
  expect(grid.around(4.5, 10.5, 0.4, open, 5)).toEqual([]);
});
