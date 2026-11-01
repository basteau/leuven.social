import { describe, expect, test } from 'bun:test';

import { clock, decay, decayAngle, spring, springTo, springToAngle, ticks } from './motion.ts';

/** Runs `update` for one second at `hz` frames a second. */
function second(hz: number, update: (dt: number) => void): void {
  for (let i = 0; i < hz; i++) update(1 / hz);
}

describe('decay', () => {
  test('halves the gap every half-life, at any frame rate', () => {
    expect(decay(0, 8, 0.5, 0.5)).toBeCloseTo(4);
    for (const hz of [30, 60, 120, 144]) {
      let x = 0;
      second(hz, (dt) => (x = decay(x, 8, 0.25, dt)));
      expect(x).toBeCloseTo(8 - 8 / 16, 6);
    }
    expect(decay(3, 8, 0, 1 / 60)).toBe(8);
  });

  test('turns an angle the short way round', () => {
    const a = decayAngle(Math.PI - 0.1, -Math.PI + 0.1, 0.1, 0.1);
    expect(Math.abs(a)).toBeCloseTo(Math.PI, 6);
  });
});

describe('springs', () => {
  test('set off gently, settle without overshooting, at any frame rate', () => {
    const ends: number[] = [];
    for (const hz of [30, 60, 120, 144]) {
      const first = spring(0);
      springTo(first, 1, 0.2, 1 / hz);
      // The first frame barely moves: speed builds up, it doesn't jump.
      expect(first.x).toBeLessThan(0.05);
      const s = spring(0);
      let peak = 0;
      second(hz, (dt) => {
        springTo(s, 1, 0.2, dt);
        peak = Math.max(peak, s.x);
      });
      expect(peak).toBeLessThanOrEqual(1);
      ends.push(s.x);
    }
    for (const end of ends) expect(end).toBeCloseTo(ends[0]!, 9);
    expect(ends[0]).toBeGreaterThan(0.95);
  });

  test('follow a goal moving steadily at its speed, a fixed distance behind', () => {
    const s = spring(0);
    let goal = 0;
    second(60, (dt) => springTo(s, (goal += 2 * dt), 0.1, dt));
    expect(s.v).toBeCloseTo(2, 1);
    expect(goal - s.x).toBeCloseTo((2 * 0.1) / Math.LN2, 1);
  });

  test('a zero half-life snaps to the goal', () => {
    const s = spring(0);
    s.v = 5;
    springTo(s, 3, 0, 1 / 60);
    expect(s).toEqual({ x: 3, v: 0 });
  });

  test('turn an angle the short way round and stay wrapped', () => {
    const s = spring(Math.PI - 0.1);
    second(60, (dt) => springToAngle(s, -Math.PI + 0.1, 0.1, dt));
    expect(Math.abs(s.x)).toBeCloseTo(Math.PI - 0.1, 3);
    expect(s.x).toBeLessThan(0);
  });
});

describe('the fixed-step clock', () => {
  test('runs whole steps and keeps the rest for blending', () => {
    const c = clock(1 / 120);
    expect(ticks(c, 1 / 60)).toBe(2);
    expect(c.left).toBeCloseTo(0, 9);
    expect(ticks(c, 1 / 240)).toBe(0);
    expect(c.left / c.step).toBeCloseTo(0.5);
    let steps = 0;
    second(30, (dt) => (steps += ticks(c, dt)));
    expect(steps).toBe(120);
  });

  test('a stalled tab runs a few steps, not the whole gap', () => {
    const c = clock(1 / 120);
    expect(ticks(c, 5)).toBe(8);
    expect(c.left).toBeLessThan(c.step);
  });
});
