import { describe, expect, test } from 'bun:test';

import { BIKE_STRIDE } from './avatar.ts';
import { createGait, nearestOf, stepGait, together } from './crowd.ts';
import type { PlayerPose } from './crowd.ts';
import { STRIDE_WALK, WALK_SPEED } from './walker.ts';

const pose = (over: Partial<PlayerPose> = {}): PlayerPose => ({
  x: 0,
  z: 0,
  heading: 0,
  speed: 0,
  mode: 'foot',
  place: '',
  floor: 0,
  ...over,
});

describe('stepGait', () => {
  test('the legs swing a cycle a stride, as the walker’s do', () => {
    const g = createGait();
    // At walking pace, one stride takes STRIDE_WALK / WALK_SPEED seconds: a whole cycle.
    const seconds = STRIDE_WALK / WALK_SPEED;
    for (let i = 0; i < 100; i++) stepGait(g, pose({ speed: WALK_SPEED }), seconds / 100);
    expect(Math.min(g.phase, Math.PI * 2 - g.phase)).toBeCloseTo(0, 1);
    expect(g.still).toBe(0);
    // A bike pedals a turn a bike's stride.
    const b = createGait();
    stepGait(b, pose({ speed: BIKE_STRIDE, mode: 'bike' }), 0.25);
    expect(b.phase).toBeCloseTo(Math.PI / 2);
  });

  test('standing, the idle clock runs; a step forward stops it', () => {
    const g = createGait();
    stepGait(g, pose(), 0.5);
    stepGait(g, pose(), 0.5);
    expect(g.still).toBeCloseTo(1);
    stepGait(g, pose({ speed: 1 }), 0.1);
    expect(g.still).toBe(0);
    // No time, no change.
    stepGait(g, pose({ speed: 3, heading: 2 }), 0);
    expect(g.heading).toBe(0);
  });

  test('a turn eases in from the heading’s change, and a bike leans into it', () => {
    const g = createGait();
    // Turning left (heading growing) at a radian a second, riding.
    for (let i = 1; i <= 60; i++) {
      stepGait(g, pose({ heading: i / 60, speed: 8, mode: 'bike' }), 1 / 60);
    }
    expect(g.turning).toBeGreaterThan(0.9);
    expect(g.turning).toBeLessThan(1.05);
    // A left turn tips the bike to its left: a negative lean.
    expect(g.lean).toBeLessThan(0);
    expect(g.lean).toBeGreaterThanOrEqual((-16 * Math.PI) / 180);
    // Across ±π, the short way round.
    const w = createGait(Math.PI - 0.05);
    stepGait(w, pose({ heading: -Math.PI + 0.05 }), 1);
    expect(w.turning).toBeGreaterThan(0);
    expect(w.turning).toBeLessThan(0.1);
    // On foot, no lean.
    expect(w.lean).toBe(0);
  });
});

test('together: the street from anywhere, a room only from its floor', () => {
  expect(together(pose(), '', 0)).toBe(true);
  expect(together(pose({ place: 'kerk' }), '', 0)).toBe(false);
  expect(together(pose({ place: 'kerk', floor: 1 }), 'kerk', 1)).toBe(true);
  expect(together(pose({ place: 'kerk', floor: 0 }), 'kerk', 1)).toBe(false);
  // From inside a room, the street round it still shows, and those in it.
  expect(together(pose(), 'kerk', 1)).toBe(true);
  expect(together(pose({ floor: 2 }), '', 0)).toBe(true);
});

test('nearestOf: the few nearest, nearest first', () => {
  const points = [10, 0, 1, 0, 5, 0, -2, 0, 50, 50];
  const out: number[] = [];
  expect(nearestOf(points, 5, 0, 0, 3, out)).toEqual([1, 3, 2]);
  expect(nearestOf(points, 5, 0, 0, 10, out)).toEqual([1, 3, 2, 0, 4]);
  expect(nearestOf(points, 2, 0, 0, 1, out)).toEqual([1]);
  expect(nearestOf(points, 0, 0, 0, 3, out)).toEqual([]);
});
