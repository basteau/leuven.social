import { describe, expect, test } from 'bun:test';

import {
  DROP,
  FALL,
  MARKER_INDICES,
  MARK,
  MARK_FROM,
  MARK_MIN,
  PUFF,
  PUFF_TO,
  SETTLE,
  SPAWN_FLIGHT,
  SPAWN_HOLD,
  WAVE,
  bodyStretch,
  fallHeight,
  markerDrop,
  markerRadius,
  puff,
  settling,
  spawnMarker,
  wave,
} from './spawn.ts';

const range = (from: number, to: number, step: number) =>
  Array.from({ length: Math.round((to - from) / step) + 1 }, (_, i) => from + i * step);

describe('the spawn', () => {
  test('is over in under two seconds, tap to settled', () => {
    expect(SPAWN_HOLD + SPAWN_FLIGHT + SETTLE).toBeLessThan(2);
    expect(FALL).toBeLessThan(SPAWN_FLIGHT / 2);
  });

  test('drops the marker onto the spot, overshooting once, then holds it', () => {
    expect(markerDrop(-1)).toBe(MARK_FROM);
    expect(markerDrop(0)).toBeCloseTo(MARK_FROM);
    expect(markerDrop(MARK)).toBe(1);
    expect(markerDrop(5)).toBe(1);
    const sizes = range(0, MARK, MARK / 40).map(markerDrop);
    expect(Math.min(...sizes)).toBeLessThan(0.95);
    expect(Math.min(...sizes)).toBeGreaterThan(0.8);
  });

  test('keeps the marker one size on screen, but never smaller than a step', () => {
    expect(markerRadius(560)).toBeCloseTo(17.9, 1);
    expect(markerRadius(56)).toBeCloseTo(1.79, 2);
    expect(markerRadius(4)).toBe(MARK_MIN);
  });

  test('drops the walker in faster and faster, out of sight before its fall', () => {
    expect(fallHeight(FALL + 0.01)).toBe(Infinity);
    expect(fallHeight(FALL)).toBeCloseTo(DROP);
    expect(fallHeight(0)).toBe(0);
    expect(fallHeight(-1)).toBe(0);
    const early = fallHeight(FALL) - fallHeight(FALL * 0.9);
    const late = fallHeight(FALL * 0.1) - fallHeight(0);
    expect(late).toBeLessThan(early);
  });

  test('stretches falling, squashes landing, and settles back to its own height', () => {
    expect(bodyStretch(-FALL)).toBeCloseTo(1);
    expect(bodyStretch(-0.0001)).toBeCloseTo(1.16, 2);
    expect(bodyStretch(0)).toBeCloseTo(0.7);
    const after = range(0, 1, 0.01).map(bodyStretch);
    expect(Math.max(...after.slice(5))).toBeGreaterThan(1); // springs up past its height
    expect(bodyStretch(1)).toBe(1);
    expect(Math.abs(bodyStretch(0.5) - 1)).toBeLessThan(0.02);
  });

  test('settles from just landed to standing', () => {
    expect(settling(-0.1)).toBe(0);
    expect(settling(0)).toBe(1);
    expect(settling(0.5)).toBeLessThan(0.02);
  });

  test('puffs dust outward, thinning until it is gone', () => {
    expect(puff(-0.1)).toBeNull();
    expect(puff(Number.NaN)).toBeNull();
    expect(puff(PUFF)).toBeNull();
    expect(puff(0)).toEqual([1, 1]);
    const [spread, left] = puff(PUFF * 0.9)!;
    expect(spread).toBeGreaterThan(2);
    expect(spread).toBeLessThanOrEqual(PUFF_TO);
    expect(left).toBeLessThan(0.25);
  });

  test('waves leaving: the arm up in front, the forearm going, then down again', () => {
    expect(wave(-0.1)).toBeNull();
    expect(wave(Number.NaN)).toBeNull();
    expect(wave(WAVE)).toBeNull();
    expect(wave(0)).toEqual([-0, -0]);
    const elbows = range(0.2, 0.6, 0.02).map((t) => wave(t)![1]);
    expect(Math.max(...elbows) - Math.min(...elbows)).toBeGreaterThan(0.6);
    expect(wave(0.4)![0]).toBeCloseTo(-2.7);
    expect(Math.abs(wave(WAVE - 0.01)![0])).toBeLessThan(0.1);
  });
});

describe('the spawn marker', () => {
  const geometry = spawnMarker();
  const position = geometry.getAttribute('position');

  test('is the target first and the puffs after it', () => {
    // Seven hexagons of dust, four triangles each.
    expect(geometry.index!.count).toBe(MARKER_INDICES + 7 * 4 * 3);
  });

  test('lies flat, inside radius 1, puffs reaching just past it', () => {
    let far = 0;
    for (let i = 0; i < position.count; i++) {
      expect(position.getY(i)).toBe(0);
      far = Math.max(far, Math.hypot(position.getX(i), position.getZ(i)));
    }
    expect(far).toBeGreaterThan(1);
    expect(far).toBeLessThan(1.25);
  });

  test('faces up, so it shows from above', () => {
    const index = geometry.index!;
    for (let i = 0; i < index.count; i += 3) {
      const [a, b, c] = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
      const [ux, uz] = [position.getX(b) - position.getX(a), position.getZ(b) - position.getZ(a)];
      const [vx, vz] = [position.getX(c) - position.getX(a), position.getZ(c) - position.getZ(a)];
      // The y of (b - a) × (c - a): positive faces up.
      expect(uz * vx - ux * vz).toBeGreaterThan(0);
    }
  });
});
