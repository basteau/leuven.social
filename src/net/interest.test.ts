import { describe, expect, test } from 'bun:test';

import { CELL_SIZE } from '../data/grid.ts';
import { FINE_REACH, cellAt } from './interest.ts';

describe('cells', () => {
  test('a point belongs to the cell the renderer has it in, on both sides of the origin', () => {
    expect(cellAt(0, 0)).toBe(cellAt(CELL_SIZE - 0.01, CELL_SIZE - 0.01));
    expect(cellAt(CELL_SIZE, 0)).not.toBe(cellAt(0, 0));
    expect(cellAt(-0.01, 0)).not.toBe(cellAt(0, 0));
    expect(cellAt(0, -0.01)).not.toBe(cellAt(0, 0));
    expect(cellAt(-CELL_SIZE * 4 - 1, 0)).toBe(cellAt(-CELL_SIZE * 5 + 1, 0));
  });

  test('a view can reach a cell across before anyone is known in full', () => {
    expect(FINE_REACH).toBe(CELL_SIZE);
  });
});
