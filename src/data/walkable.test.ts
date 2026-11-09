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
import { landform, FLAT_GRID } from './terrain.ts';
import { deckStrip } from './structures.ts';
import { WalkGrid } from './walkable.ts';

describe('WalkGrid', () => {
  const grid = new WalkGrid(town);

  test('beside a building: the open cells along its walls, on every side, within reach', () => {
    // The house (x 40 to 60, z 38 to 45) stands in the road, its back in the water.
    const beside = grid.besideBuilding(50, 41, 40);
    expect(beside).toContainEqual([39.5, 42.5]); // west
    expect(beside).toContainEqual([60.5, 42.5]); // east
    expect(beside).toContainEqual([50.5, 45.5]); // south, in the road
    expect(beside.every(([x, z]) => grid.walkable(x, z))).toBe(true);
    expect(beside.some(([, z]) => z < 38)).toBe(false); // the water behind
    // Only those within reach of the spot.
    expect(grid.besideBuilding(42, 41, 4).every(([x]) => x < 47)).toBe(true);
    expect(grid.besideBuilding(15, 45, 40)).toEqual([]); // not a building
    // A few metres out, past a café's tables: the whole road in front, not only its kerb.
    expect(beside).toContainEqual([50.5, 49.5]);
    expect(grid.besideBuilding(50, 41, 40, 1)).not.toContainEqual([50.5, 49.5]);
    expect(grid.besideBuilding(50, 41, 40, 1)).toContainEqual([50.5, 45.5]);
  });

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
    expect(yard.nearest(115, 20, 5, true)).toBeNull();
  });

  test('a bridge deck crosses the water, and its parapets keep you on it', () => {
    const river = Float32Array.of(0, 60, 200, 60, 200, 80, 0, 80);
    const deck = Float32Array.of(100, 58, 106, 58, 106, 82, 100, 82);
    const bridged = new WalkGrid({
      ...town,
      water: [river],
      bridges: [deck],
      // Each with the water on its right, as `bridgeParapets` draws them.
      parapets: [Float32Array.of(100, 80, 100, 60), Float32Array.of(106, 60, 106, 80)],
    });
    expect(bridged.walkable(130, 70)).toBe(false); // the river
    expect(bridged.walkable(103, 70)).toBe(true); // the deck
    expect(bridged.walkable(103, 50)).toBe(true); // the bank
    expect(bridged.walkable(99.7, 70)).toBe(false); // past the parapet
    expect(bridged.buildingHeight(99.7, 70)).toBe(2);
    expect(bridged.walkable(100.5, 70)).toBe(true); // the deck right up to it
    // A body on the deck keeps clear of the parapet, as thick as it's drawn, like a wall.
    const out: [number, number] = [0, 0];
    expect(bridged.wallOverlap(103, 70, 0.45, out)).toBe(0);
    expect(bridged.wallOverlap(100.5, 70, 0.45, out)).toBeCloseTo(0.2);
    expect(out[0]).toBeCloseTo(1);
    expect(bridged.closed(130, 70)).toBe(1);
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

  test('trunks, benches and posts stand in the way, as drawn, at no height', () => {
    const solids = {
      // A trunk on a cell centre, a lamp post on another, a trunk against the house's front.
      posts: [100.5, 45.5, 0.35, 120.5, 45.5, 0.16, 50.5, 45.2, 0.35],
      rings: [rect(140, 44, 141.8, 45)], // a bench
    };
    const street = new WalkGrid(town, solids);
    expect(street.walkable(100.5, 45.5)).toBe(false);
    expect(street.walkable(101.5, 45.5)).toBe(true);
    expect(street.buildingHeight(100.5, 45.5)).toBe(0);
    // A lamp post is thinner than the walker: it keeps its cell, so a route can pass it.
    expect(street.walkable(120.5, 45.5)).toBe(true);
    expect(street.walkable(140.5, 44.5)).toBe(false);
    expect(street.walkable(140.5, 46.5)).toBe(true);
    // The house keeps its height where the trunk beside it reaches into its cells.
    expect(street.buildingHeight(50.5, 44.5)).toBe(16);
    expect(street.walkable(50.5, 45.5)).toBe(false);
    const out: [number, number] = [0, 0];
    expect(street.wallOverlap(100.5, 46.3, 0.45, out)).toBe(0);
    expect(street.wallOverlap(100.5, 46.2, 0.45, out)).toBeCloseTo(0.1);
    expect(out[1]).toBeCloseTo(1);
    expect(street.wallOverlap(120.5, 45, 0.45, out)).toBeCloseTo(0.16 + 0.45 - 0.5);
    expect(street.wallOverlap(141, 45.3, 0.45, out)).toBeCloseTo(0.15);
    // Beside a lamp post, half a pavement of 1.5 m leaves the body room.
    expect(street.wallOverlap(120.5, 46.25, 0.45, out)).toBe(0);
    // Without solids, nothing is in the way.
    expect(grid.walkable(100.5, 45.5)).toBe(true);
  });

  test('a body meets walls as drawn: how far it reaches in, and the way out', () => {
    const out: [number, number] = [0, 0];
    // Half a metre from the house's west wall (x = 40), clear; nearer, in by the difference.
    expect(grid.wallOverlap(39.5, 42, 0.45, out)).toBe(0);
    expect(grid.wallOverlap(39.7, 42, 0.45, out)).toBeCloseTo(0.15);
    expect(out[0]).toBeCloseTo(-1);
    expect(out[1]).toBeCloseTo(0);
    // Off its north-west corner (40, 45), out along the diagonal: the corner is a point.
    expect(grid.wallOverlap(39.8, 45.2, 0.45, out)).toBeCloseTo(0.45 - Math.hypot(0.2, 0.2));
    expect(out[0]).toBeCloseTo(-Math.SQRT1_2);
    expect(out[1]).toBeCloseTo(Math.SQRT1_2);
    // Inside, out through the nearest face, the front at z = 45.
    expect(grid.wallOverlap(50, 44.5, 0.45, out)).toBeCloseTo(0.95);
    expect(out[1]).toBeCloseTo(1);
    // The tank too; the edge of the water is no wall.
    expect(grid.wallOverlap(65, 69.8, 0.45, out)).toBeCloseTo(0.25);
    expect(grid.wallOverlap(30, 25, 0.45, out)).toBe(0);
  });

  test('in a lane between two houses, both walls push, and balance in the middle', () => {
    const lane = new WalkGrid({
      ...town,
      buildings: [house(rect(40, 30, 60, 45)), house(rect(40, 46, 60, 60))],
    });
    const out: [number, number] = [0, 0];
    expect(lane.wallOverlap(50, 45.5, 0.45, out)).toBe(0);
    expect(lane.wallOverlap(50, 45.5, 0.6, out)).toBe(0); // squeezed equally
    expect(lane.wallOverlap(50, 45.3, 0.45, out)).toBeCloseTo(0.15);
    expect(out[1]).toBeCloseTo(1);
  });

  test('the edge of closed ground blends between cell centres, as a nearly straight line', () => {
    expect(grid.closed(30, 25)).toBe(1);
    expect(grid.closed(15, 45)).toBe(0);
    expect(grid.closed(20, 25)).toBe(0); // the path across the lake
    expect(grid.closed(50, 42)).toBe(0); // a house is no water: it is met as a wall
    expect(grid.closed(-5, 45)).toBe(1); // off the map
    // The road's edge at z = 40: half way between the cell centres either side.
    expect(grid.closed(100, 40)).toBeCloseTo(0.5);
    expect(grid.closed(100, 39.75)).toBeCloseTo(0.75);
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

  test('around offers open places round a spot, nearest first', () => {
    const places = grid.around(50, 42, 8, 4);
    expect(places.length).toBe(4);
    for (const [x, z] of places) expect(grid.walkable(x, z)).toBe(true);
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

describe('levels', () => {
  const deck = {
    carries: 'road' as const,
    ring: Float32Array.of(50, 40, 80, 40, 80, 50, 50, 50),
    axis: Float32Array.of(48.5, 45, 81.5, 45),
    rise: Float32Array.of(5, 5),
    piers: new Float32Array(0),
    lanes: [],
  };
  const ramps = [
    {
      line: Float32Array.of(51.5, 45, 50, 45, 10, 45),
      rise: Float32Array.of(5, 5, 0),
      half: 5,
      rail: false,
    },
    {
      line: Float32Array.of(78.5, 45, 80, 45, 120, 45),
      rise: Float32Array.of(5, 5, 0),
      half: 5,
      rail: false,
    },
  ];
  const layers = {
    area: [{ minX: 0, minZ: 0, maxX: 200, maxZ: 120 }],
    bounds: { minX: 0, minZ: 0, maxX: 200, maxZ: 120 },
    roads: [Float32Array.of(60, 0, 70, 0, 70, 120, 60, 120)],
    plazas: [],
    paths: [],
    buildings: [],
    tanks: [],
    decks: [deck],
    ramps,
    tunnels: [
      {
        carries: 'path' as const,
        line: Float32Array.of(100, 80, 140, 80),
        half: 1.5,
        depth: 3.4,
        mouths: [true, true] as [boolean, boolean],
      },
    ],
  };
  const terrain = landform(layers.area.length ? FLAT_GRID : FLAT_GRID, ramps, [deckStrip(deck)]);
  const grid = new WalkGrid(layers, undefined, terrain);

  test('a road the survey drew over a bridge is no path over the river under it', () => {
    const wet = new WalkGrid(
      { ...layers, water: [Float32Array.of(55, 30, 75, 30, 75, 60, 55, 60)] },
      undefined,
      terrain,
    );
    // Over the river, under the deck, the road across it: shut down here, open up there.
    expect(wet.open(wet.cellAt(65, 45))).toBe(false);
    expect(wet.upper!.open(wet.upper!.cellAt(65, 45))).toBe(true);
    // Beside the deck the road crosses the river at the ground, as drawn.
    expect(wet.open(wet.cellAt(65, 55))).toBe(true);
    // Under the deck on dry land it's still a street.
    expect(wet.open(wet.cellAt(53.5, 45))).toBe(true);
  });

  test('a deck is a level of its own over the ground under it', () => {
    expect(grid.upper).not.toBeNull();
    const cell = grid.cellAt(65, 45);
    expect(grid.onUpper(cell)).toBe(true);
    expect(grid.open(cell)).toBe(true);
    expect(grid.upperHeight(65, 45)).toBeCloseTo(5.13, 2);
  });

  test('the two meet only where the ramp reaches the deck', () => {
    expect(grid.link(grid.cellAt(65, 45))).toBe(false);
    expect(grid.link(grid.cellAt(50.6, 45))).toBe(true);
  });

  test('a walker moves between them only where they meet', () => {
    expect(grid.levelAt(0, 65, 45)).toBe(0);
    expect(grid.levelAt(0, 50.6, 45)).toBe(1);
    expect(grid.levelAt(1, 65, 45)).toBe(1);
    expect(grid.levelAt(1, 30, 45)).toBe(0);
  });

  test('a tunnel is on that level too, under the ground', () => {
    expect(grid.upperHeight(120, 80)).toBeCloseTo(-3.4, 5);
    expect(grid.upper!.walkable(120, 80)).toBe(true);
    expect(grid.upperHeight(120, 90)).toBeNaN();
  });

  test('a body on the deck is held by its railings', () => {
    const out: [number, number] = [0, 0];
    expect(grid.upper!.wallOverlap(65, 40.2, 0.45, out)).toBeGreaterThan(0);
    expect(out[1]).toBeGreaterThan(0);
    expect(grid.upper!.wallOverlap(65, 45, 0.45, out)).toBe(0);
  });

  test('the upper level answers as a grid does', () => {
    const upper = grid.upper!;
    expect(upper.cols).toBe(grid.cols);
    expect(upper.rows).toBe(grid.rows);
    const cell = upper.cellAt(65, 45);
    expect(upper.centre(cell)).toEqual([65.5, 45.5]);
    expect(upper.open(cell)).toBe(true);
    expect(upper.nearest(65, 49.9, 4)).toEqual([65.5, 49.5]);
    expect(upper.around(65, 45, 3, 2).length).toBe(2);
    expect(upper.closed(65, 45)).toBe(0);
  });

  test('a walker can step off a deck at its end, but not over its railing', () => {
    expect(grid.upper!.closed(49.4, 45)).toBeLessThan(0.5);
    expect(grid.levelAt(1, 49.4, 45)).toBe(0);
    expect(grid.upper!.closed(65, 38)).toBeGreaterThan(0.5);
  });

  test('a tunnel can be stepped out of at its mouth', () => {
    expect(grid.upper!.closed(97.6, 80)).toBeLessThan(0.5);
    expect(grid.levelAt(1, 97.6, 80)).toBe(0);
  });

  test('a ramp that starts high is closed across its tip, under the deck', () => {
    const out: [number, number] = [0, 0];
    expect(grid.wallOverlap(51.7, 45, 0.45, out)).toBeGreaterThan(0);
    expect(grid.walkable(52.5, 45)).toBe(false);
  });

  test('a road under the deck stays open on the ground', () => {
    expect(grid.walkable(65, 45)).toBe(true);
    expect(grid.walkable(65, 80)).toBe(true);
  });

  test('a map with no decks or tunnels has no upper level', () => {
    expect(new WalkGrid({ ...layers, decks: [], tunnels: [] }).upper).toBeNull();
  });
});
