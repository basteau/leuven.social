import { expect, test } from 'bun:test';
import type { BufferAttribute, InterleavedBufferAttribute } from 'three';

import { unindexed } from './mesh-builder.ts';
import { DOT_VERTICES, passedVertices, routeMarker } from './route-marker.ts';

/** The target: a ring of 16 quads and a centre dot. */
const TARGET_VERTICES = 16 * 6 + DOT_VERTICES;

/** The middle and width of `count` vertices from `start`, seen from above. */
function bounds(
  position: BufferAttribute | InterleavedBufferAttribute,
  start: number,
  count: number,
) {
  const xs: number[] = [];
  const zs: number[] = [];
  for (let i = start; i < start + count; i++) {
    xs.push(position.getX(i));
    zs.push(position.getZ(i));
  }
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  return { x: (x0 + x1) / 2, z: (Math.min(...zs) + Math.max(...zs)) / 2, size: x1 - x0 };
}

test('dots run along every leg, clear of both ends, then the target', () => {
  const marker = routeMarker(Float32Array.of(0, 0, 10, 0, 10, 10));
  const dots = Array.from(marker.dots);
  expect(dots[0]).toBeCloseTo(1.4);
  expect(dots.at(-1)!).toBeLessThanOrEqual(20 - 1.4);
  expect(dots.length).toBe(10);
  const position = unindexed(marker.geometry).getAttribute('position');
  expect(position.count).toBe(dots.length * DOT_VERTICES + TARGET_VERTICES);
  // A dot on the second leg lies on it, and dots shrink toward the end.
  const onSecond = dots.findIndex((d) => d > 12);
  const first = bounds(position, 0, DOT_VERTICES);
  const second = bounds(position, onSecond * DOT_VERTICES, DOT_VERTICES);
  expect(second.x).toBeCloseTo(10);
  expect(second.size).toBeLessThan(first.size);
  // The target is the last thing drawn, centred on the end.
  const target = bounds(position, position.count - TARGET_VERTICES, TARGET_VERTICES);
  expect([target.x, target.z]).toEqual([expect.closeTo(10), expect.closeTo(10)]);
  expect(target.size).toBeCloseTo(1.5, 1);
});

test('a short walk has a target and no dots', () => {
  const marker = routeMarker(Float32Array.of(0, 0, 2, 0));
  expect(marker.dots).toHaveLength(0);
  expect(unindexed(marker.geometry).getAttribute('position').count).toBe(TARGET_VERTICES);
});

test('dots drop off as the walker passes them', () => {
  const marker = routeMarker(Float32Array.of(0, 0, 20, 0));
  expect(passedVertices(marker, 0)).toBe(0);
  expect(passedVertices(marker, 1.2)).toBe(DOT_VERTICES);
  expect(passedVertices(marker, 100)).toBe(marker.dots.length * DOT_VERTICES);
});

const tilted = (x: number, z: number) => 0.2 * x - 0.1 * z;

test('on a slope, every dot and the ring lie on the ground', () => {
  const marker = routeMarker(Float32Array.of(0, 0, 10, 0, 10, 10), tilted);
  const position = unindexed(marker.geometry).getAttribute('position');
  for (let i = 0; i < position.count; i++) {
    expect(position.getY(i) - tilted(position.getX(i), position.getZ(i))).toBeCloseTo(0.23);
  }
  expect(position.count).toBe(marker.dots.length * DOT_VERTICES + TARGET_VERTICES);
});
