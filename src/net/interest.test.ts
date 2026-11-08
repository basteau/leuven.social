import { describe, expect, test } from 'bun:test';

import { CELL_SIZE } from '../data/grid.ts';
import { around, cellAt, cellX, cellZ, watches } from './interest.ts';

describe('cells', () => {
  test('a point belongs to the cell the renderer has it in', () => {
    expect(cellX(cellAt(0, 0))).toBe(0);
    expect(cellZ(cellAt(0, 0))).toBe(0);
    expect(cellX(cellAt(CELL_SIZE - 0.01, 0))).toBe(0);
    expect(cellX(cellAt(CELL_SIZE, 0))).toBe(1);
    expect(cellX(cellAt(-0.01, 0))).toBe(-1);
    expect(cellZ(cellAt(0, -0.01))).toBe(-1);
    expect(cellZ(cellAt(0, -CELL_SIZE * 4 - 1))).toBe(-5);
  });

  test('a cell watches itself and the eight around it, and nothing further', () => {
    const middle = cellAt(10, 10);
    const ring = around(middle);
    expect(new Set(ring).size).toBe(9);
    expect(ring).toContain(middle);
    for (const cell of ring) expect(watches(middle, cell)).toBe(true);
    expect(watches(middle, cellAt(CELL_SIZE * 2 + 10, 10))).toBe(false);
    expect(watches(middle, cellAt(10, -CELL_SIZE * 2 + 10))).toBe(false);
  });

  test('neighbours are found on both sides of the origin', () => {
    const cells = around(cellAt(-1, -1));
    expect(cells.map(cellX).toSorted((a, b) => a - b)).toEqual([-2, -2, -2, -1, -1, -1, 0, 0, 0]);
    expect(cells.map(cellZ).toSorted((a, b) => a - b)).toEqual([-2, -2, -2, -1, -1, -1, 0, 0, 0]);
  });
});
