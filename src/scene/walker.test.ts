import { describe, expect, test } from 'bun:test';

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

const open = () => true;
/** Open ground everywhere except x > 10. */
const wall = (x: number) => x <= 10;
/** Open ground below the line x + z = 10. */
const slanted = (x: number, z: number) => x + z <= 10;

/** Steps at 60 fps until it settles or `seconds` pass; returns the frames it took. */
function run(
  w: ReturnType<typeof createWalker>,
  seconds: number,
  steer: [number, number] = [0, 0],
  walkable: (x: number, z: number) => boolean = open,
  running = false,
): number {
  for (let frame = 1; frame <= seconds * 60; frame++) {
    if (!stepWalker(w, 1 / 60, steer[0], steer[1], walkable, running)) return frame;
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

  test('slides along a wall it walks into at an angle, and stops at one it faces', () => {
    const w = createWalker(9.5, 0);
    run(w, 2, [1, 1], wall);
    expect(w.x).toBeLessThanOrEqual(10);
    expect(w.z).toBeGreaterThan(1.5);

    const head = createWalker(9.5, 0, Math.PI / 2);
    run(head, 1, [1, 0], wall);
    expect(head.x).toBeLessThanOrEqual(10);
    expect(head.speed).toBe(0);
  });

  test('slides along a slanted wall it walks into', () => {
    // Walking +x it turns aside along the wall, slower.
    const w = createWalker(9, 0, Math.PI / 2);
    run(w, 2, [1, 0], slanted);
    expect(w.x + w.z).toBeLessThanOrEqual(10);
    expect(w.z).toBeLessThan(-1);
    expect(w.slide).toBeGreaterThan(0);
    expect(w.slide).toBeLessThan(1);
  });

  test('slides the other way along a wall across its path', () => {
    const w = createWalker(0, 9.5);
    run(w, 2, [1, 1], (_x: number, z: number) => z <= 10);
    expect(w.z).toBeLessThanOrEqual(10);
    expect(w.x).toBeGreaterThan(1.5);
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
