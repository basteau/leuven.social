import { describe, expect, test } from 'bun:test';

import { quarterAhead, SPIN_EASE, SPIN_RATE, spinStep } from './spin.ts';
import type { Spin } from './spin.ts';

const QUARTER = Math.PI / 2;
const VIEW = Math.PI / 4; // the map's first quarter view
const FRAME = 1 / 60;

const spin = (held: number): Spin => ({ held, rate: 0, to: Number.NaN });

/** Holds for `seconds`, lets go and runs until it rests: every yaw on the way. */
function hold(seconds: number, held = 1, ease = SPIN_EASE, from = VIEW): number[] {
  const state = spin(held);
  const path = [from];
  for (let t = 0; t < seconds; t += FRAME) path.push(spinStep(state, path.at(-1)!, FRAME, ease));
  state.held = 0;
  for (let frames = 0; state.rate && frames < 600; frames++) {
    path.push(spinStep(state, path.at(-1)!, FRAME, ease));
  }
  expect(state.rate).toBe(0);
  return path;
}

describe('quarterAhead', () => {
  test('finds the next quarter view either way', () => {
    expect(quarterAhead(VIEW + 0.1, 1)).toBeCloseTo(VIEW + QUARTER);
    expect(quarterAhead(VIEW + 0.1, -1)).toBeCloseTo(VIEW);
    expect(quarterAhead(VIEW - 0.1, -1)).toBeCloseTo(VIEW - QUARTER);
  });

  test('stays on a quarter view it is already at', () => {
    expect(quarterAhead(VIEW, 1)).toBeCloseTo(VIEW);
    expect(quarterAhead(VIEW + 3 * QUARTER, -1)).toBeCloseTo(VIEW + 3 * QUARTER);
  });
});

describe('spinStep', () => {
  test('rests while nothing is held and nothing is moving', () => {
    expect(spinStep(spin(0), 1.23, FRAME)).toBe(1.23);
  });

  test('gathers speed, then keeps turning at the held rate', () => {
    const state = spin(1);
    let yaw = VIEW;
    yaw = spinStep(state, yaw, FRAME);
    expect(state.rate).toBeCloseTo(SPIN_EASE * FRAME);
    for (let t = 0; t < 1; t += FRAME) yaw = spinStep(state, yaw, FRAME);
    expect(state.rate).toBe(SPIN_RATE);
    expect(yaw - VIEW).toBeGreaterThan(0.75 * SPIN_RATE);
  });

  test('let go, it settles on a quarter view ahead, never going back', () => {
    for (const seconds of [0.05, 0.3, 0.55, 0.8, 1, 1.7]) {
      for (const held of [1, -1]) {
        const path = hold(seconds, held);
        const end = path.at(-1)!;
        expect(Math.abs(Math.round((end - VIEW) / QUARTER) * QUARTER - (end - VIEW))).toBeLessThan(
          1e-9,
        );
        for (let i = 1; i < path.length; i++)
          expect((path[i]! - path[i - 1]!) * held).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test('turns on past a quarter view it is too close to stop at', () => {
    // At full speed, the turn is 0.05 rad short of a quarter view when let go.
    const state: Spin = { held: 0, rate: SPIN_RATE, to: Number.NaN };
    let yaw = VIEW + QUARTER - 0.05;
    do yaw = spinStep(state, yaw, FRAME);
    while (state.rate);
    expect(yaw).toBeCloseTo(VIEW + 2 * QUARTER);
  });

  test('slows down smoothly: no jolt between frames', () => {
    const path = hold(1);
    const speeds = path.slice(1).map((yaw, i) => (yaw - path[i]!) / FRAME);
    for (let i = 1; i < speeds.length - 1; i++) {
      expect(Math.abs(speeds[i]! - speeds[i - 1]!)).toBeLessThan(2.5 * SPIN_EASE * FRAME);
    }
  });

  test('with reduced motion it turns at once and stops on the quarter view', () => {
    const path = hold(0.3, 1, 1e9);
    expect((path[1]! - path[0]!) / FRAME).toBeCloseTo(SPIN_RATE);
    expect(path.at(-1)).toBeCloseTo(VIEW + QUARTER);
  });
});
