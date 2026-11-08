import { describe, expect, test } from 'bun:test';

import { SCALES, WINDOW_MS, createScaler, pixelRatio } from './resolution.ts';

type Scaler = ReturnType<typeof createScaler>;

/** Runs frames `ms` apart for `duration` from `from`, returning when each change came and the end. */
function run(scaler: Scaler, from: number, ms: number, duration: number) {
  const changes: number[] = [];
  let now = from;
  while (now < from + duration) {
    now += ms;
    if (scaler.frame(now)) changes.push(now);
  }
  return { changes, end: now };
}

/** Frames whose cost goes with the pixels drawn, `ms` at full size: a GPU-bound load. */
function gpuBound(scaler: Scaler, from: number, ms: number, duration: number) {
  let now = from;
  while (now < from + duration) {
    now += ms * scaler.scale ** 2;
    scaler.frame(now);
  }
  return now;
}

describe('createScaler', () => {
  test('stays at full resolution while frames keep up', () => {
    const scaler = createScaler();
    const { changes } = run(scaler, 0, 16.7, 30_000);
    expect(changes).toEqual([]);
    expect(scaler.scale).toBe(1);
  });

  test('steps down at most once per window, and only as far as it helps', () => {
    const scaler = createScaler();
    let now = 0;
    const steps: number[] = [];
    // A GPU-bound frame: its cost goes with the pixels drawn.
    while (now < 20_000) {
      now += 28 * scaler.scale ** 2;
      if (scaler.frame(now)) steps.push(now);
    }
    expect(steps.length).toBeGreaterThan(0);
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i]! - steps[i - 1]!).toBeGreaterThanOrEqual(WINDOW_MS);
    }
    expect(scaler.scale).toBeLessThan(1);
    expect(scaler.scale).toBeGreaterThanOrEqual(SCALES.at(-1)!);
  });

  test('takes a step back when it bought nothing, and leaves it alone for longer each time', () => {
    const scaler = createScaler();
    // A CPU-bound frame, or a phone capped at 30 fps: fewer pixels change nothing.
    const { changes } = run(scaler, 0, 33.4, 60_000);
    expect(scaler.scale).toBe(1);
    // A step down and its way back, again and again, ever further apart: no flapping.
    expect(changes.length % 2).toBe(0);
    const tries = changes.filter((_, i) => i % 2 === 0);
    expect(tries.length).toBeGreaterThan(1);
    expect(tries.length).toBeLessThan(8);
    for (let i = 2; i < tries.length; i++) {
      expect(tries[i]! - tries[i - 1]!).toBeGreaterThan(tries[i - 1]! - tries[i - 2]!);
    }
  });

  test('recovers once frames have run fast for a while', () => {
    const scaler = createScaler();
    const heavy = gpuBound(scaler, 0, 40, 1500);
    expect(scaler.scale).toBeLessThan(1);
    // Gained from it, so it holds, then the load goes away.
    run(scaler, heavy, 14, 20_000);
    expect(scaler.scale).toBe(1);
  });

  test('a step up that makes it slow again is undone', () => {
    const scaler = createScaler();
    // Frames are fast at 0.85 and slow at full size.
    let now = 0;
    let changes = 0;
    while (now < 60_000) {
      now += scaler.scale === 1 ? 25 : 14;
      if (scaler.frame(now)) changes++;
    }
    expect(scaler.scale).toBe(SCALES[1]);
    // Each attempt waits longer than the last.
    expect(changes).toBeLessThan(16);
  });

  test('a gap is a pause, not a slow frame', () => {
    const scaler = createScaler();
    let now = 0;
    for (let i = 0; i < 40; i++) {
      now += i % 10 === 0 ? 1000 : 16.7;
      expect(scaler.frame(now)).toBe(false);
    }
    expect(scaler.scale).toBe(1);
  });

  test('stays at the smallest scale while still slow', () => {
    const scaler = createScaler();
    // Each smaller scale helps, but it is never enough.
    gpuBound(scaler, 0, 90, 30_000);
    expect(scaler.scale).toBe(SCALES.at(-1)!);
  });

  test('resets to full resolution', () => {
    const scaler = createScaler();
    gpuBound(scaler, 0, 40, 1500);
    expect(scaler.scale).toBeLessThan(1);
    expect(scaler.reset()).toBe(true);
    expect(scaler.scale).toBe(1);
    expect(scaler.reset()).toBe(false);
  });
});

describe('pixelRatio', () => {
  test('caps the device at 2 and applies the scale', () => {
    expect(pixelRatio(1, 1)).toBe(1);
    expect(pixelRatio(3, 1)).toBe(2);
    expect(pixelRatio(3, 0.85)).toBeCloseTo(1.7);
  });

  test('never goes under half a pixel, and survives an unknown device', () => {
    expect(pixelRatio(1, 0.3)).toBe(0.5);
    expect(pixelRatio(0, 1)).toBe(1);
  });
});
