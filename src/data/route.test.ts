import { describe, expect, test } from 'bun:test';

import { normalizeRing } from './geometry.ts';
import { RingIndex } from './props.ts';
import { LEG, ROUTE_REACH, Router, TAP_REACH, clearLine, legsToward, routeStart } from './route.ts';
import type { RouteGrid } from './route.ts';
import { bridgeParapets } from './structures.ts';
import { landform, FLAT_GRID } from './terrain.ts';
import { deckStrip } from './structures.ts';
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

  test('goes round a bike left in the street, unless it stands at an end', () => {
    // The straight street from 12 to 31 along z = 47.3, with a bike across its middle.
    const bike = [21.5, 47.5, 0.55];
    const route = router.route(12.2, 47.3, 30.8, 47.3, bike)!;
    expect(route.length).toBeGreaterThan(4);
    const passes = (x: number, z: number) => Math.hypot(x - bike[0]!, z - bike[1]!);
    for (let i = 0; i + 3 < route.length; i += 2) {
      for (let t = 0; t <= 1; t += 0.05) {
        const [x, z] = [
          route[i]! + (route[i + 2]! - route[i]!) * t,
          route[i + 1]! + (route[i + 3]! - route[i + 1]!) * t,
        ];
        expect(passes(x, z)).toBeGreaterThan(0.55);
      }
    }
    // Walking up to it, or away from it, still works.
    expect(router.route(12.2, 47.3, 21.5, 47.5, bike)).not.toBeNull();
    expect(router.route(21.5, 47.5, 30.8, 47.3, bike)).not.toBeNull();
    expect(clearLine(grid, 12.2, 47.3, 30.8, 47.3)).toBe(true);
  });

  test('a start and goal in one cell is a single step', () => {
    expect(Array.from(router.route(15.1, 45.1, 15.6, 45.6)!)).toHaveLength(4);
  });

  test('reaches as far as a tap goes, and no further', () => {
    const long = new WalkGrid({
      area: [{ minX: 0, minZ: 0, maxX: 1000, maxZ: 20 }],
      bounds: { minX: 0, minZ: 0, maxX: 1000, maxZ: 20 },
      roads: [Float32Array.of(0, 5, 1000, 5, 1000, 15, 0, 15)],
      plazas: [],
      paths: [],
      buildings: [],
      tanks: [],
    });
    const far = new Router(long);
    const furthest = 100 + ROUTE_REACH + TAP_REACH;
    expect(far.route(100, 10, furthest, 10)).not.toBeNull();
    expect(far.route(100, 10, 900, 10)).toBeNull();
  });
});

test('searches a wide open square to its edges before giving up', () => {
  const square = new WalkGrid({
    area: [{ minX: 0, minZ: 0, maxX: 400, maxZ: 400 }],
    bounds: { minX: 0, minZ: 0, maxX: 400, maxZ: 400 },
    // Two squares in a lake: the far one can't be reached.
    water: [Float32Array.of(0, 0, 400, 0, 400, 400, 0, 400)],
    roads: [],
    plazas: [
      Float32Array.of(0, 0, 300, 0, 300, 300, 0, 300),
      Float32Array.of(390, 390, 399, 390, 399, 399, 390, 399),
    ],
    paths: [],
    buildings: [],
    tanks: [],
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
    tanks: [],
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

describe('legsToward', () => {
  test('within a leg, the spot itself and nothing else', () => {
    expect(legsToward(0, 0, 100, 50)).toEqual([[100, 50, true]]);
    expect(legsToward(10, 10, 10 + LEG, 10)).toEqual([[10 + LEG, 10, true]]);
  });

  test('past a leg: toward it first, each try a leg or less from where it starts', () => {
    const legs = legsToward(10, 20, 1010, 20);
    const [x, z, last] = legs[0]!;
    expect(x).toBeCloseTo(10 + LEG);
    expect(z).toBeCloseTo(20);
    expect(last).toBe(false);
    for (const [lx, lz, end] of legs) {
      expect(Math.hypot(lx - 10, lz - 20)).toBeLessThanOrEqual(LEG + 1e-6);
      expect(end).toBe(false);
    }
  });

  test('within one route’s reach, the whole way first, and legs if it isn’t found', () => {
    const legs = legsToward(0, 0, ROUTE_REACH, 0);
    expect(legs[0]).toEqual([ROUTE_REACH, 0, true]);
    expect(legs[1]![2]).toBe(false);
    expect(legsToward(0, 0, ROUTE_REACH + 1, 0)[0]![2]).toBe(false);
  });

  test('tries to either side, for when the way straight on is over the river', () => {
    const legs = legsToward(0, 0, 0, 1000);
    expect(legs.some(([x]) => x > 50)).toBe(true);
    expect(legs.some(([x]) => x < -50)).toBe(true);
  });
});

function lengthOf(route: Float32Array): number {
  let length = 0;
  for (let i = 2; i < route.length; i += 2) {
    length += Math.hypot(route[i]! - route[i - 2]!, route[i + 1]! - route[i - 1]!);
  }
  return length;
}

describe('a footbridge at any angle', () => {
  const WIDTH = 1.5;
  const SPAN = 16;
  /** A deck `SPAN` long and `WIDTH` wide over a river, turned `degrees` about the middle. */
  function bridge(degrees: number, over: Float32Array[] = []) {
    const t = (degrees * Math.PI) / 180;
    const [ux, uz, vx, vz] = [Math.cos(t), Math.sin(t), -Math.sin(t), Math.cos(t)];
    const at = (u: number, v: number) => [100 + u * ux + v * vx, 100 + u * uz + v * vz] as const;
    const [hu, hv] = [SPAN / 2, WIDTH / 2];
    const deck = Float32Array.from(
      normalizeRing([...at(-hu, -hv), ...at(hu, -hv), ...at(hu, hv), ...at(-hu, hv)]),
    );
    const river = Float32Array.from(
      normalizeRing([...at(-6, -60), ...at(6, -60), ...at(6, 60), ...at(-6, 60)]),
    );
    const water = new RingIndex();
    water.add(river);
    const grid = new WalkGrid({
      area: [{ minX: 0, minZ: 0, maxX: 200, maxZ: 200 }],
      bounds: { minX: 0, minZ: 0, maxX: 200, maxZ: 200 },
      roads: over,
      plazas: [],
      paths: [],
      buildings: [],
      tanks: [],
      water: [river],
      bridges: [deck],
      parapets: bridgeParapets(deck, water).map((line) => Float32Array.from(line)),
    });
    return { grid, router: new Router(grid), at };
  }
  const angles = Array.from({ length: 13 }, (_, i) => i * 15);

  test('a deck a body fits on is walked across, however it lies on the grid', () => {
    for (const angle of angles) {
      const { router, at } = bridge(angle);
      const [a, b] = [at(-10, 0), at(10, 0)];
      // Over the deck, not round the river's far end.
      expect(lengthOf(router.route(a[0], a[1], b[0], b[1])!)).toBeLessThan(26);
    }
  });

  test('where a road runs under it, the way off the deck is still its end', () => {
    const slab = Float32Array.of(0, 0, 200, 0, 200, 200, 0, 200);
    for (const angle of angles) {
      const { grid, router, at } = bridge(angle, [slab]);
      const [a, b] = [grid.nearest(...at(0, 0), 2)!, grid.nearest(...at(0, 4), 2)!];
      expect(lengthOf(router.route(a[0], a[1], b[0], b[1])!)).toBeGreaterThan(SPAN / 2);
    }
  });
});

describe('over a deck', () => {
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
    // All water but the road under the deck, which runs between two shores.
    water: [
      Float32Array.of(0, 0, 60, 0, 60, 120, 0, 120),
      Float32Array.of(70, 0, 200, 0, 200, 120, 70, 120),
    ],
    roads: [Float32Array.of(60, 0, 70, 0, 70, 120, 60, 120)],
    plazas: [],
    paths: [],
    buildings: [],
    tanks: [],
    decks: [deck],
    ramps,
  };
  const terrain = landform(FLAT_GRID, ramps, [deckStrip(deck)]);
  const grid = new WalkGrid(layers, undefined, terrain);
  const router = new Router(grid);

  test('a walk from one ramp to the other goes over it', () => {
    const route = router.route(30, 45, 100, 45)!;
    expect(route).not.toBeNull();
    expect(lengthOf(route)).toBeLessThan(90);
  });

  test('a walk along the road under it stays on the ground', () => {
    const route = router.route(65, 5, 65, 115)!;
    expect(route).not.toBeNull();
    expect(lengthOf(route)).toBeCloseTo(110, 0);
  });

  test('a walk can end on the deck', () => {
    expect(router.route(30, 45, 65, 45, [], 0, 1)).not.toBeNull();
  });

  test('a walk from under the deck to its top goes round by a ramp', () => {
    const route = router.route(65, 5, 65, 45, [], 0, 1);
    expect(route === null || lengthOf(route) > 40).toBe(true);
  });

  test('a change of level within one cell keeps both ends', () => {
    const route = router.route(50.5, 45, 50.6, 45.1, [], 0, 1)!;
    expect(Array.from(route)).toEqual([
      Math.fround(50.5),
      45,
      Math.fround(50.6),
      Math.fround(45.1),
    ]);
  });

  test('a route ends where it was asked to, after its last change of level', () => {
    const route = router.route(30, 45, 50.6, 45.1, [], 0, 1)!;
    expect(route.at(-2)).toBeCloseTo(50.6, 3);
    expect(route.at(-1)).toBeCloseTo(45.1, 3);
  });

  test('a walk on the ground does not cross under the deck past a ramp', () => {
    const route = router.route(30, 45, 54, 45);
    expect(route).toBeNull();
  });

  test('refuses an end on the deck off it', () => {
    expect(router.route(30, 45, 30, 90, [], 0, 1)).toBeNull();
  });
});

/** A field of 1 m cells, open but for what `closed` says. */
function field(cols: number, rows: number, closed: (c: number, r: number) => boolean): RouteGrid {
  const isOpen = (c: number, r: number) =>
    c >= 0 && r >= 0 && c < cols && r < rows && !closed(c, r);
  return {
    cols,
    rows,
    cellAt: (x, z) => Math.floor(z) * cols + Math.floor(x),
    centre: (cell) => [(cell % cols) + 0.5, Math.floor(cell / cols) + 0.5],
    open: (cell) => isOpen(cell % cols, Math.floor(cell / cols)),
    walkable: (x, z) => isOpen(Math.floor(x), Math.floor(z)),
    nearest: () => null,
    around: () => [],
  };
}

const walked = (route: Float32Array) => {
  let total = 0;
  for (let i = 0; i + 3 < route.length; i += 2) {
    total += Math.hypot(route[i + 2]! - route[i]!, route[i + 3]! - route[i + 1]!);
  }
  return total;
};

const post = (c: number, r: number) => Math.hypot(c + 0.5 - 40, r + 0.5 - 25.5) < 1.6;
const longWall = (c: number, r: number) => r >= 28 && r <= 32 && c <= 100 && (c < 39 || c > 41);
const gappedWall = (c: number, r: number) => r === 30 && c !== 60 && c !== 61 && c !== 62;

describe('a route only turns where something is in the way', () => {
  test('with the straight line clear, it is the straight line, at any angle', () => {
    const router = new Router(field(120, 60, () => false));
    for (const [tx, tz] of [
      [100.3, 17.2],
      [61.7, 50.1],
      [13.2, 44.9],
      [90.9, 6.4],
    ] as const) {
      const route = router.route(5.5, 5.5, tx, tz)!;
      expect(route).toHaveLength(4);
      expect(route[2]).toBeCloseTo(tx);
      expect(route[3]).toBeCloseTo(tz);
    }
  });

  test('round a post it bends once, beside the post, and hardly further', () => {
    const router = new Router(field(90, 60, post));
    const route = router.route(5.5, 20.5, 75.5, 30.5)!;
    expect(route.length).toBeLessThanOrEqual(8);
    expect(walked(route)).toBeLessThan(Math.hypot(70, 10) + 1);
    for (let i = 2; i + 2 < route.length; i += 2) {
      expect(Math.hypot(route[i]! - 40, route[i + 1]! - 25.5)).toBeLessThan(6);
    }
  });

  test('a clear line through a bike left in the way is no longer clear', () => {
    const router = new Router(field(90, 60, () => false));
    const route = router.route(5.5, 30.5, 80.5, 30.5, [43, 30.5, 2.5])!;
    expect(route.length).toBeGreaterThan(4);
    for (let i = 0; i + 1 < route.length; i += 2) {
      expect(Math.hypot(route[i]! - 43, route[i + 1]! - 30.5)).toBeGreaterThan(2.4);
    }
  });

  test('it takes the shorter gap in a wall, not the wide one a long way round', () => {
    // A long wall, a gap three cells wide near the straight line, and open ground past its end.
    const router = new Router(field(130, 70, longWall));
    const route = router.route(28.5, 12.5, 50.5, 55.5)!;
    expect(walked(route)).toBeLessThan(60);
  });

  test('over a wall that closes off the straight line, the gap is where it turns', () => {
    const router = new Router(field(90, 60, gappedWall));
    const route = router.route(30.5, 10.5, 30.5, 50.5)!;
    expect(route.length).toBeLessThanOrEqual(10);
    for (let i = 2; i + 2 < route.length; i += 2) {
      if (Math.abs(route[i + 1]! - 30.5) < 3) expect(Math.abs(route[i]! - 61.5)).toBeLessThan(4);
    }
  });
});

/** A field shut by rectangles [c, r, width, height]. */
const blocks = (cols: number, rows: number, rects: readonly (readonly number[])[]) =>
  field(cols, rows, (c, r) =>
    rects.some(([a, b, w, h]) => c >= a! && c < a! + w! && r >= b! && r < b! + h!),
  );

describe('the way found is as good as it looks', () => {
  test('a cell found dearer than assumed waits its turn, so a shorter way can still win', () => {
    const rects = [
      [25, 40, 13, 11],
      [10, 19, 19, 19],
      [36, 28, 31, 19],
      [55, 6, 10, 16],
      [37, 32, 27, 15],
    ];
    const route = new Router(blocks(80, 50, rects)).route(10.5, 40.5, 8.5, 33.5)!;
    expect(walked(route)).toBeLessThan(7.9);
  });

  test("from each corner it goes as far as it can see, not to the first it can't", () => {
    const rects = [
      [50, 3, 18, 10],
      [50, 38, 9, 10],
      [56, 21, 19, 19],
      [65, 5, 32, 12],
      [36, 12, 5, 6],
      [18, 19, 18, 2],
      [32, 32, 13, 2],
    ];
    const route = new Router(blocks(80, 50, rects)).route(30.5, 14.5, 44.5, 37.5)!;
    expect(route.length / 2).toBe(4);
  });
});

const walledIn = (c: number, r: number) =>
  (c === 40 || c === 50 || r === 20 || r === 30) && c >= 40 && c <= 50 && r >= 20 && r <= 30;
const sideWall = (c: number, r: number) => c === 20 && r >= 5 && r < 35;

describe('when there is no way', () => {
  test('a spot walled in is told without searching everywhere else', () => {
    const router = new Router(field(300, 300, walledIn));
    expect(router.route(5.5, 5.5, 45.5, 25.5)).toBeNull();
    // And from inside the same pocket, the way across it is found as usual.
    expect(router.route(42.5, 22.5, 47.5, 27.5)).not.toBeNull();
    // The router is left as it was found: a route outside still goes.
    expect(router.route(5.5, 5.5, 200.5, 200.5)).not.toBeNull();
  });
});

describe('a route starting right beside a wall', () => {
  test('stays off it, however close to the edge of its cell it starts', () => {
    const grid = field(60, 40, sideWall);
    const router = new Router(grid);
    for (const offset of [0.02, 0.5, 0.98]) {
      for (const z of [8.02, 8.98, 20.5, 33.98]) {
        const route = router.route(19 + offset, z, 25.5, z + 1)!;
        for (let i = 0; i + 3 < route.length; i += 2) {
          const [ax, az, bx, bz] = [route[i]!, route[i + 1]!, route[i + 2]!, route[i + 3]!];
          for (let t = 0; t <= 200; t++) {
            expect(grid.walkable(ax + ((bx - ax) * t) / 200, az + ((bz - az) * t) / 200)).toBe(
              true,
            );
          }
        }
      }
    }
  });
});

describe('routeStart', () => {
  const route = Float32Array.of(0, 0, 30, 0, 30, 30);

  test('cuts a route by distance along it, on its own line', () => {
    expect(Array.from(routeStart(route, 0.25))).toEqual([0, 0, 15, 0]);
    expect(Array.from(routeStart(route, 0.75))).toEqual([0, 0, 30, 0, 30, 15]);
  });

  test('cut exactly at a corner, it ends there', () => {
    expect(Array.from(routeStart(route, 0.5))).toEqual([0, 0, 30, 0]);
  });

  test('all of it is all of it', () => {
    expect(Array.from(routeStart(route, 1))).toEqual(Array.from(route));
  });
});
