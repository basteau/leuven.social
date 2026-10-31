import { describe, expect, test } from 'bun:test';

import { town } from './walkable.fixture.ts';
import { WalkGrid, pickWalkable } from './walkable.ts';

describe('WalkGrid', () => {
  const grid = new WalkGrid(town);

  test('streets, squares and paths are walkable; the rest is not', () => {
    expect(grid.walkable(15, 45)).toBe(true);
    expect(grid.walkable(185, 48)).toBe(true); // the far tile
    expect(grid.walkable(75, 70)).toBe(true);
    expect(grid.walkable(20, 25)).toBe(true);
    expect(grid.walkable(30, 7.5)).toBe(true); // the diagonal leg stays connected
    expect(grid.walkable(30, 25)).toBe(false); // garden
    expect(grid.walkable(-5, 45)).toBe(false); // off the map
    expect(grid.walkable(15, 130)).toBe(false);
  });

  test('a building closes the road under it and keeps its height', () => {
    expect(grid.walkable(50, 42)).toBe(false);
    expect(grid.buildingHeight(50, 42)).toBe(16);
    expect(grid.walkable(50, 47)).toBe(true);
    expect(grid.buildingHeight(50, 47)).toBe(0);
  });

  test('a narrow path is still a ribbon at least a cell and a half wide', () => {
    expect(grid.walkable(19.4, 25)).toBe(true);
    expect(grid.walkable(20.6, 25)).toBe(true);
    expect(grid.walkable(22.5, 25)).toBe(false);
  });

  test('nearest finds the closest open cell within reach', () => {
    expect(grid.nearest(15.2, 45.7, 3)).toEqual([15.5, 45.5]);
    const [x, z] = grid.nearest(50, 44, 5)!;
    expect(x).toBeCloseTo(50.5);
    expect(z).toBeCloseTo(45.5);
    expect(grid.nearest(30, 25, 3)).toBeNull();
  });

  test('cells and centres round-trip', () => {
    const cell = grid.cellAt(12.3, 7.9);
    expect(grid.centre(cell)).toEqual([12.5, 7.5]);
    expect(grid.cellAt(-1, 0)).toBe(-1);
    expect(grid.value(-1)).toBe(0);
  });
});

describe('pickWalkable', () => {
  const grid = new WalkGrid(town);
  // Looking north and down at 45°, as the camera does when its yaw is 0.
  const down: [number, number, number] = [0, -1, -1];

  test('a ray onto the street lands on the street', () => {
    expect(pickWalkable(grid, [15, 500, 545], down, 4)).toEqual([15.5, 45.5]);
  });

  test('a ray onto a roof means the street in front of the building', () => {
    // It would reach the ground at z = 40, behind the house's front wall at z = 45.
    const [x, z] = pickWalkable(grid, [50, 500, 540], down, 6)!;
    expect(x).toBeCloseTo(50.5);
    expect(z).toBeGreaterThan(45);
  });

  test('looking straight down still works, and looking up finds nothing', () => {
    expect(pickWalkable(grid, [75, 300, 70], [0, -1, 0], 2)).toEqual([75.5, 70.5]);
    expect(pickWalkable(grid, [50, 300, 42], [0, -1, 0], 2)).toBeNull();
    expect(pickWalkable(grid, [15, 0, 45], [0, 1, 0], 4)).toBeNull();
  });

  test('a ray onto a garden finds nothing if no street is near', () => {
    expect(pickWalkable(grid, [30, 500, 525], down, 3)).toBeNull();
  });
});
