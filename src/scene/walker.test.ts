import { describe, expect, test } from 'bun:test';

import type { Building } from '../data/city.ts';
import { WalkGrid } from '../data/walkable.ts';
import { clock, ticks } from './motion.ts';
import {
  IDLE_SECONDS,
  RUN_SPEED,
  STEP,
  WALK_SPEED,
  createWalker,
  followRoute,
  runBlend,
  stepWalker,
} from './walker.ts';
import type { Ground } from './walker.ts';

/** Ground walled by half-planes, each a point on its face and the way out of it (x, z). */
function planes(...faces: [number, number, number, number][]): Ground {
  return {
    wallOverlap(x, z, radius, out) {
      let [sx, sz, deep] = [0, 0, 0];
      for (const [px, pz, nx, nz] of faces) {
        const into = radius - ((x - px) * nx + (z - pz) * nz);
        if (into > 0) [sx, sz, deep] = [sx + nx * into, sz + nz * into, Math.max(deep, into)];
      }
      const length = Math.hypot(sx, sz);
      if (length > 0) [out[0], out[1]] = [sx / length, sz / length];
      return length > 0 ? deep : 0;
    },
    closed: () => 0,
  };
}
const open = planes();

/** Steps at 60 fps until it settles or `seconds` pass; returns the frames it took. */
function run(
  w: ReturnType<typeof createWalker>,
  seconds: number,
  steer: [number, number] = [0, 0],
  ground: Ground = open,
  running = false,
): number {
  for (let frame = 1; frame <= seconds * 60; frame++) {
    if (!stepWalker(w, 1 / 60, steer[0], steer[1], ground, running)) return frame;
  }
  return Infinity;
}

describe('steering', () => {
  test('eases up to walking pace in the direction it faces', () => {
    const w = createWalker(0, 0, Math.PI / 2);
    stepWalker(w, 1 / 60, 1, 0, open);
    expect(w.speed).toBeGreaterThan(0);
    expect(w.speed).toBeLessThan(WALK_SPEED);
    run(w, 1, [1, 0]);
    expect(w.speed).toBeCloseTo(WALK_SPEED);
    expect(w.x).toBeGreaterThan(1.8);
    expect(w.z).toBeCloseTo(0);
    expect(w.phase).toBeGreaterThan(0);
  });

  test('turns on the spot to face a direction behind it, then sets off in an arc', () => {
    const w = createWalker(0, 0);
    stepWalker(w, 1 / 60, 0, -1, open);
    expect(w.speed).toBe(0);
    expect(w.turning).not.toBe(0);
    run(w, 1.5, [0, -1]);
    expect(Math.abs(w.heading)).toBeCloseTo(Math.PI, 2);
    expect(w.z).toBeLessThan(-1.5);
    expect(Math.abs(w.x)).toBeLessThan(0.5);
  });

  test('runs faster than it walks, with a longer stride', () => {
    const walker = createWalker(0, 0);
    const runner = createWalker(0, 0);
    run(walker, 2, [0, 1]);
    run(runner, 2, [0, 1], open, true);
    expect(runner.speed).toBeCloseTo(RUN_SPEED);
    expect(runner.z).toBeGreaterThan(walker.z * 2);
    expect(runBlend(runner.speed)).toBeCloseTo(1);
    expect(runBlend(walker.speed)).toBe(0);
    // Steps per metre: fewer at a run.
    const [a, b] = [createWalker(0, 0), createWalker(0, 0)];
    Object.assign(a, { speed: WALK_SPEED });
    Object.assign(b, { speed: RUN_SPEED });
    stepWalker(a, 0.1, 0, 1, open);
    stepWalker(b, 0.1, 0, 1, open, true);
    expect(b.phase / b.z).toBeLessThan(a.phase / a.z);
  });

  test('a curve at a run turns slower and keeps a turn rate to lean into', () => {
    const w = createWalker(0, 0);
    run(w, 2, [0, 1], open, true);
    stepWalker(w, 1 / 60, 1, 1, open, true);
    for (let i = 0; i < 10; i++) stepWalker(w, 1 / 60, 1, 1, open, true);
    expect(w.turning).toBeGreaterThan(0.5);
    expect(w.heading).toBeLessThan(Math.PI / 4);
    expect(w.speed).toBeGreaterThan(WALK_SPEED);
  });

  test('turns without a snap: the turn rate builds over a few steps, then eases off', () => {
    const w = createWalker(0, 0);
    const rates: number[] = [];
    for (let i = 0; i < 60; i++) {
      stepWalker(w, STEP, 1, 0, open);
      rates.push(w.turning);
    }
    const peak = Math.max(...rates);
    expect(rates[0]).toBeLessThan(peak * 0.4);
    for (let i = 1; i < rates.length; i++) {
      expect(Math.abs(rates[i]! - rates[i - 1]!)).toBeLessThan(peak * 0.4);
    }
    expect(w.heading).toBeCloseTo(Math.PI / 2, 2);
  });

  test('walks the same path at any frame rate, stepped at the fixed rate', () => {
    const ends = [30, 60, 144].map((hz) => {
      const w = createWalker(0, 0);
      const c = clock(STEP);
      for (const [seconds, x, z] of [
        [1, 0, 1],
        [1.5, 1, 0],
        [1, 0, 0],
      ] as const) {
        for (let frame = 0; frame < seconds * hz; frame++) {
          for (let n = ticks(c, 1 / hz); n > 0; n--) stepWalker(w, STEP, x, z, open);
        }
      }
      return [w.x, w.z];
    });
    for (const [x, z] of ends) {
      expect(x).toBeCloseTo(ends[0]![0]!, 1);
      expect(z).toBeCloseTo(ends[0]![1]!, 1);
    }
  });

  test('a half-pressed stick walks slower', () => {
    const w = createWalker(0, 0);
    run(w, 1, [0, 0.5]);
    expect(w.speed).toBeCloseTo(WALK_SPEED / 2);
  });

  test('coasts to a stop on release, idles a while, then rests', () => {
    const w = createWalker(0, 0);
    run(w, 1, [0, 1]);
    const z = w.z;
    const frames = run(w, IDLE_SECONDS + 2);
    expect(w.speed).toBe(0);
    expect(w.z).toBeGreaterThan(z);
    expect(frames / 60).toBeGreaterThan(IDLE_SECONDS);
    expect(frames / 60).toBeLessThan(IDLE_SECONDS + 1);
  });

  test('stops crisply: a run comes to a stand within a metre and a third of a second', () => {
    const w = createWalker(0, 0);
    run(w, 2, [0, 1], open, true);
    const z = w.z;
    let frames = 0;
    while (w.speed > 0) {
      stepWalker(w, 1 / 60, 0, 0, open);
      frames++;
    }
    expect(w.z - z).toBeLessThan(1);
    expect(frames / 60).toBeLessThan(0.4);
  });
});

const ramp = (v: number) => Math.min(1, Math.max(0, v));
/** A wall whose face runs along x = 10. */
const wall = planes([10, 0, -1, 0]);
/** A wall along x + z = 10. */
const slanted = planes([5, 5, -Math.SQRT1_2, -Math.SQRT1_2]);
/** Walls along x = 10 and z = 10, meeting in a corner. */
const corner = planes([10, 0, -1, 0], [0, 10, 0, -1]);
/** Water from z = 10 on: closed, but no wall. */
const quay: Ground = { wallOverlap: () => 0, closed: (_x, z) => ramp(z - 9.5) };

const house = (ring: Float32Array): Building => ({
  id: 1,
  tier: 'core',
  kind: 'house',
  roof: 'flat',
  height: 10,
  eave: 10,
  roofColor: null,
  ring,
  holes: [],
});
const rect = (x0: number, z0: number, x1: number, z1: number) =>
  Float32Array.of(x0, z0, x1, z0, x1, z1, x0, z1);
/** Open ground with houses on it, as the walk grid rasterises them into metre cells. */
function town(...rings: Float32Array[]): Ground {
  const grid = new WalkGrid({
    area: [{ minX: 0, minZ: 0, maxX: 200, maxZ: 200 }],
    bounds: { minX: 0, minZ: 0, maxX: 200, maxZ: 200 },
    roads: [],
    plazas: [],
    paths: [],
    buildings: rings.map(house),
    tanks: [],
  });
  return grid;
}

describe('walls', () => {
  test('slides along a wall it walks into at an angle, its body kept clear of it', () => {
    const w = createWalker(8, 0, Math.PI / 4);
    let closest = 0;
    for (let frame = 0; frame < 120; frame++) {
      stepWalker(w, 1 / 60, 1, 1, wall);
      closest = Math.max(closest, w.x);
    }
    expect(closest).toBeLessThan(10 - 0.45 + 0.03);
    expect(w.x).toBeGreaterThan(10 - 0.45 - 0.05);
    // Along the wall at the share of its pace that's left, the cosine of 45°.
    expect(w.z).toBeGreaterThan(3);
    expect(w.slide).toBeCloseTo(Math.SQRT1_2, 1);
    expect(w.speed).toBeCloseTo(WALK_SPEED * Math.SQRT1_2, 0);
  });

  test('stops at once at a wall it walks straight into, and stays stopped', () => {
    const w = createWalker(8, 0, Math.PI / 2);
    run(w, 2, [1, 0], wall);
    expect(w.speed).toBe(0);
    expect(w.x).toBeLessThan(10 - 0.45 + 0.03);
    expect(w.x).toBeGreaterThan(10 - 0.45 - 0.1);
    expect(Math.abs(w.z)).toBeLessThan(0.01);
  });

  test('slides along a slanted wall, the way it leans', () => {
    const w = createWalker(7, 0, Math.PI / 2);
    run(w, 2, [1, 0], slanted);
    expect((w.x + w.z - 10) / Math.SQRT2).toBeLessThan(-0.45 + 0.03);
    expect(w.z).toBeLessThan(-1);
    expect(w.slide).toBeGreaterThan(0.5);
    expect(w.slide).toBeLessThan(0.9);
  });

  test('walked into a corner, it stops there rather than jittering between the walls', () => {
    const w = createWalker(7, 7, Math.PI / 4);
    run(w, 3, [1, 1], corner);
    expect(w.x).toBeCloseTo(10 - 0.45, 1);
    expect(w.z).toBeCloseTo(10 - 0.45, 1);
    const [x, z] = [w.x, w.z];
    for (let i = 0; i < 30; i++) stepWalker(w, 1 / 60, 1, 1.2, corner);
    expect(Math.hypot(w.x - x, w.z - z)).toBeLessThan(0.02);
  });

  test('walks right up to the water: its edge is closed, but no wall', () => {
    const w = createWalker(5, 5);
    run(w, 3, [0, 1], quay);
    expect(w.z).toBeGreaterThan(10 - 0.15 - 0.05);
    expect(w.z).toBeLessThan(10);
  });

  test('a body that ends up against a wall is eased back out, never jumped', () => {
    const w = createWalker(9.9, 0);
    let last = w.x;
    for (let i = 0; i < 60; i++) {
      stepWalker(w, 1 / 60, 0, 1, wall);
      expect(last - w.x).toBeLessThan((2 / 60) * 1.01);
      last = w.x;
    }
    expect(w.x).toBeLessThan(10 - 0.45 + 0.02);
    expect(w.z).toBeGreaterThan(1);
  });

  test('glides along a slanted facade as drawn, not the staircase of its cells', () => {
    // A house turned 45°: its south-east face runs along x - z = 40.
    const ground = town(Float32Array.of(100, 60, 130, 90, 100, 120, 70, 90));
    const w = createWalker(106, 64, Math.PI / 4);
    const gaps: number[] = [];
    for (let frame = 0; frame < 300; frame++) {
      // Along the face, leaning into it.
      stepWalker(w, 1 / 60, 0.6, 1, ground);
      if (frame > 120) gaps.push((w.x - w.z - 40) / Math.SQRT2);
    }
    expect(Math.min(...gaps)).toBeGreaterThan(0.45 - 0.01);
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThan(0.05);
    expect(w.x - 106).toBeGreaterThan(5);
  });

  test('glides along a facade at any angle to the grid, walked into at any angle', () => {
    for (const degrees of [8, 20, 26.6, 37, 45, 63, 80]) {
      // A long house whose south face leaves (100, 100) at this angle.
      const a = (degrees * Math.PI) / 180;
      const [ux, uz] = [Math.cos(a), Math.sin(a)];
      const [nx, nz] = [uz, -ux]; // out of the face
      const at = (s: number, t: number) => [100 + ux * s - nx * t, 100 + uz * s - nz * t];
      const ground = town(
        Float32Array.of(...at(-30, 0), ...at(30, 0), ...at(30, 20), ...at(-30, 20)),
      );
      for (const lean of [0.3, 0.8]) {
        const w = createWalker(100 + nx * 1.5 - ux * 10, 100 + nz * 1.5 - uz * 10);
        const gaps: number[] = [];
        for (let frame = 0; frame < 240; frame++) {
          stepWalker(w, 1 / 60, ux - nx * lean, uz - nz * lean, ground);
          if (frame > 90) gaps.push((w.x - 100) * nx + (w.z - 100) * nz);
        }
        const along = (w.x - 100) * ux + (w.z - 100) * uz + 10;
        expect(along).toBeGreaterThan(6);
        // Its body clear of the facade, steadily: no catching on the cells.
        expect(Math.min(...gaps)).toBeGreaterThan(0.45 - 0.01);
        expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThan(0.05);
      }
    }
  });

  test('rounds the corner of a house rather than stopping on it', () => {
    const ground = town(rect(100, 100, 120, 110));
    // Down the house's west wall, leaning in, and on round its corner.
    const w = createWalker(97, 95);
    for (let frame = 0; frame < 480; frame++) stepWalker(w, 1 / 60, 0.3, 1, ground);
    expect(w.z).toBeGreaterThan(110);
    expect(w.x).toBeGreaterThan(100);
  });

  test('threads a lane a metre wide, coming at it off centre', () => {
    // Two houses with a one-cell lane between them, from z = 45 to 46.
    const ground = town(rect(40, 30, 60, 45), rect(40, 46, 60, 60));
    const w = createWalker(30, 45.8, Math.PI / 2);
    run(w, 12, [1, 0], ground);
    expect(w.x).toBeGreaterThan(62);
  });
});
describe('routes', () => {
  test('walks every leg and comes to a stop on the last point', () => {
    const w = createWalker(0, 0);
    followRoute(w, Float32Array.of(0, 0, 10, 0, 10, 10));
    run(w, 20);
    expect(w.x).toBeCloseTo(10, 2);
    // Coasting to a stop takes it a few centimetres on, no more.
    expect(w.z).toBeGreaterThanOrEqual(10);
    expect(w.z).toBeLessThan(10.15);
    expect(w.route).toBeNull();
    expect(w.travelled).toBeCloseTo(20, 1);
    expect(w.heading).toBeCloseTo(0, 2);
  });

  test('skips waypoints it already stands on', () => {
    const w = createWalker(0, 0);
    followRoute(w, Float32Array.of(0, 0, 0, 0, 5, 0));
    stepWalker(w, 1 / 60, 0, 0, open);
    expect(w.next).toBe(2);
    expect(w.dirX).toBe(1);
  });

  test('a route to where it stands ends at once', () => {
    const w = createWalker(3, 4);
    followRoute(w, Float32Array.of(3, 4, 3, 4));
    stepWalker(w, 1 / 60, 0, 0, open);
    expect(w.route).toBeNull();
    expect([w.x, w.z]).toEqual([3, 4]);
  });

  test('steering takes over from a route', () => {
    const w = createWalker(0, 0);
    followRoute(w, Float32Array.of(0, 0, 10, 0));
    stepWalker(w, 1 / 60, 0, 1, open);
    expect(w.route).toBeNull();
    expect(w.z).toBeGreaterThan(0);
  });
});
