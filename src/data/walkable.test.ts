import { describe, expect, test } from 'bun:test';

import type { Building, City } from './city.ts';
import { town } from './walkable.fixture.ts';

const rect = (x0: number, z0: number, x1: number, z1: number) =>
  Float32Array.of(x0, z0, x1, z0, x1, z1, x0, z1);

const house = (ring: Float32Array): Building => ({
  id: 2,
  tier: 'core',
  kind: 'house',
  roof: 'flat',
  height: 10,
  eave: 10,
  roofColor: null,
  ring,
  holes: [],
});
import { WalkGrid, pickWalkable } from './walkable.ts';

describe('WalkGrid', () => {
  const grid = new WalkGrid(town);

  test('streets, squares and paths are walkable; the rest is not', () => {
    expect(grid.walkable(15, 45)).toBe(true);
    expect(grid.walkable(185, 48)).toBe(true); // the far tile
    expect(grid.walkable(75, 70)).toBe(true);
    expect(grid.walkable(20, 25)).toBe(true);
    expect(grid.walkable(30, 7.5)).toBe(true); // the diagonal leg stays connected
    expect(grid.walkable(30, 25)).toBe(false); // the lake
    expect(grid.walkable(-5, 45)).toBe(false); // off the map
    expect(grid.walkable(15, 130)).toBe(false);
  });

  test('only roads, squares and paths open ground: tracks, railway land and platforms stay closed', () => {
    const land = Float32Array.of(100, 0, 120, 0, 120, 120, 100, 120);
    const railway: Pick<City, 'rails' | 'railLand' | 'platforms'> = {
      rails: [
        { kind: 'main', bridge: true, electrified: true, line: Float32Array.of(105, 0, 105, 120) },
      ],
      railLand: [land],
      // Raised to train-floor height, which the walker (at street level) can't climb onto.
      platforms: [Float32Array.of(110, 10, 114, 10, 114, 30, 110, 30)],
    };
    const withRails = new WalkGrid({ ...town, ...railway });
    expect(withRails.walkable(105, 20)).toBe(false);
    expect(withRails.walkable(112, 20)).toBe(false);
    expect(withRails.walkable(117, 90)).toBe(false);
    expect(withRails.walkable(105, 45)).toBe(true); // the street under the bridge is still the street
  });

  test('dry ground is open: lawns, verges and gardens, not only streets', () => {
    const dry = new WalkGrid({ ...town, water: [] });
    expect(dry.walkable(30, 25)).toBe(true);
    expect(dry.walkable(120, 90)).toBe(true);
    expect(dry.walkable(50, 42)).toBe(false); // still not through the house
    expect(dry.walkable(65, 74)).toBe(false); // nor the tank
  });

  test('a walk starts on a street, never in a garden walled in by houses', () => {
    // On dry ground, a yard north of the street closed in on all four sides by houses.
    const walls = [rect(100, 10, 130, 14), rect(100, 26, 130, 30), rect(100, 14, 104, 26)];
    const yard = new WalkGrid({
      ...town,
      water: [],
      buildings: [...town.buildings, ...walls.map((ring): Building => house(ring))],
      tanks: [...town.tanks, { height: 6, ring: rect(126, 14, 130, 26) }],
    });
    expect(yard.walkable(115, 20)).toBe(true); // open ground, once you're there
    expect(yard.street(yard.cellAt(115, 20))).toBe(false);
    expect(yard.street(yard.cellAt(115, 45))).toBe(true);
    expect(yard.nearest(115, 20, 3)).toEqual([115.5, 20.5]);
    // Picking a start in the yard finds the street south of the houses instead.
    expect(yard.nearest(115, 20, 30, true)).toEqual([115.5, 40.5]);
    expect(pickWalkable(yard, [115, 300, 20], [0, -1, 0], 30, true)).toEqual([115.5, 40.5]);
    expect(yard.nearest(115, 20, 5, true)).toBeNull();
  });

  test('a bridge deck crosses the water, and its parapets keep you on it', () => {
    const river = Float32Array.of(0, 60, 200, 60, 200, 80, 0, 80);
    const deck = Float32Array.of(100, 58, 106, 58, 106, 82, 100, 82);
    const bridged = new WalkGrid({
      ...town,
      water: [river],
      bridges: [deck],
      parapets: [Float32Array.of(100, 60, 100, 80), Float32Array.of(106, 60, 106, 80)],
    });
    expect(bridged.walkable(130, 70)).toBe(false); // the river
    expect(bridged.walkable(103, 70)).toBe(true); // the deck
    expect(bridged.walkable(103, 50)).toBe(true); // the bank
    expect(bridged.walkable(100.2, 70)).toBe(false); // the parapet
    expect(bridged.buildingHeight(100.2, 70)).toBe(2);
    // A body on the deck keeps clear of the parapet like a wall.
    expect(bridged.walkable(103, 70, 0.5)).toBe(true);
    expect(bridged.walkable(101.3, 70, 0.6, -1, 0)).toBe(false);
  });

  test('a building closes the road under it and keeps its height', () => {
    expect(grid.walkable(50, 42)).toBe(false);
    expect(grid.buildingHeight(50, 42)).toBe(16);
    expect(grid.walkable(50, 47)).toBe(true);
    expect(grid.buildingHeight(50, 47)).toBe(0);
  });

  test('a tank closes the square under it like a building', () => {
    expect(grid.walkable(65, 74)).toBe(false);
    expect(grid.buildingHeight(65, 74)).toBe(8);
    expect(grid.walkable(65, 68)).toBe(true);
  });

  test('clearance keeps a body off walls but not off the edge of a path', () => {
    expect(grid.walkable(50, 45.2)).toBe(true);
    expect(grid.walkable(50, 45.2, 0.5)).toBe(false);
    expect(grid.walkable(50, 46.5, 0.5)).toBe(true);
    expect(grid.walkable(20.6, 25, 0.5)).toBe(true);
    expect(grid.walkable(30, 25, 0.5)).toBe(false);
  });

  test('given a move, only the sides it moves toward need room', () => {
    // The cell centre at the house's west wall, as `nearest` hands out.
    expect(grid.walkable(39.5, 42.5, 0.5)).toBe(false);
    expect(grid.walkable(39.5, 42.5, 0.5, 0, 0.1)).toBe(true); // along the wall
    expect(grid.walkable(39.5, 42.5, 0.5, -0.1, 0)).toBe(true); // away from it
    expect(grid.walkable(39.5, 42.5, 0.5, 0.1, 0)).toBe(false); // into it
    expect(grid.walkable(50.5, 45.4, 0.5, 0, -0.1)).toBe(false); // up to the house's front
  });

  test('nothing off the map is walkable, even where a path spills past its edge', () => {
    const spill = new WalkGrid({ ...town, area: [{ minX: 0, minZ: 0, maxX: 100, maxZ: 120 }] });
    expect(spill.walkable(99.5, 45)).toBe(true);
    expect(spill.walkable(100.5, 45)).toBe(false);
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

  test('from street level, a house behind the eye is not in the way', () => {
    // Standing east of the house, looking east along the street.
    const [x, z] = pickWalkable(grid, [65, 2, 42], [1, -0.1, 0], 2)!;
    expect(x).toBeCloseTo(85.5);
    expect(z).toBeCloseTo(42.5);
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
