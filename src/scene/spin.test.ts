import { describe, expect, test } from 'bun:test';

import {
  COAST_EASE,
  COAST_MAX,
  COAST_MIN,
  NUDGE,
  SPIN_EASE,
  SPIN_RATE,
  coastSpin,
  newSpin,
  pressSpin,
  spinStep,
  spinning,
  stopSpin,
} from './spin.ts';
import type { Spin } from './spin.ts';

const DT = 1 / 60;

/** Runs a spin until it has stopped, and returns where, the steps' speeds beside it. */
function settle(spin: Spin, from: number, dt = DT, ease?: number) {
  let yaw = from;
  const rates: number[] = [];
  for (let i = 0; i < 2000 && spinning(spin); i++) {
    yaw = spinStep(spin, yaw, dt, ease);
    rates.push(spin.rate);
  }
  expect(spinning(spin)).toBe(false);
  return { yaw, rates };
}

/** Holds for `steps` frames from `from`, and returns the yaw. */
function hold(spin: Spin, from: number, steps: number) {
  let yaw = from;
  for (let i = 0; i < steps; i++) yaw = spinStep(spin, yaw, DT);
  return yaw;
}

describe('spin', () => {
  test('at rest it does nothing', () => {
    const spin = newSpin();
    expect(spinning(spin)).toBe(false);
    expect(spinStep(spin, 1.25, DT)).toBe(1.25);
  });

  test('held, it gets up to speed at once and keeps a steady rate', () => {
    const spin = newSpin();
    pressSpin(spin, 0, 1);
    const first = spinStep(spin, 0, DT);
    expect(first).toBeGreaterThan(0);
    expect(spin.rate).toBeCloseTo(SPIN_EASE * DT, 6);
    hold(spin, first, 30);
    expect(spin.rate).toBeCloseTo(SPIN_RATE, 6);
  });

  test('a press and release before any frame still turns it the nudge', () => {
    const spin = newSpin();
    pressSpin(spin, 0.3, -1);
    spin.held = 0;
    expect(settle(spin, 0.3).yaw).toBeCloseTo(0.3 - NUDGE, 6);
  });

  test('a tap turns the nudge and no more, without ever going back', () => {
    const spin = newSpin();
    pressSpin(spin, 0, 1);
    const yaw = hold(spin, 0, 4);
    spin.held = 0;
    const { yaw: end, rates } = settle(spin, yaw);
    expect(end).toBeCloseTo(NUDGE, 6);
    expect(rates.every((rate) => rate >= 0)).toBe(true);
  });

  test('held longer, let go, it stops a brake past where it was, at any angle', () => {
    const spin = newSpin();
    pressSpin(spin, 0, 1);
    const yaw = hold(spin, 0, 60);
    spin.held = 0;
    const { yaw: end } = settle(spin, yaw);
    // A second at full speed, past the nudge, and the brake's own short way.
    expect(end).toBeCloseTo(yaw + SPIN_RATE ** 2 / (2 * SPIN_EASE), 1);
    expect(end).toBeGreaterThan(NUDGE);
    expect(Math.abs(end / (Math.PI / 2) - Math.round(end / (Math.PI / 2)))).toBeGreaterThan(0.01);
  });

  test('its speed changes by no more than the ease allows, even at a slow frame rate', () => {
    const spin = newSpin();
    pressSpin(spin, 0, -1);
    const dt = 1 / 30;
    let [yaw, was] = [0, 0];
    for (let i = 0; i < 40; i++) {
      yaw = spinStep(spin, yaw, dt);
      expect(Math.abs(spin.rate - was)).toBeLessThanOrEqual(SPIN_EASE * dt + 1e-9);
      was = spin.rate;
    }
    spin.held = 0;
    expect(settle(spin, yaw, dt).rates.at(-1)).toBe(0);
  });

  test('taps in a row add up, and it never stops in between', () => {
    const spin = newSpin();
    pressSpin(spin, 0, 1);
    spin.held = 0;
    const yaw = hold(spin, 0, 8);
    pressSpin(spin, yaw, 1);
    spin.held = 0;
    expect(spin.rate).toBeGreaterThan(0);
    expect(settle(spin, yaw).yaw).toBeCloseTo(2 * NUDGE, 6);
  });

  test('a press while the last press is still held bound adds to it too', () => {
    const spin = newSpin();
    pressSpin(spin, 0, 1);
    const yaw = hold(spin, 0, 2);
    pressSpin(spin, yaw, 1); // its `least`, not yet its `to`
    expect(spin.least).toBeCloseTo(2 * NUDGE, 6);
  });

  test('a tap the other way turns it round smoothly and goes its nudge', () => {
    const spin = newSpin();
    pressSpin(spin, 0, 1);
    let yaw = hold(spin, 0, 40);
    pressSpin(spin, yaw, -1);
    spin.held = 0; // let go at once: it's still going the first way
    const start = yaw;
    const { yaw: end, rates } = settle(spin, yaw);
    yaw = end;
    expect(rates.some((rate) => rate < 0)).toBe(true);
    expect(yaw).toBeCloseTo(start - NUDGE, 6);
  });

  test('a flick glides on and dies away by itself', () => {
    const spin = newSpin();
    expect(coastSpin(spin, 3)).toBe(true);
    expect(spin.ease).toBe(COAST_EASE);
    const { yaw, rates } = settle(spin, 1);
    expect(yaw).toBeCloseTo(1 + 3 ** 2 / (2 * COAST_EASE), 1);
    expect(rates.at(-1)).toBe(0);
  });

  test('a slow lift just stops, and a wild flick is capped', () => {
    const spin = newSpin();
    expect(coastSpin(spin, COAST_MIN - 0.01)).toBe(false);
    expect(spinning(spin)).toBe(false);
    expect(coastSpin(spin, -100)).toBe(true);
    expect(spin.rate).toBe(-COAST_MAX);
  });

  test('let go too close to brake within the frame, it still lands on its end', () => {
    const spin = newSpin();
    pressSpin(spin, 0, 1);
    const yaw = hold(spin, 0, 20);
    spin.held = 0;
    expect(settle(spin, yaw, 1 / 10).rates.at(-1)).toBe(0);
  });

  test('stopSpin takes it to rest at once', () => {
    const spin = newSpin();
    pressSpin(spin, 0, 1);
    spinStep(spin, 0, DT);
    stopSpin(spin);
    expect(spinning(spin)).toBe(false);
    expect(spin.rate).toBe(0);
  });

  test('with reduced motion a held turn has no easing in or out', () => {
    const spin = newSpin();
    pressSpin(spin, 0, 1);
    spin.least = Number.NaN; // the viewer steps the nudge at once
    const yaw = spinStep(spin, 0, DT, 1e9);
    expect(spin.rate).toBe(SPIN_RATE);
    spin.held = 0;
    const end = settle(spin, yaw, DT, 1e9);
    expect(end.yaw).toBeCloseTo(yaw, 6);
    expect(end.rates).toEqual([0]);
  });
});
