import { describe, expect, test } from 'bun:test';

import { IDLE_SECONDS, WALK_SPEED, createWalker, followRoute, stepWalker } from './walker.ts';

const open = () => true;
/** Open ground everywhere except x > 10. */
const wall = (x: number) => x <= 10;

/** Steps at 60 fps until it settles or `seconds` pass; returns the frames it took. */
function run(
  w: ReturnType<typeof createWalker>,
  seconds: number,
  steer: [number, number] = [0, 0],
  walkable: (x: number, z: number) => boolean = open,
): number {
  for (let frame = 1; frame <= seconds * 60; frame++) {
    if (!stepWalker(w, 1 / 60, steer[0], steer[1], walkable)) return frame;
  }
  return Infinity;
}

describe('steering', () => {
  test('eases up to walking pace in the steered direction and turns to face it', () => {
    const w = createWalker(0, 0);
    stepWalker(w, 1 / 60, 1, 0, open);
    expect(w.speed).toBeGreaterThan(0);
    expect(w.speed).toBeLessThan(WALK_SPEED);
    run(w, 1, [1, 0]);
    expect(w.speed).toBeCloseTo(WALK_SPEED);
    expect(w.x).toBeGreaterThan(3);
    expect(w.z).toBeCloseTo(0);
    expect(w.heading).toBeCloseTo(Math.PI / 2, 2);
    expect(w.phase).toBeGreaterThan(0);
  });

  test('a half-pressed stick walks slower', () => {
    const w = createWalker(0, 0);
    run(w, 1, [0, 0.5]);
    expect(w.speed).toBeCloseTo(WALK_SPEED / 2);
  });

  test('slides along a wall it walks into at an angle, and stops at one it faces', () => {
    const w = createWalker(9.5, 0);
    run(w, 1, [1, 1], wall);
    expect(w.x).toBeLessThanOrEqual(10);
    expect(w.z).toBeGreaterThan(2);

    const head = createWalker(9.5, 0);
    run(head, 1, [1, 0], wall);
    expect(head.x).toBeLessThanOrEqual(10);
    expect(head.speed).toBe(0);
  });

  test('slides the other way along a wall across its path', () => {
    const w = createWalker(0, 9.5);
    run(w, 1, [1, 1], (_x: number, z: number) => z <= 10);
    expect(w.z).toBeLessThanOrEqual(10);
    expect(w.x).toBeGreaterThan(2);
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
  test('walks every leg and stops exactly on the last point', () => {
    const w = createWalker(0, 0);
    followRoute(w, Float32Array.of(0, 0, 10, 0, 10, 10));
    run(w, 10);
    expect(w.x).toBeCloseTo(10, 5);
    expect(w.z).toBeCloseTo(10, 5);
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
    stepWalker(w, 1 / 60, 0, -1, open);
    expect(w.route).toBeNull();
    expect(w.z).toBeLessThan(0);
  });
});
